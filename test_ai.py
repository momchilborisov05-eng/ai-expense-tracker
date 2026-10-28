"""Tests for the AI features. A fake Claude client is used, so they run offline.
Run with: python -m unittest test_app.py test_ai.py"""

import io
import json
import os
import tempfile
import unittest
from datetime import date
from pathlib import Path
from types import SimpleNamespace as NS

os.environ["ANTHROPIC_API_KEY"] = os.environ.get("ANTHROPIC_API_KEY") or "test-key"  # never used: the client is fake

import ai  # noqa: E402
from app import create_app  # noqa: E402

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 100


class FakeClaude:
    def __init__(self, answer):
        self.answer = answer
        self.requests = []
        self.beta = NS(messages=NS(create=self._create))

    def _create(self, **kwargs):
        self.requests.append(kwargs)
        return NS(stop_reason="end_turn", content=[NS(type="text", text=json.dumps(self.answer))])


RECEIPT = {
    "is_receipt": True, "merchant": "Green Market", "date": "2026-10-20", "total": 23.45,
    "currency": "EUR", "category": "Food", "items": [{"name": "Bread", "price": 1.2}], "notes": "",
}


class AiTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.fake = FakeClaude(RECEIPT)
        app = create_app(Path(self.tmp.name) / "test.db", ai_client_factory=lambda: self.fake)
        app.testing = True
        self.client = app.test_client()

    def tearDown(self):
        self.tmp.cleanup()

    def scan(self, data=PNG, name="receipt.png", mimetype="image/png"):
        return self.client.post("/api/receipts/scan", data={"receipt": (io.BytesIO(data), name, mimetype)},
                                content_type="multipart/form-data")

    def test_scan_receipt_returns_form_fields(self):
        response = self.scan()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["description"], "Green Market")
        self.assertEqual(response.get_json()["amount"], 23.45)
        self.assertEqual(response.get_json()["spent_on"], "2026-10-20")
        # The scan only suggests values; nothing is saved until the user clicks Add.
        self.assertEqual(self.client.get("/api/expenses").get_json(), [])

    def test_scan_sends_image_and_category_enum(self):
        self.scan()
        request = self.fake.requests[0]
        self.assertEqual(request["messages"][0]["content"][0]["type"], "image")
        schema = request["output_config"]["format"]["schema"]
        self.assertIn("Food", schema["properties"]["category"]["enum"])

    def test_scan_pdf_is_sent_as_document(self):
        self.scan(b"%PDF-1.4 test", "invoice.pdf", "application/pdf")
        self.assertEqual(self.fake.requests[0]["messages"][0]["content"][0]["type"], "document")

    def test_scan_rejects_other_files(self):
        response = self.scan(b"hello", "notes.txt", "text/plain")
        self.assertEqual(response.status_code, 400)

    def test_scan_not_a_receipt(self):
        self.fake.answer = {**RECEIPT, "is_receipt": False}
        self.assertEqual(self.scan().status_code, 400)

    def test_scan_invalid_date_is_dropped(self):
        self.fake.answer = {**RECEIPT, "date": "20.10.2026"}
        self.assertIsNone(self.scan().get_json()["spent_on"])

    def test_insights_need_data(self):
        self.assertEqual(self.client.post("/api/insights").status_code, 400)

    def test_insights_send_only_totals(self):
        self.client.post("/api/expenses", json={"description": "Secret dinner", "amount": 40,
                                                "category": "Food", "spent_on": date.today().isoformat()})
        self.fake.answer = {"summary": "S", "insights": ["I1"], "tips": ["T1"]}
        response = self.client.post("/api/insights")
        self.assertEqual(response.get_json()["insights"], ["I1"])
        sent = json.loads(self.fake.requests[0]["messages"][0]["content"][0]["text"])
        self.assertEqual(sent["this_month"]["by_category"], {"Food": 40})
        self.assertEqual(sent["top_expenses_last_90_days"][0]["total"], 40)


class FileBlockTest(unittest.TestCase):
    def test_too_large_image(self):
        with self.assertRaises(ai.AIError):
            ai.file_block(b"0" * (ai.MAX_IMAGE_BYTES + 1), "image/png")


if __name__ == "__main__":
    unittest.main()
