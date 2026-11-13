"""The local database on the machine that hosts the bridge (the owner's words, 2026-11-13: "switch firestore into local DB
in the place bridge is hosted, and then use the bridge to read and write to that DB, firestore can keep as backup but
I want to least the read request from firestore").

One SQLite file (WAL, so the bridge and every session's inbox server share it): documents by path, the same calls the
Firestore client has (firestore.py: get, update, where, query, put_many, delete), plus what the page's data API needs
(find, merge, count) and a change log. The change log feeds the page's live updates (data API "changes"), the local
feeds below, and the backup mirror to Firestore (mirror.py).

Other machines (the owner's pick 4a: "they call this PC's bridge") use RemoteStore: the same calls over the data API.
"""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

OPS = {
    "EQUAL": lambda a, b: a == b, "==": lambda a, b: a == b,
    "NOT_EQUAL": lambda a, b: a != b, "!=": lambda a, b: a != b,
    "IN": lambda a, b: a in (b or []), "in": lambda a, b: a in (b or []),
    "GREATER_THAN_OR_EQUAL": lambda a, b: a >= b, ">=": lambda a, b: a >= b,
    "GREATER_THAN": lambda a, b: a > b, ">": lambda a, b: a > b,
    "LESS_THAN_OR_EQUAL": lambda a, b: a <= b, "<=": lambda a, b: a <= b,
    "LESS_THAN": lambda a, b: a < b, "<": lambda a, b: a < b,
    "ARRAY_CONTAINS": lambda a, b: isinstance(a, list) and b in a, "array-contains": lambda a, b: isinstance(a, list) and b in a,
}
MISSING = object()


def field_of(doc: dict, path: str):
    cur = doc
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return MISSING
        cur = cur[part]
    return cur


def matches(doc: dict, filters) -> bool:
    """Like Firestore: a document without the field never matches a filter on it."""
    for field, op, value in filters or []:
        got = field_of(doc, field)
        if got is MISSING or op not in OPS:
            return False
        try:
            if not OPS[op](got, value):
                return False
        except TypeError:
            return False
    return True


def deep_merge(old: dict, new: dict) -> dict:
    out = dict(old)
    for k, v in new.items():
        out[k] = deep_merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def split(path: str) -> tuple[str, str]:
    coll, _, doc_id = path.partition("/")
    if not coll or not doc_id or "/" in doc_id:
        raise ValueError(f"not a document path: {path}")
    return coll, doc_id


