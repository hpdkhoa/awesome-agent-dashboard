"""Keeps the pictures of a decision as they were when the owner answered (the owner's words, 2026-11-10: "yes do the
snapshot"; the problem: an approved option's image pointed to avatar/preview.png, which a later preview overwrote, so
the decision showed a picture the owner never approved).

When a plan question's answer reaches this PC (the session takes it live, or the bridge delivers it), the image files of
every option's example are copied into the plan's own folder:
    <plan cwd>/.plan_data/<plan id>/decisions/<item id>/<n>-<before|after>-<file name>
and the item gets `snapshot`: {"at": the answer's time, "files": {option label: {"before": rel, "after": rel}},
"changed": [source paths written after the answer], "missing": [source paths not found]}. The page shows the copies.
An answer changed later (reopened) takes a new snapshot. Never deletes or changes the source files.
"""
from __future__ import annotations

import os
import shutil
from datetime import datetime
from pathlib import Path

from .inbox import now_iso


def _when(iso: str) -> float:
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except (ValueError, AttributeError):
        return 0.0


def needs(item: dict) -> bool:
    """A plan question with an answer, image examples, and no snapshot of this answer yet."""
    if not item.get("planId") or not item.get("answer"):
        return False
    if not any((o.get("example") or {}).get("type") == "image" for o in item.get("options") or []):
        return False
    snap = item.get("snapshot") or {}
    return snap.get("at") != (item.get("answer") or {}).get("at")


def take(store, item: dict) -> dict | None:
    """Copies the files and writes `snapshot` on the item. Returns the snapshot, or None when none is needed."""
    if not needs(item):
        return None
    cwd = item.get("cwd") or ""
    if not os.path.isdir(cwd):
        return None
    answered = _when(item["answer"].get("at") or "")
    rel_dir = Path(".plan_data") / str(item["planId"]) / "decisions" / str(item["id"])
    folder = Path(cwd) / rel_dir
    if folder.is_dir():  # a changed answer: the new snapshot replaces the old one
        shutil.rmtree(folder)
    folder.mkdir(parents=True, exist_ok=True)
    done: dict[str, str] = {}  # source path -> copy, so one file shown in many options is copied once
    files: dict[str, dict] = {}
    changed, missing = [], []
    for n, o in enumerate(item.get("options") or []):
        e = o.get("example") or {}
        if e.get("type") != "image":
            continue
        out = {}
        for k in ("before", "after"):
            src = str(e.get(k) or "")
            full = Path(src if os.path.isabs(src) else os.path.join(cwd, src))
            if src in done:
                out[k] = done[src]
                continue
            if not full.is_file():
                if src not in missing:
                    missing.append(src)
                continue
            if answered and full.stat().st_mtime > answered:
                changed.append(src)  # written after the answer: the copy may not be the picture approved
            dest = folder / f"{n + 1}-{k}-{full.name}"
            shutil.copy2(full, dest)
            out[k] = done[src] = (rel_dir / dest.name).as_posix()
        files[o.get("label", str(n))] = out
    snap = {"at": item["answer"].get("at"), "takenAt": now_iso(), "files": files,
            "changed": sorted(set(changed)), "missing": missing}
    store.update(f"inbox/{item['id']}", {"snapshot": snap})
    return snap


def backfill(store, machine: str) -> list[str]:
    """The plan questions answered before snapshots existed: one snapshot each, from the files as they are now (a file
    written after the answer is listed in `changed`, so the page marks it)."""
    log = []
    for item in store.where("inbox", "machine", machine):
        snap = take(store, item)
        if snap:
            log.append(f"{item['id']}: snapshot of {len(snap['files'])} option(s), changed {len(snap['changed'])}, "
                       f"missing {len(snap['missing'])}")
    return log
