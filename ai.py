"""
AI features for the expense tracker, powered by Claude.

- scan_receipt():      reads a photo or PDF of a receipt and returns the expense fields
- spending_insights(): turns aggregated spending numbers into plain-language insights

Both use Structured Outputs, so the answers always match a fixed JSON schema.
"""

import base64
import json
import os

MODEL = os.environ.get("CLAUDE_MODEL", "claude-opus-5-5")
FALLBACK_MODELS = {"claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"}

IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
MAX_IMAGE_BYTES = 5 * 1024 * 1024   # Claude API limit for one image
MAX_PDF_BYTES = 32 * 1024 * 1024


class AIError(RuntimeError):
    """A problem the user should see, such as an unreadable file."""


def _ask(client, system: str, content: list, schema: dict, max_tokens: int = 4000) -> dict:
    extra = {}
    if MODEL in FALLBACK_MODELS:
        extra = {"betas": ["server-side-fallback-2026-07-01"], "fallbacks": "default"}
    response = client.beta.messages.create(
        model=MODEL,
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": content}],
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": schema}},
        **extra,
    )
    if response.stop_reason == "refusal":
        raise AIError("The AI declined to process this request.")
    text = next(b.text for b in response.content if b.type == "text")
    return json.loads(text)


# ---------- Receipt scanning ----------

def receipt_schema(categories: list[str]) -> dict:
    return {
        "type": "object",
        "properties": {
            "is_receipt": {"type": "boolean"},
            "merchant": {"type": ["string", "null"]},
            "date": {"type": ["string", "null"]},
            "total": {"type": ["number", "null"]},
            "currency": {"type": ["string", "null"]},
            "category": {"type": "string", "enum": categories},
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {"name": {"type": "string"}, "price": {"type": ["number", "null"]}},
                    "required": ["name", "price"],
                    "additionalProperties": False,
                },
            },
            "notes": {"type": "string"},
        },
        "required": ["is_receipt", "merchant", "date", "total", "currency", "category", "items", "notes"],
        "additionalProperties": False,
    }


def file_block(data: bytes, media_type: str) -> dict:
    """Validate an uploaded receipt and return it as an image or document content block."""
    encoded = base64.standard_b64encode(data).decode("ascii")
    if media_type == "application/pdf" or data.startswith(b"%PDF"):
        if len(data) > MAX_PDF_BYTES:
            raise AIError("The PDF is too large (max 32 MB).")
        return {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": encoded}}
    if media_type not in IMAGE_TYPES:
        raise AIError("Upload a JPG, PNG, WebP or GIF photo, or a PDF.")
    if len(data) > MAX_IMAGE_BYTES:
        raise AIError("The image is too large (max 5 MB). Try a smaller photo.")
    return {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": encoded}}


def scan_receipt(client, data: bytes, media_type: str, categories: list[str]) -> dict:
    """Read a receipt and return the fields needed to create an expense."""
    result = _ask(
        client,
        system=(
            "You read receipts and invoices for an expense tracker. Return what is printed on the "
            "receipt. Never guess: use null when a value is not readable. "
            "merchant: the shop or company name. date: the purchase date as YYYY-MM-DD. "
            "total: the final amount paid, as a plain number. currency: the ISO code, e.g. EUR, BGN, USD. "
            "category: the best match from the allowed list. items: the purchased items with prices. "
            "notes: one short sentence about anything unclear, or an empty string. "
            "If the file is not a receipt or invoice, set is_receipt to false."
        ),
        content=[file_block(data, media_type), {"type": "text", "text": "Read this receipt."}],
        schema=receipt_schema(categories),
    )
    if not result["is_receipt"]:
        raise AIError("This doesn't look like a receipt. Try a clearer photo.")
    return result


# ---------- Spending insights ----------

INSIGHTS_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "insights": {"type": "array", "items": {"type": "string"}},
        "tips": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["summary", "insights", "tips"],
    "additionalProperties": False,
}


def spending_insights(client, stats: dict) -> dict:
    """Explain aggregated spending data in plain language. Only totals are sent, never raw rows."""
    return _ask(
        client,
        system=(
            "You are a friendly personal finance assistant. You get aggregated spending data in EUR. "
            "Write a one-sentence summary, 3-5 specific insights and 2-3 practical tips. "
            "Every insight must be based on the numbers given: mention amounts and percentages, compare "
            "this month with last month, and point out the biggest categories and changes. "
            "Note that the current month may not be over yet. Do not invent data. "
            "Keep each insight and tip to one or two short sentences."
        ),
        content=[{"type": "text", "text": json.dumps(stats, indent=2)}],
        schema=INSIGHTS_SCHEMA,
    )
