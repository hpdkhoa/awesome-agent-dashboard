"""Writes documents to Firestore through its REST API, signed in as the owner, so the same rules apply as for the page."""

from __future__ import annotations

import http.client
import json
import threading
import urllib.parse

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


counter = None  # a usage.Counter: the bridge's own reads, writes and deletes today (set once by set_counter)


def set_counter(c) -> None:
    global counter
    counter = c


def count_call(url: str, body, method, result) -> None:
    """Adds one REST call to the counter: a get is one read, a runQuery one read per document (at least one), a PATCH
    one write, a commit one write or delete per entry."""
    if counter is None:
        return
    src = "rest:" + _collection(url, body)
    size = lambda x: len(json.dumps(x, default=str)) if x is not None else 0
    if url.endswith(":runQuery"):
        counter.add("reads", max(1, sum(1 for r in (result or []) if isinstance(r, dict) and "document" in r)), src, size(result))
    elif url.endswith(":commit"):
        writes = (body or {}).get("writes") or []
        deletes = sum(1 for w in writes if "delete" in w)
        counter.add("deletes", deletes, src)
        counter.add("writes", len(writes) - deletes, src, size(body))
    elif method == "PATCH":
        counter.add("writes", 1, src, size(body))
    elif body is None:
        counter.add("reads", 1, src, size(result))


def _collection(url: str, body) -> str:
    """The collection a REST call touches, for the per-source count (p14)."""
    if url.endswith(":runQuery"):
        try:
            return body["structuredQuery"]["from"][0]["collectionId"]
        except (KeyError, IndexError, TypeError):
            return "query"
    if url.endswith(":commit"):
        names = {w.get("update", {}).get("name", w.get("delete", "")).split("/documents/")[-1].split("/")[0]
                 for w in (body or {}).get("writes") or []}
        return "+".join(sorted(n for n in names if n)) or "commit"
    return url.split("/documents/")[-1].split("?")[0].split("/")[0] or "doc"


class Firestore:
    def __init__(self, session: Session):
        self.s = session
        self.root = f"projects/{session.cfg.project_id}/databases/(default)/documents"
        self.base = f"https://firestore.googleapis.com/v1/{self.root}"
        self._local = threading.local()  # each thread's kept-open HTTPS connection (_send)

    def _call(self, url: str, body: dict | None = None, method: str | None = None) -> dict:
        data = None if body is None else json.dumps(body).encode()
        headers = {"Authorization": f"Bearer {self.s.token()}", "Content-Type": "application/json"}
        status, raw = self._send(url, method or ("GET" if data is None else "POST"), data, headers)
        if status >= 400:
            if body is None and method is None:
                count_call(url, None, None, None)  # a missing document is still one read
            raise SystemExit(f"Firestore refused ({status}): {raw.decode(errors='replace')[:300]}") from None
        result = json.loads(raw)
        count_call(url, body, method, result)
        return result

    def _send(self, url: str, method: str, data: bytes | None, headers: dict) -> tuple[int, bytes]:
        """One HTTPS call on this thread's kept-open connection (p14 F5, the owner's pick 2026-11-12: "Add F5 to
        p14", the bridge's internet bytes). Before, each call opened a new TLS connection, whose handshake (the
        server's certificates) outweighed the call itself. A connection the server closed is opened again once."""
        u = urllib.parse.urlsplit(url)
        path = u.path + (f"?{u.query}" if u.query else "")
        for attempt in (0, 1):
            conn = getattr(self._local, "conn", None)
            if conn is None:
                conn = self._local.conn = http.client.HTTPSConnection(u.netloc, timeout=60)
            try:
                conn.request(method, path, body=data, headers=headers)
                r = conn.getresponse()
                return r.status, r.read()
            except (http.client.HTTPException, OSError):
                conn.close()
                self._local.conn = None
                if attempt:
                    raise
        raise AssertionError("unreachable")

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

    def query(self, collection: str, field: str = "", op: str = "EQUAL", value=None, order: str = "",
              limit: int = 0) -> list[dict]:
        """One query: an optional filter (op: EQUAL, IN, GREATER_THAN_OR_EQUAL, ...), an optional newest-first order on
        one field, an optional limit. One filter or one order needs no composite index."""
        sq: dict = {"from": [{"collectionId": collection}]}
        if field:
            sq["where"] = {"fieldFilter": {"field": {"fieldPath": field}, "op": op, "value": to_value(value)}}
        if order:
            sq["orderBy"] = [{"field": {"fieldPath": order}, "direction": "DESCENDING"}]
        if limit:
            sq["limit"] = limit
        rows = self._call(f"{self.base}:runQuery", {"structuredQuery": sq})
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
