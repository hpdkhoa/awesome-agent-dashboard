"""The archiver hand-off: a dashboard message waiting for a session open in the app (the owner's words, 2026-11-06:
"All actions for this archive will be archive, bridge sees session freed then unarchive them. I want to do only with
the session got no background work and wait time is 1 minute before archive and unarchive it"; the cheap way: "the
bridge checks for free and wakes the archiver only when needed, with the archiver in Auto").

The bridge cannot archive: only a Claude session inside the app has Archive and Unarchive. So one app session, the
archiver, waits in archiver_wait (inbox.py) and acts on what the bridge asks here. Both run on this PC, so they talk
through a local folder, with no Firestore reads:

- ask-<cid>-<action>.json  the bridge asks: archive (the message waited 1 minute) or unarchive (the message runs now)
- taken-<cid>-<action>.json  the archiver took it
- done-<cid>-<action>.json  the archiver's report: ok, or why not (busy, pinned, open on screen, no match)
- alive.json  the archiver's last wait; the bridge asks only while it is fresh
- state.json  the bridge's own state per message: asked, archived, unarchiving, refused
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

WAIT_FIRST = 60  # seconds a message waits for a session open in the app before the archiver is asked
ALIVE = 15 * 60  # an archiver whose last wait is older than this is gone; nothing is asked of it
STALE = 5 * 60  # an archive ask older than this is dropped, never acted on late


def _write(path: Path, data: dict) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    os.replace(tmp, path)


def _read(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


class Hand:
    """The archiver's side, used by the archiver_wait and archiver_report tools."""

    def __init__(self, folder: Path, own_session: str = ""):
        self.folder, self.own = folder, own_session
        folder.mkdir(parents=True, exist_ok=True)

    def take(self, seconds: float, poll: float = 2.0) -> dict | None:
        """The next ask, or None after `seconds`. Marks the archiver alive while it waits."""
        end = time.time() + seconds
        while True:
            _write(self.folder / "alive.json", {"at": time.time(), "session": self.own})
            for f in sorted(self.folder.glob("ask-*.json"), key=lambda p: p.stat().st_mtime):
                ask = _read(f)
                taken = self.folder / f.name.replace("ask-", "taken-", 1)
                try:
                    os.replace(f, taken)
                except OSError:
                    continue
                if ask.get("action") == "archive" and time.time() - float(ask.get("at", 0)) > STALE:
                    _write(self.folder / f.name.replace("ask-", "done-", 1), {**ask, "ok": False, "note": "too old"})
                    continue
                if ask.get("sessionId") and ask.get("sessionId") == self.own:
                    _write(self.folder / f.name.replace("ask-", "done-", 1),
                           {**ask, "ok": False, "note": "the archiver never archives itself"})
                    continue
                return ask
            if time.time() >= end:
                return None
            time.sleep(poll)

    def report(self, cid: str, action: str, ok: bool, note: str = "", app_session: str = "") -> None:
        _write(self.folder / f"done-{cid}-{action}.json",
               {"cid": cid, "action": action, "ok": bool(ok), "note": note[:300], "appSession": app_session,
                "at": time.time()})


class Archiver:
    """The bridge's side: asks for an archive after a message waited 1 minute, sees the archiver's reports, and asks
    for the unarchive once the message runs or is gone."""

    def __init__(self, folder: Path):
        self.folder = folder
        folder.mkdir(parents=True, exist_ok=True)
        self.state: dict[str, dict] = _read(folder / "state.json")

    def _save(self) -> None:
        _write(self.folder / "state.json", self.state)

    def alive(self) -> bool:
        return time.time() - float(_read(self.folder / "alive.json").get("at", 0)) < ALIVE

    def of(self, cid: str) -> str:
        return (self.state.get(cid) or {}).get("state", "")

    def maybe_ask(self, cid: str, session_id: str, cwd: str, waiting_since: float, last_at: str) -> bool:
        """Asks for the archive when the message has waited WAIT_FIRST seconds, once per message."""
        if cid in self.state or time.time() - waiting_since < WAIT_FIRST or not self.alive():
            return False
        ask = {"cid": cid, "action": "archive", "sessionId": session_id, "cwd": cwd, "lastAt": last_at, "at": time.time()}
        _write(self.folder / f"ask-{cid}-archive.json", ask)
        self.state[cid] = {"state": "asked", "sessionId": session_id, "at": time.time()}
        self._save()
        return True

    def ask_unarchive(self, cid: str) -> None:
        s = self.state.get(cid) or {}
        if s.get("state") != "archived":
            return
        _write(self.folder / f"ask-{cid}-unarchive.json",
               {"cid": cid, "action": "unarchive", "sessionId": s.get("sessionId", ""), "appSession": s.get("appSession", ""),
                "at": time.time()})
        s["state"] = "unarchiving"
        self._save()

    def collect(self) -> list[tuple[str, str, str]]:
        """The archiver's reports since the last step: (cid, new state, note)."""
        out = []
        for f in self.folder.glob("done-*.json"):
            r = _read(f)
            f.unlink(missing_ok=True)
            (self.folder / f.name.replace("done-", "taken-", 1)).unlink(missing_ok=True)
            cid, s = r.get("cid", ""), self.state.get(r.get("cid", ""))
            if not s:
                continue
            if r.get("action") == "archive":
                s["state"] = "archived" if r.get("ok") else "refused"
                s["appSession"] = r.get("appSession", "")
            else:
                s["state"] = "done" if r.get("ok") else "unarchive failed"
            s["note"] = r.get("note", "")
            out.append((cid, s["state"], s["note"]))
        for cid, s in self.state.items():  # an archiver that took an ask and never answered
            if s.get("state") == "asked" and time.time() - float(s.get("at", 0)) > STALE + 5 * 60:
                s.update(state="refused", note="the archiver did not answer")
                out.append((cid, "refused", s["note"]))
        for cid in [k for k, v in self.state.items() if v.get("state") in ("done", "refused")
                    and time.time() - float(v.get("at", 0)) > 24 * 3600]:
            del self.state[cid]
        self._save()
        return out
