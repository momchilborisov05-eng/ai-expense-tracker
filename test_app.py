"""Tests for the REST API. Run with: python -m unittest test_app.py"""

import tempfile
import unittest
from pathlib import Path

from app import create_app


class ExpenseApiTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        app = create_app(Path(self.tmp.name) / "test.db")
        app.testing = True
        self.client = app.test_client()

    def tearDown(self):
        self.tmp.cleanup()

    def add(self, **overrides):
        data = {"description": "Lunch", "amount": "12.50", "category": "Food",
                "spent_on": "2026-10-01", **overrides}
        return self.client.post("/api/expenses", json=data)

    def test_add_and_list(self):
        response = self.add()
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.get_json()["amount"], 12.5)
        expenses = self.client.get("/api/expenses").get_json()
        self.assertEqual(len(expenses), 1)
        self.assertEqual(expenses[0]["description"], "Lunch")

    def test_validation_errors(self):
        self.assertEqual(self.add(description="  ").status_code, 400)
        self.assertEqual(self.add(amount="-5").status_code, 400)
        self.assertEqual(self.add(amount="abc").status_code, 400)
        self.assertEqual(self.add(category="Cars").status_code, 400)
        self.assertEqual(self.add(spent_on="01/10/2026").status_code, 400)
        self.assertEqual(self.client.get("/api/expenses").get_json(), [])

    def test_update_and_delete(self):
        expense_id = self.add().get_json()["id"]
        updated = self.client.put(f"/api/expenses/{expense_id}", json={
            "description": "Dinner", "amount": 30, "category": "Food", "spent_on": "2026-10-02"})
        self.assertEqual(updated.status_code, 200)
        self.assertEqual(self.client.get("/api/expenses").get_json()[0]["description"], "Dinner")

        self.assertEqual(self.client.delete(f"/api/expenses/{expense_id}").status_code, 204)
        self.assertEqual(self.client.delete(f"/api/expenses/{expense_id}").status_code, 404)

    def test_filter_and_stats(self):
        self.add(amount=10, category="Food")
        self.add(amount=20, category="Food")
        self.add(amount=5, category="Transport")
        food = self.client.get("/api/expenses?category=Food").get_json()
        self.assertEqual(len(food), 2)

        stats = self.client.get("/api/stats").get_json()
        self.assertEqual(stats["count"], 3)
        self.assertEqual(stats["total"], 35)
        self.assertEqual(stats["by_category"][0], {"category": "Food", "total": 30})


if __name__ == "__main__":
    unittest.main()
