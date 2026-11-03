"""Writes documents to Firestore through its REST API, signed in as the owner, so the same rules apply as for the page."""

from __future__ import annotations

import json
import urllib.error
import urllib.request

from .auth import Session


def from_value(v: dict):
    if "nullValue" in v:
        return None
    for k in ("booleanValue", "stringValue", "doubleValue", "timestampValue"):
        if k in v:
            return v[k]
    if "integerValue" in v:
        return int(v["integerValue"])
    if "mapValue" in v:
        return {k: from_value(x) for k, x in v["mapValue"].get("fields", {}).items()}
    if "arrayValue" in v:
        return [from_value(x) for x in v["arrayValue"].get("values", [])]
    return None


def to_value(v) -> dict:
    if v is None:
        return {"nullValue": None}
    if isinstance(v, bool):
        return {"booleanValue": v}
    if isinstance(v, int):
        return {"integerValue": str(v)}
    if isinstance(v, float):
        return {"doubleValue": v}
    if isinstance(v, str):
        return {"stringValue": v}
    if isinstance(v, dict):
        return {"mapValue": {"fields": {str(k): to_value(x) for k, x in v.items()}}}
    if isinstance(v, (list, tuple)):
        return {"arrayValue": {"values": [to_value(x) for x in v]}}
    raise TypeError(f"cannot store {type(v).__name__}")


class Firestore:
    def __init__(self, session: Session):
        self.s = session
        self.root = f"projects/{session.cfg.project_id}/databases/(default)/documents"
        self.base = f"https://firestore.googleapis.com/v1/{self.root}"

    def _call(self, url: str, body: dict | None = None, method: str | None = None) -> dict:
        req = urllib.request.Request(
            url,
            method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {self.s.token()}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            raise SystemExit(f"Firestore refused ({e.code}): {e.read().decode()[:300]}") from None

    def check_owner(self) -> None:
        """Reads meta/owner. Only the owner may; anyone else gets 403 here."""
        try:
            self._call(f"{self.base}/meta/owner")
        except SystemExit as e:
            if "(404)" not in str(e):
                raise

    def get(self, path: str) -> dict | None:
        try:
            d = self._call(f"{self.base}/{path}")
        except SystemExit as e:
            if "(404)" in str(e):
                return None
            raise
        return {k: from_value(v) for k, v in d.get("fields", {}).items()}

    def update(self, path: str, fields: dict) -> bool:
        """Sets only the given top-level fields of one document, leaving the rest as they are. A document the owner
        deleted stays deleted (the owner's choice, 2026-11-03: "The bridge stops writing to a deleted record"): the
        write needs the document to exist, and returns False when it does not."""
        mask = "&".join(f"updateMask.fieldPaths={k}" for k in fields)
        body = {"fields": to_value(fields)["mapValue"]["fields"]}
        req_url = f"{self.base}/{path}?{mask}&currentDocument.exists=true"
        try:
            self._call(req_url, body, method="PATCH")
        except SystemExit as e:
            if "(404)" in str(e):
                return False
            raise
        return True

    def where(self, collection: str, field: str, value) -> list[dict]:
        """Documents of one collection whose field equals value."""
        q = {"structuredQuery": {"from": [{"collectionId": collection}], "where": {"fieldFilter": {
            "field": {"fieldPath": field}, "op": "EQUAL", "value": to_value(value)}}}}
        rows = self._call(f"{self.base}:runQuery", q)
        return [{k: from_value(v) for k, v in r["document"].get("fields", {}).items()} for r in rows if "document" in r]

    def put_many(self, docs: dict[str, dict]) -> int:
        """Replaces each document (path -> fields), 400 per commit. Returns how many were written."""
        items = list(docs.items())
        for i in range(0, len(items), 400):
            writes = [
                {"update": {"name": f"{self.root}/{path}", "fields": to_value(fields)["mapValue"]["fields"]}}
                for path, fields in items[i : i + 400]
            ]
            self._call(f"{self.base}:commit", {"writes": writes})
        return len(items)

    def delete(self, path: str) -> None:
        self._call(f"{self.base}:commit", {"writes": [{"delete": f"{self.root}/{path}"}]})
