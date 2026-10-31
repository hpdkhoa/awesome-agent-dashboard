"""One sync: read what the logs added since last time, rebuild the documents, write only those that changed."""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timedelta
from pathlib import Path

from .aggregate import build
from .config import Config, data_dir
from .logs import FileState, read_lines, session_files


class State:
    """Per log file: how far it was read and what it held; per document: the hash last written. Kept outside the repo."""

    def __init__(self, path: Path):
        self.path = path
        raw = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        self.files: dict[str, dict] = raw.get("files", {})
        self.written: dict[str, str] = raw.get("written", {})

    def save(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"files": self.files, "written": self.written}), encoding="utf-8")
        os.replace(tmp, self.path)


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


def changed_only(state: State, docs: dict[str, dict]) -> dict[str, dict]:
    out = {}
    for path, d in docs.items():
        h = hashlib.sha256(json.dumps(d, sort_keys=True).encode()).hexdigest()
        if state.written.get(path) != h:
            out[path] = (d, h)
    return out


def run(cfg: Config, days: float, store=None, dry_run: bool = False) -> dict:
    """Reads, builds and writes. store is a Firestore (None with dry_run). Returns counts for the report."""
    state = State(data_dir() / f"state-{cfg.project_id}.json")
    sessions = read_all(cfg, state, days)
    docs, now = documents(cfg, sessions, days)
    todo = changed_only(state, docs)
    if not dry_run and todo:
        store.put_many({p: {**d, "syncedAt": now} for p, (d, _) in todo.items()})
        for p, (_, h) in todo.items():
            state.written[p] = h
    state.save()
    totals = {"sessions": sum(1 for p in docs if p.startswith("sessions/")), "written": 0 if dry_run else len(todo),
              "toWrite": len(todo)}
    totals["tokens"] = sum(d["tokens"]["total"] for p, d in docs.items() if p.startswith("sessions/"))
    totals["costUsd"] = round(sum(d["tokens"]["costUsd"] for p, d in docs.items() if p.startswith("sessions/")), 2)
    return totals
