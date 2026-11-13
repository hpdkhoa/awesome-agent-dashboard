"""The data API: the page and other machines read and write the local database through the bridge (the owner's words,
2026-11-13: "use the bridge to read and write to that DB"). POST /data on the file viewer (files.py), the owner's
sign-in checked there. One JSON body per call:

  {"op": "get", "path"}                                   -> {"doc": {...} | null}
  {"op": "find", "coll", "filters": [[field, op, value]], "order", "desc", "limit", "after"} -> {"docs": [{"id", "data"}]}
  {"op": "set", "path", "data", "merge"}                  -> {"ok": true}
  {"op": "update", "path", "fields"}                      -> {"ok": bool}   (false: no such document)
  {"op": "delete", "path"}                                -> {"ok": true}
  {"op": "batch", "writes": [set | update | delete]}      -> {"ok": true}
  {"op": "count", "coll"}                                 -> {"count": n}
  {"op": "seq", "coll"}                                   -> {"seq": n}
  {"op": "changes", "since", "wait"}                      -> {"seq": n, "changes": [{"path", "coll", "op"}]}
        waits up to `wait` seconds (25 at most) for a change after `since`: the page's live updates, one open call.
  {"op": "many", "calls": [...]}                          -> {"results": [...]}   several reads in one round trip
"""

from __future__ import annotations

import time

from .localdb import MISSING

MAX_WAIT = 25.0
MAX_LIMIT = 500
# the money collections stay on Firestore (the owner's pick 2b); the page never asks the bridge for them
READS = {"get", "find", "count", "seq", "changes"}


class DataApi:
    def __init__(self, store, sleep=time.sleep, clock=time.time):
        self.store, self.sleep, self.clock = store, sleep, clock

    def answer(self, body: dict) -> dict:
        op = body.get("op")
        s = self.store
        if op == "get":
            return {"doc": s.get(_path(body))}
        if op == "find":
            filters = [(str(f[0]), str(f[1]), f[2]) for f in body.get("filters") or [] if isinstance(f, (list, tuple)) and len(f) == 3]
            limit = min(int(body.get("limit") or MAX_LIMIT), MAX_LIMIT)
            after = body["after"] if "after" in body else MISSING
            rows = s.find(_coll(body), filters, str(body.get("order") or ""), bool(body.get("desc", True)), limit, after, with_id=True)
            return {"docs": [{"id": r["__id"], "data": {k: v for k, v in r.items() if k != "__id"}} for r in rows]}
        if op == "count":
            return {"count": s.count(_coll(body))}
        if op == "seq":
            return {"seq": s.seq(str(body.get("coll") or ""))}
        if op == "changes":
            since = int(body.get("since") or 0)
            end = self.clock() + max(0.0, min(float(body.get("wait") or 0), MAX_WAIT))
            while True:
                last, changed = s.changes(since)
                if changed or last < since or self.clock() >= end:
                    # last < since: the database was replaced (an import): the page starts over from the new number
                    return {"seq": last if last >= since else s.seq(), "changes": changed, "reset": last < since}
                self.sleep(0.5)
        if op == "many":
            calls = [c for c in body.get("calls") or [] if isinstance(c, dict) and c.get("op") in READS and c.get("op") != "changes"][:40]
            return {"results": [self.answer(c) for c in calls]}
        if op == "batch":
            for w in (body.get("writes") or [])[:400]:
                if isinstance(w, dict) and w.get("op") in ("set", "update", "delete"):
                    self.answer(w)
            return {"ok": True}
        if op == "set":
            data = body.get("data")
            if not isinstance(data, dict):
                raise ValueError("set needs data")
            if body.get("merge"):
                s.merge(_path(body), data)
            else:
                s.put_many({_path(body): data})
            return {"ok": True}
        if op == "update":
            fields = body.get("fields")
            if not isinstance(fields, dict):
                raise ValueError("update needs fields")
            return {"ok": bool(s.update(_path(body), fields))}
        if op == "delete":
            s.delete(_path(body))
            return {"ok": True}
        raise ValueError("unknown op")


def _path(body: dict) -> str:
    p = str(body.get("path") or "")
    if p.count("/") != 1 or not all(p.split("/")):
        raise ValueError("a path is collection/id")
    return p


def _coll(body: dict) -> str:
    c = str(body.get("coll") or "")
    if not c or "/" in c:
        raise ValueError("a collection name is needed")
    return c
