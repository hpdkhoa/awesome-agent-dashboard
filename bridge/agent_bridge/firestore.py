"""Writes documents to Firestore through its REST API, signed in as the owner, so the same rules apply as for the page."""

from __future__ import annotations

import json
import urllib.error
import urllib.request

from .auth import Session


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

    def _call(self, url: str, body: dict | None = None) -> dict:
        req = urllib.request.Request(
            url,
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
