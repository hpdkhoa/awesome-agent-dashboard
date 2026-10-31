"""Removes secrets from text before it leaves the machine. The same patterns as scripts/check-secrets.mjs."""

import re

PATTERNS = [
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)"),
    re.compile(r"AIza[0-9A-Za-z_-]{35}"),
    re.compile(r"\b1//[0-9A-Za-z_-]{30,}"),
    re.compile(r"sk-ant-[0-9A-Za-z_-]{20,}"),
    re.compile(r"\bgh[pousr]_[0-9A-Za-z]{30,}"),
    re.compile(r"\b(?:eyJ[0-9A-Za-z_-]{10,}\.){2}[0-9A-Za-z_-]{10,}"),  # JWT
    re.compile(r"(?i)\b(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S+"),
]


def redact(text: str, limit: int) -> str:
    """Secrets replaced by [redacted], then cut to limit characters."""
    for p in PATTERNS:
        text = p.sub("[redacted]", text)
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"
