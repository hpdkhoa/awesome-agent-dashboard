"""Firestore as the backup of the local database (the owner's pick 3a, 2026-11-13: every change, batched each
minute): writes only, never a read. Each round takes the paths changed since the last mirrored change number, once
each, and writes their current content (or deletes them). A refused round (quota, network) is tried again next time.

Heartbeats (liveSessions) are not mirrored: one write a minute per open session, and nothing reads them from the backup.
Also the one-time import the other way (`agent-bridge import-firestore`): every collection except the money ones, which
stay on Firestore (the owner's pick 2b).
"""

from __future__ import annotations

from datetime import datetime

SKIP = {"liveSessions"}
MONEY = {"moneyEntries", "fxRates", "goldPrices"}  # stay on Firestore: the page reads and writes them there
KEY = "mirror_seq"


class Mirror:
    def __init__(self, local, firestore):
        self.local, self.fs = local, firestore

    def step(self, limit: int = 2000) -> str | None:
        since = int(self.local.kv_get(KEY, "0") or 0)
        last, changed = self.local.changes(since, limit)
        if last == since:
            return None
        puts, deletes = {}, []
        for ch in changed:
            if ch["coll"] in SKIP or ch["coll"] in MONEY:
                continue
            doc = self.local.get(ch["path"])
            if doc is None:
                deletes.append(ch["path"])
            else:
                puts[ch["path"]] = doc
        if puts:
            self.fs.put_many(puts)
        for p in deletes:
            self.fs.delete(p)
        self.local.kv_set(KEY, str(last))
        self.local.trim_changes(last - 5000)  # the page's live updates never look further back
        return f"backup: {len(puts)} written, {len(deletes)} deleted on Firestore" if puts or deletes else None


def import_firestore(fs, local, say=print) -> dict[str, int]:
    """Copies every Firestore collection but the money ones into the local database. Returns the count of each."""
    from .firestore import from_value

    ids = (fs._call(f"{fs.base}:listCollectionIds", {"pageSize": 300}) or {}).get("collectionIds") or []
    out: dict[str, int] = {}
    for coll in sorted(ids):
        if coll in MONEY:
            say(f"{coll}: stays on Firestore")
            continue
        rows = fs._call(f"{fs.base}:runQuery", {"structuredQuery": {"from": [{"collectionId": coll}]}})
        docs = {}
        for r in rows:
            if "document" in r:
                doc_id = r["document"]["name"].rsplit("/", 1)[-1]
                docs[f"{coll}/{doc_id}"] = {k: from_value(v) for k, v in r["document"].get("fields", {}).items()}
        local.put_many(docs, log=False)  # imported, not changed: nothing to mirror back
        out[coll] = len(docs)
        say(f"{coll}: {len(docs)} read from Firestore, {local.count(coll)} in the local database")
    local.kv_set(KEY, str(local.seq()))
    local.kv_set("imported_at", datetime.now().astimezone().isoformat(timespec="seconds"))
    return out
