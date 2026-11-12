"""One sync: read what the logs added since last time, rebuild the documents, write only those that changed."""

from __future__ import annotations

import hashlib
import json
import os
import time
from datetime import datetime, timedelta
from pathlib import Path

from .aggregate import build
from .config import Config, data_dir
from .logs import FileState, read_lines, session_files


class State:
    """Per log file: how far it was read and what it held; per document: the hash last written. Kept outside the repo."""

    VERSION = 3  # 3: dashboard messages count as prompts (logs.py is_prompt); an older state is read again from the logs

    def __init__(self, path: Path):
        self.path = path
        raw = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        if raw.get("version") != self.VERSION:
            raw = {}
        self.files: dict[str, dict] = raw.get("files", {})
        self.written: dict[str, str] = raw.get("written", {})
        self.held: dict[str, dict] = raw.get("held", {})  # per session document: tokens, lastAt and when it was last written

    def save(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"version": self.VERSION, "files": self.files, "written": self.written, "held": self.held}), encoding="utf-8")
        os.replace(tmp, self.path)


# A session document mid-work is written only when it moved enough (the owner's words, 2026-11-13: "Write a session
# document only when its tokens moved by more than a step (say 50k) or its lastAt by more than 5 minutes: fewer writes
# while a session is mid-work, exact at rest"): tokens 50k or more, lastAt 5 min or more, or 5 min since its last
# write, so a session that went quiet ends with its exact numbers.
TOKEN_STEP = 50_000
REST_SECONDS = 300


def _ts(iso: str) -> float:
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def session_moved(prev: dict | None, doc: dict, now: float) -> bool:
    if not prev:
        return True
    tokens = int((doc.get("tokens") or {}).get("total") or 0)
    if abs(tokens - int(prev.get("tokens") or 0)) >= TOKEN_STEP:
        return True
    if abs(_ts(doc.get("lastAt") or "") - _ts(prev.get("lastAt") or "")) >= REST_SECONDS:
        return True
    return now - float(prev.get("wroteAt") or 0) >= REST_SECONDS


def read_all(cfg: Config, state: State, days: float) -> dict[str, list[FileState]]:
    out: dict[str, list[FileState]] = {}
    for sid, files in session_files(cfg.logs, days).items():
        states = []
        for f in files:
            key = str(f)
            size, mtime = f.stat().st_size, f.stat().st_mtime
            entry = state.files.get(key)
            if entry and entry["size"] == size and entry["mtime"] == mtime:
                st = FileState.from_json(entry["state"])
            else:
                st = FileState.from_json(entry["state"]) if entry and size >= entry["size"] else FileState()
                st = read_lines(f, st)
                state.files[key] = {"size": size, "mtime": mtime, "state": st.to_json()}
            states.append(st)
        out[sid] = states
    return out


def documents(cfg: Config, sessions: dict[str, list[FileState]], days: float) -> dict[str, dict]:
    docs, usage, wts = build(sessions, cfg.machine, cfg.roots)
    first_day = (datetime.now() - timedelta(days=max(days - 1, 0))).strftime("%Y-%m-%d")
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    out = {f"sessions/{sid}": d for sid, d in docs.items()}
    out.update({f"usage/{day}": u for day, u in usage.items() if day >= first_day})
    out.update({f"workTypes/{w}": d for w, d in wts.items()})
    out[f"machines/{cfg.machine}"] = {"name": cfg.machine, "windowDays": days, "sessions": len(docs),
                                      "folders": [{"workType": w, "path": p} for w, p in cfg.roots]}
    return out, now


def changed_only(state: State, docs: dict[str, dict], now: float | None = None) -> dict[str, dict]:
    now = time.time() if now is None else now
    out = {}
    for path, d in docs.items():
        h = hashlib.sha256(json.dumps(d, sort_keys=True).encode()).hexdigest()
        if state.written.get(path) == h:
            continue
        if path.startswith("sessions/") and not session_moved(state.held.get(path), d, now):
            continue  # changed, but not enough yet: it goes with the next step, or at rest
        out[path] = (d, h)
    return out


def deleted_paths(store, listened: set[str] | None) -> set[str]:
    """The documents the owner deleted on the Storage tab (meta/deleted), from the listener or one read."""
    if listened is not None:
        return listened
    return set(((store.get("meta/deleted") or {}).get("paths")) or {})


def run(cfg: Config, days: float, store=None, dry_run: bool = False, deleted=lambda: None) -> dict:
    """Reads, builds and writes. store is a Firestore (None with dry_run). Returns counts for the report.

    deleted: returns the listener's set of deleted paths, or None to read meta/deleted once. A deleted document is
    never written again (the owner's choice, 2026-11-01, "B1"), and its hash is not kept, so clearing it writes it back.
    """
    state = State(data_dir() / f"state-{cfg.project_id}.json")
    sessions = read_all(cfg, state, days)
    docs, now = documents(cfg, sessions, days)
    todo = changed_only(state, docs)
    if todo and store is not None:
        gone = deleted_paths(store, deleted())
        for p in gone:
            state.written.pop(p, None)  # forgotten: when the owner clears its tombstone it is written again at once
            state.held.pop(p, None)
        todo = {p: v for p, v in todo.items() if p not in gone}
    if not dry_run and todo:
        store.put_many({p: {**d, "syncedAt": now} for p, (d, _) in todo.items()})
        for p, (d, h) in todo.items():
            state.written[p] = h
            if p.startswith("sessions/"):
                state.held[p] = {"tokens": int((d.get("tokens") or {}).get("total") or 0), "lastAt": d.get("lastAt") or "", "wroteAt": time.time()}
    state.save()
    totals = {"sessions": sum(1 for p in docs if p.startswith("sessions/")), "written": 0 if dry_run else len(todo),
              "toWrite": len(todo), "machineWritten": not dry_run and f"machines/{cfg.machine}" in todo}
    totals["tokens"] = sum(d["tokens"]["total"] for p, d in docs.items() if p.startswith("sessions/"))
    totals["costUsd"] = round(sum(d["tokens"]["costUsd"] for p, d in docs.items() if p.startswith("sessions/")), 2)
    return totals