class LocalStore:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._db() as db:
            db.executescript(
                "CREATE TABLE IF NOT EXISTS docs (path TEXT PRIMARY KEY, coll TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, at REAL NOT NULL);"
                "CREATE INDEX IF NOT EXISTS docs_coll ON docs (coll);"
                "CREATE TABLE IF NOT EXISTS changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, coll TEXT NOT NULL, op TEXT NOT NULL, at REAL NOT NULL);"
                "CREATE INDEX IF NOT EXISTS changes_coll ON changes (coll, seq);"
                "CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);"
            )

    def _db(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA synchronous=NORMAL")
        db.execute("PRAGMA busy_timeout=30000")
        return db

    # the Firestore client's calls -------------------------------------------------------------------------------
    def check_owner(self) -> None:
        """The file belongs to this machine's user; the data API checks the owner's sign-in (files.py)."""

    def get(self, path: str) -> dict | None:
        with self._db() as db:
            row = db.execute("SELECT data FROM docs WHERE path = ?", (path,)).fetchone()
        return json.loads(row[0]) if row else None

    def _write(self, db, path: str, data: dict, log: bool = True) -> None:
        coll, doc_id = split(path)
        now = time.time()
        db.execute("INSERT INTO docs (path, coll, id, data, at) VALUES (?, ?, ?, ?, ?) "
                   "ON CONFLICT(path) DO UPDATE SET data = excluded.data, at = excluded.at",
                   (path, coll, doc_id, json.dumps(data, default=str), now))
        if log:
            db.execute("INSERT INTO changes (path, coll, op, at) VALUES (?, ?, 'set', ?)", (path, coll, now))

    def update(self, path: str, fields: dict) -> bool:
        """Sets only the given top-level fields; a document that does not exist is not made (returns False)."""
        with self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT data FROM docs WHERE path = ?", (path,)).fetchone()
            if not row:
                db.execute("COMMIT")
                return False
            self._write(db, path, {**json.loads(row[0]), **fields})
            db.execute("COMMIT")
        return True

    def merge(self, path: str, fields: dict) -> None:
        """Like the page's setDoc(..., {merge: true}): maps merge deep, the document is made when missing."""
        with self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT data FROM docs WHERE path = ?", (path,)).fetchone()
            self._write(db, path, deep_merge(json.loads(row[0]) if row else {}, fields))
            db.execute("COMMIT")

    def put_many(self, docs: dict[str, dict], log: bool = True) -> int:
        with self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            for path, fields in docs.items():
                self._write(db, path, fields, log)
            db.execute("COMMIT")
        return len(docs)

    def delete(self, path: str) -> None:
        coll, _ = split(path)
        with self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM docs WHERE path = ?", (path,))
            db.execute("INSERT INTO changes (path, coll, op, at) VALUES (?, ?, 'delete', ?)", (path, coll, time.time()))
            db.execute("COMMIT")

    def find(self, collection: str, filters=None, order: str = "", desc: bool = True, limit: int = 0, after=MISSING,
             with_id: bool = False) -> list[dict]:
        """Documents of one collection that match every filter [(field, op, value)], ordered by one field (documents
        without it are left out, like Firestore), after a cursor value, at most `limit`."""
        with self._db() as db:
            rows = db.execute("SELECT id, data FROM docs WHERE coll = ?", (collection,)).fetchall()
        out = []
        for doc_id, data in rows:
            d = json.loads(data)
            if matches(d, filters):
                out.append((doc_id, d))
        if order:
            out = [x for x in out if field_of(x[1], order) is not MISSING and field_of(x[1], order) is not None]
            out.sort(key=lambda x: (field_of(x[1], order), x[0]), reverse=desc)
            if after is not MISSING and after is not None:
                cut_value, cut_id = after if isinstance(after, (list, tuple)) else (after, None)
                key = lambda x: (field_of(x[1], order), x[0])
                if cut_id is None:
                    out = [x for x in out if (field_of(x[1], order) < cut_value if desc else field_of(x[1], order) > cut_value)]
                else:
                    out = [x for x in out if (key(x) < (cut_value, cut_id) if desc else key(x) > (cut_value, cut_id))]
        if limit:
            out = out[:limit]
        return [{**d, "__id": doc_id} if with_id else d for doc_id, d in out]

    def where(self, collection: str, field: str, value) -> list[dict]:
        return self.find(collection, [(field, "EQUAL", value)])

    def query(self, collection: str, field: str = "", op: str = "EQUAL", value=None, order: str = "", limit: int = 0) -> list[dict]:
        return self.find(collection, [(field, op, value)] if field else None, order, True, limit)

    # what the data API, the feeds and the mirror need ----------------------------------------------------------
    def count(self, collection: str) -> int:
        with self._db() as db:
            return db.execute("SELECT COUNT(*) FROM docs WHERE coll = ?", (collection,)).fetchone()[0]

    def collections(self) -> list[str]:
        with self._db() as db:
            return [r[0] for r in db.execute("SELECT DISTINCT coll FROM docs ORDER BY coll")]

    def seq(self, collection: str = "") -> int:
        """The newest change number, of one collection or of all: a feed asks again only when it moved."""
        with self._db() as db:
            row = (db.execute("SELECT MAX(seq) FROM changes WHERE coll = ?", (collection,)) if collection
                   else db.execute("SELECT MAX(seq) FROM changes")).fetchone()
        return int(row[0] or 0)

    def changes(self, since: int, limit: int = 500) -> tuple[int, list[dict]]:
        """(the newest change number, the changed paths after `since`, each once with its last op)."""
        with self._db() as db:
            rows = db.execute("SELECT seq, path, coll, op FROM changes WHERE seq > ? ORDER BY seq LIMIT ?", (since, limit)).fetchall()
        last: dict[str, dict] = {}
        for seq, path, coll, op in rows:
            last[path] = {"path": path, "coll": coll, "op": op}
        return (rows[-1][0] if rows else since), list(last.values())

    def trim_changes(self, keep_after: int) -> None:
        with self._db() as db:
            db.execute("DELETE FROM changes WHERE seq <= ?", (keep_after,))

    def kv_get(self, k: str, default: str = "") -> str:
        with self._db() as db:
            row = db.execute("SELECT v FROM kv WHERE k = ?", (k,)).fetchone()
        return row[0] if row else default

    def kv_set(self, k: str, v: str) -> None:
        with self._db() as db:
            db.execute("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", (k, v))


class RemoteStore:
    """The same calls, sent to the bridge that hosts the database (another machine's bridge and its sessions)."""

    def __init__(self, url: str, session, send=None):
        self.url, self.s = url.rstrip("/"), session
        self._send = send or self._http

    def _http(self, body: dict) -> dict:
        import urllib.error
        import urllib.request

        req = urllib.request.Request(self.url + "/data", data=json.dumps(body).encode(), method="POST",
                                     headers={"Authorization": f"Bearer {self.s.token()}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            raise SystemExit(f"The database host refused ({e.code}): {e.read().decode()[:300]}") from None
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise SystemExit(f"The database host does not answer: {e}") from None

    def check_owner(self) -> None:
        self._send({"op": "count", "coll": "meta"})

    def get(self, path: str) -> dict | None:
        return self._send({"op": "get", "path": path}).get("doc")

    def update(self, path: str, fields: dict) -> bool:
        return bool(self._send({"op": "update", "path": path, "fields": fields}).get("ok"))

    def merge(self, path: str, fields: dict) -> None:
        self._send({"op": "set", "path": path, "data": fields, "merge": True})

    def put_many(self, docs: dict[str, dict], log: bool = True) -> int:
        items = list(docs.items())
        for i in range(0, len(items), 100):
            self._send({"op": "batch", "writes": [{"op": "set", "path": p, "data": d} for p, d in items[i:i + 100]]})
        return len(items)

    def delete(self, path: str) -> None:
        self._send({"op": "delete", "path": path})

    def find(self, collection: str, filters=None, order: str = "", desc: bool = True, limit: int = 0, after=MISSING, with_id: bool = False) -> list[dict]:
        body = {"op": "find", "coll": collection, "filters": [list(f) for f in filters or []], "order": order, "desc": desc, "limit": limit}
        if after is not MISSING:
            body["after"] = after
        rows = self._send(body).get("docs") or []
        return [{**r["data"], "__id": r["id"]} if with_id else r["data"] for r in rows]

    def where(self, collection: str, field: str, value) -> list[dict]:
        return self.find(collection, [(field, "EQUAL", value)])

    def query(self, collection: str, field: str = "", op: str = "EQUAL", value=None, order: str = "", limit: int = 0) -> list[dict]:
        return self.find(collection, [(field, op, value)] if field else None, order, True, limit)

    def count(self, collection: str) -> int:
        return int(self._send({"op": "count", "coll": collection}).get("count") or 0)

    def seq(self, collection: str = "") -> int:
        return int(self._send({"op": "seq", "coll": collection}).get("seq") or 0)


# Feeds: what listen.py's Firestore listens gave the bridge, from the local database: asked again only when the
# collection's change number moved, so an idle round costs one small query and no Firestore read.

class LocalFeed:
    def __init__(self, store, collection: str, pick, name: str = ""):
        self.store, self.collection, self.pick, self.name = store, collection, pick, name or collection
        self.at: int | None = None
        self.rows: list[dict] | None = None

    def current(self) -> list[dict] | None:
        try:
            seq = self.store.seq(self.collection)
            if self.rows is None or seq != self.at:
                self.rows = self.pick(self.store)
                self.at = seq
        except SystemExit:
            return None  # a remote host that does not answer: the caller asks the old way or waits
        return list(self.rows)

    def close(self) -> None:
        pass


def with_ids(store, collection: str, filters=None, order: str = "", limit: int = 0) -> list[dict]:
    return [{**{k: v for k, v in d.items() if k != "__id"}, "id": d.get("id") or d["__id"]}
            for d in store.find(collection, filters, order, True, limit, with_id=True)]


def command_feed(store, statuses) -> LocalFeed:
    return LocalFeed(store, "commands", lambda s: with_ids(s, "commands", [("status", "IN", list(statuses))]), "commands(new,waiting)")


class LocalDeletedFeed(LocalFeed):
    def __init__(self, store):
        super().__init__(store, "meta", lambda s: [d for d in [s.get("meta/deleted")] if d], "meta/deleted")

    def paths(self) -> set[str] | None:
        rows = self.current()
        return None if rows is None else {p for r in rows for p in (r.get("paths") or {})}


def doc_feed(store, path: str) -> LocalFeed:
    return LocalFeed(store, path.split("/")[0], lambda s: [d for d in [s.get(path)] if d], path)
