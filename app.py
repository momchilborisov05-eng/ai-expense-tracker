"""
AI Expense Tracker - Flask REST API + SQLite + JavaScript frontend + Claude AI.

AI features: scan a receipt photo to fill in an expense, and get plain-language
insights about your spending.

Run:
    python app.py            # starts on http://localhost:5000
    python app.py --demo     # fills the database with sample data first
"""

import argparse
import os
import random
import sqlite3
from contextlib import closing
from datetime import date, timedelta
from pathlib import Path

import anthropic
from dotenv import load_dotenv
from flask import Flask, g, jsonify, render_template, request

load_dotenv()

import ai  # noqa: E402  (reads CLAUDE_MODEL after .env is loaded)

CATEGORIES = ["Food", "Transport", "Housing", "Entertainment", "Health", "Shopping", "Other"]
DEFAULT_DB = Path(__file__).with_name("expenses.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS expenses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    description TEXT    NOT NULL,
    amount      REAL    NOT NULL CHECK (amount > 0),
    category    TEXT    NOT NULL,
    spent_on    TEXT    NOT NULL  -- ISO date, YYYY-MM-DD
);
CREATE INDEX IF NOT EXISTS idx_expenses_spent_on ON expenses (spent_on);
"""


def create_app(db_path: Path = DEFAULT_DB, ai_client_factory=anthropic.Anthropic) -> Flask:
    app = Flask(__name__)
    app.config["DB_PATH"] = str(db_path)
    app.config["MAX_CONTENT_LENGTH"] = ai.MAX_PDF_BYTES + 1024 * 1024
    ai_client = None

    def get_ai_client():
        nonlocal ai_client
        if ai_client is None:
            ai_client = ai_client_factory()
        return ai_client

    def ai_ready() -> bool:
        return bool(os.environ.get("ANTHROPIC_API_KEY"))

    def get_db() -> sqlite3.Connection:
        if "db" not in g:
            g.db = sqlite3.connect(app.config["DB_PATH"])
            g.db.row_factory = sqlite3.Row
        return g.db

    @app.teardown_appcontext
    def close_db(_exc):
        db = g.pop("db", None)
        if db is not None:
            db.close()

    with closing(sqlite3.connect(app.config["DB_PATH"])) as conn:
        conn.executescript(SCHEMA)

    def error(message: str, status: int = 400):
        return jsonify({"error": message}), status

    def validate(data: dict) -> tuple[dict | None, str | None]:
        """Check an expense from the client. Returns (clean_data, error_message)."""
        description = str(data.get("description", "")).strip()
        if not description:
            return None, "Description is required."
        if len(description) > 200:
            return None, "Description is too long (max 200 characters)."
        try:
            amount = round(float(data.get("amount")), 2)
        except (TypeError, ValueError):
            return None, "Amount must be a number."
        if amount <= 0:
            return None, "Amount must be greater than 0."
        category = data.get("category")
        if category not in CATEGORIES:
            return None, f"Category must be one of: {', '.join(CATEGORIES)}."
        try:
            spent_on = date.fromisoformat(str(data.get("spent_on"))).isoformat()
        except ValueError:
            return None, "Date must be in the format YYYY-MM-DD."
        return {"description": description, "amount": amount,
                "category": category, "spent_on": spent_on}, None

    @app.get("/")
    def index():
        return render_template("index.html", categories=CATEGORIES, ai_ready=ai_ready())

    @app.get("/api/expenses")
    def list_expenses():
        query = "SELECT * FROM expenses"
        params = []
        if category := request.args.get("category"):
            query += " WHERE category = ?"
            params.append(category)
        query += " ORDER BY spent_on DESC, id DESC LIMIT 200"
        rows = get_db().execute(query, params).fetchall()
        return jsonify([dict(r) for r in rows])

    @app.post("/api/expenses")
    def add_expense():
        clean, message = validate(request.get_json(silent=True) or {})
        if message:
            return error(message)
        db = get_db()
        cursor = db.execute(
            "INSERT INTO expenses (description, amount, category, spent_on) "
            "VALUES (:description, :amount, :category, :spent_on)",
            clean,
        )
        db.commit()
        return jsonify({"id": cursor.lastrowid, **clean}), 201

    @app.put("/api/expenses/<int:expense_id>")
    def update_expense(expense_id: int):
        clean, message = validate(request.get_json(silent=True) or {})
        if message:
            return error(message)
        db = get_db()
        cursor = db.execute(
            "UPDATE expenses SET description = :description, amount = :amount, "
            "category = :category, spent_on = :spent_on WHERE id = :id",
            {**clean, "id": expense_id},
        )
        db.commit()
        if cursor.rowcount == 0:
            return error("Expense not found.", 404)
        return jsonify({"id": expense_id, **clean})

    @app.delete("/api/expenses/<int:expense_id>")
    def delete_expense(expense_id: int):
        db = get_db()
        cursor = db.execute("DELETE FROM expenses WHERE id = ?", (expense_id,))
        db.commit()
        if cursor.rowcount == 0:
            return error("Expense not found.", 404)
        return "", 204

    @app.get("/api/stats")
    def stats():
        """Aggregated data for the dashboard cards and charts."""
        db = get_db()
        totals = db.execute(
            """SELECT COUNT(*) AS count,
                      COALESCE(SUM(amount), 0) AS total,
                      COALESCE(SUM(CASE WHEN strftime('%Y-%m', spent_on) = strftime('%Y-%m', 'now')
                                        THEN amount END), 0) AS this_month
               FROM expenses"""
        ).fetchone()
        by_category = db.execute(
            """SELECT category, ROUND(SUM(amount), 2) AS total
               FROM expenses GROUP BY category ORDER BY total DESC"""
        ).fetchall()
        by_month = db.execute(
            """SELECT strftime('%Y-%m', spent_on) AS month, ROUND(SUM(amount), 2) AS total
               FROM expenses
               WHERE spent_on >= date('now', 'start of month', '-11 months')
               GROUP BY month ORDER BY month"""
        ).fetchall()
        return jsonify({
            "count": totals["count"],
            "total": round(totals["total"], 2),
            "this_month": round(totals["this_month"], 2),
            "by_category": [dict(r) for r in by_category],
            "by_month": [dict(r) for r in by_month],
        })

    # ---------- AI features ----------

    def ai_error(e: Exception):
        if isinstance(e, ai.AIError):
            return error(str(e))
        if isinstance(e, anthropic.AuthenticationError):
            return error("Invalid API key. Check ANTHROPIC_API_KEY in your .env file.", 502)
        if isinstance(e, anthropic.RateLimitError):
            return error("Rate limit reached. Wait a minute and try again.", 429)
        if isinstance(e, anthropic.APIConnectionError):
            return error("Network error. Check your internet connection.", 502)
        if isinstance(e, anthropic.APIStatusError):
            return error(f"AI service error ({e.status_code}). Try again in a moment.", 502)
        raise e

    @app.post("/api/receipts/scan")
    def scan_receipt():
        """Read a receipt photo or PDF and return a suggested expense. Nothing is saved yet."""
        if not ai_ready():
            return error("AI features need an API key. Add ANTHROPIC_API_KEY to your .env file.")
        file = request.files.get("receipt")
        if not file or not file.filename:
            return error("Choose a receipt photo or PDF first.")
        try:
            data = ai.scan_receipt(get_ai_client(), file.read(), file.mimetype, CATEGORIES)
        except Exception as e:
            return ai_error(e)

        try:  # keep only a valid date; the user can always change it in the form
            spent_on = date.fromisoformat(data["date"]).isoformat() if data["date"] else None
        except ValueError:
            spent_on = None
        return jsonify({
            "description": (data["merchant"] or "Receipt")[:200],
            "amount": data["total"],
            "category": data["category"],
            "spent_on": spent_on,
            "currency": data["currency"],
            "items": data["items"],
            "notes": data["notes"],
        })

    def spending_summary() -> dict:
        """Aggregated numbers for the AI. No individual expenses are sent."""
        db = get_db()
        today = date.today()
        this_month = today.strftime("%Y-%m")
        last_month = (today.replace(day=1) - timedelta(days=1)).strftime("%Y-%m")

        def by_category(month: str) -> dict:
            rows = db.execute(
                "SELECT category, ROUND(SUM(amount), 2) AS total FROM expenses "
                "WHERE strftime('%Y-%m', spent_on) = ? GROUP BY category ORDER BY total DESC", (month,)
            ).fetchall()
            return {r["category"]: r["total"] for r in rows}

        months = db.execute(
            "SELECT strftime('%Y-%m', spent_on) AS month, ROUND(SUM(amount), 2) AS total, COUNT(*) AS count "
            "FROM expenses WHERE spent_on >= date('now', 'start of month', '-5 months') "
            "GROUP BY month ORDER BY month"
        ).fetchall()
        top = db.execute(
            "SELECT description, ROUND(SUM(amount), 2) AS total, COUNT(*) AS times FROM expenses "
            "WHERE spent_on >= date('now', '-90 days') GROUP BY description ORDER BY total DESC LIMIT 5"
        ).fetchall()
        return {
            "today": today.isoformat(),
            "days_passed_this_month": today.day,
            "this_month": {"month": this_month, "by_category": by_category(this_month)},
            "last_month": {"month": last_month, "by_category": by_category(last_month)},
            "monthly_totals_last_6_months": [dict(r) for r in months],
            "top_expenses_last_90_days": [dict(r) for r in top],
        }

    @app.post("/api/insights")
    def insights():
        if not ai_ready():
            return error("AI features need an API key. Add ANTHROPIC_API_KEY to your .env file.")
        summary = spending_summary()
        if not summary["monthly_totals_last_6_months"]:
            return error("Add some expenses first, then ask for insights.")
        try:
            return jsonify(ai.spending_insights(get_ai_client(), summary))
        except Exception as e:
            return ai_error(e)

    @app.errorhandler(413)
    def too_large(_e):
        return error("The file is too large.", 413)

    return app


def seed_demo_data(db_path: Path, count: int = 150) -> None:
    """Insert random sample expenses from the last 6 months."""
    samples = {
        "Food": ["Groceries", "Lunch", "Pizza", "Coffee", "Restaurant"],
        "Transport": ["Metro card", "Taxi", "Fuel", "Train ticket"],
        "Housing": ["Rent", "Electricity", "Internet", "Water"],
        "Entertainment": ["Cinema", "Concert", "Streaming subscription", "Video game"],
        "Health": ["Pharmacy", "Gym membership", "Dentist"],
        "Shopping": ["Clothes", "Headphones", "Books", "Shoes"],
        "Other": ["Gift", "Haircut", "Phone bill"],
    }
    ranges = {"Housing": (40, 450), "Shopping": (15, 180), "Health": (10, 90)}
    today = date.today()
    rows = []
    for _ in range(count):
        category = random.choice(CATEGORIES)
        low, high = ranges.get(category, (3, 60))
        rows.append((
            random.choice(samples[category]),
            round(random.uniform(low, high), 2),
            category,
            (today - timedelta(days=random.randint(0, 180))).isoformat(),
        ))
    with closing(sqlite3.connect(db_path)) as conn:
        conn.executescript(SCHEMA)
        conn.executemany(
            "INSERT INTO expenses (description, amount, category, spent_on) VALUES (?, ?, ?, ?)",
            rows,
        )
        conn.commit()
    print(f"Added {count} demo expenses.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--demo", action="store_true", help="add sample data before starting")
    parser.add_argument("--port", type=int, default=5000)
    args = parser.parse_args()
    # The debug reloader runs this file twice; seed only in the first (parent) process.
    if args.demo and not os.environ.get("WERKZEUG_RUN_MAIN"):
        seed_demo_data(DEFAULT_DB)
    create_app().run(debug=True, port=args.port)
