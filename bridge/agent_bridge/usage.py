"""Usage checks for the right spend panel (the owner's words, 2026-11-09: "I want the usage check for my agent dashboard
too, make it as a manual check button and render together in the spend zone"; the pick: "Both. Note: but need two
separated button for claude and firestore"). Nothing is stored in Firestore: the page asks POST /usage on the file
viewer (files.py) and shows the answer.

- claude: the signed-in Claude account's limit windows, read the way Claude Code's /usage reads them: the OAuth token
  in ~/.claude/.credentials.json and GET https://api.anthropic.com/api/oauth/usage. The token never leaves this PC
  except to that endpoint, and is never written anywhere.
- firestore: what the bridge itself did today against Firestore (document reads, writes, deletes), counted in
  firestore.py (REST calls) and listen.py (listener snapshots) and kept per local day in firestore-usage.json, against
  the free tier. Google's own meter is not readable from here; this is the bridge's count, the page adds its own.
"""

from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
FREE_TIER = {"reads": 50000, "writes": 20000, "deletes": 20000}  # per day, Firestore free tier
WINDOWS = [("five_hour", "5-hour window"), ("seven_day", "weekly, all models"), ("seven_day_opus", "weekly, Opus"),
           ("seven_day_sonnet", "weekly, Sonnet")]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def local_day() -> str:
    return time.strftime("%Y-%m-%d")


class Counter:
    """Today's document reads, writes and deletes made by this bridge, in a small file that survives a restart."""

    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()
        try:
            self.data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.data = {}
        if self.data.get("day") != local_day():
            self.data = self._fresh()

    @staticmethod
    def _fresh() -> dict:
        return {"day": local_day(), "reads": 0, "writes": 0, "deletes": 0, "since": now_iso()}

    def add(self, kind: str, n: int = 1, source: str = "", size: int = 0) -> None:
        """source and size (p14 F4/F5, the owner's pick 2026-11-12: "Count reads by collection"): the listen or REST
        collection the count came from, and the documents' JSON size in bytes, kept per day under "by"."""
        if n <= 0 or kind not in ("reads", "writes", "deletes"):
            return
        with self.lock:
            if self.data.get("day") != local_day():
                self.data = self._fresh()
            self.data[kind] = int(self.data.get(kind, 0)) + n
            if source:
                e = self.data.setdefault("by", {}).setdefault(source, {})
                e[kind] = int(e.get(kind, 0)) + n
                e["bytes"] = int(e.get("bytes", 0)) + max(0, size)
            self.data["at"] = now_iso()
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                tmp = self.path.with_suffix(".tmp")
                tmp.write_text(json.dumps(self.data), encoding="utf-8")
                os.replace(tmp, self.path)
            except OSError:
                pass  # the count lives on in memory; the file is only for the next start

    def today(self) -> dict:
        with self.lock:
            if self.data.get("day") != local_day():
                self.data = self._fresh()
            return dict(self.data)


def _fetch(token: str) -> dict:
    req = urllib.request.Request(USAGE_URL, headers={"Authorization": f"Bearer {token}", "anthropic-beta": "oauth-2025-04-20",
                                                     "User-Agent": "awesome-agent-dashboard-bridge"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


def claude_usage(creds_path: Path, fetch=_fetch) -> dict:
    """The limit windows of the Claude account signed in on this PC. Raises ValueError with a plain reason."""
    try:
        creds = json.loads(creds_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise ValueError("no Claude sign-in found on this PC (~/.claude/.credentials.json)") from None
    o = creds.get("claudeAiOauth") or {}
    token = o.get("accessToken")
    if not token:
        raise ValueError("no Claude sign-in token on this PC: sign in with Claude Code once")
    try:
        body = fetch(token)
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise ValueError("the Claude sign-in token is expired or refused: open Claude Code once so it refreshes") from None
        raise ValueError(f"Anthropic answered {e.code}") from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ValueError("Anthropic did not answer: is the PC online?") from None
    windows = []
    for key, label in WINDOWS:
        w = body.get(key)
        if isinstance(w, dict) and w.get("utilization") is not None:
            windows.append({"key": key, "label": label, "percent": float(w["utilization"]), "resetsAt": w.get("resets_at"),
                            "locked": w.get("locked_reason")})
    extra = body.get("extra_usage") or {}
    return {"windows": windows, "plan": o.get("subscriptionType"), "tier": o.get("rateLimitTier"),
            "extraUsage": bool(extra.get("is_enabled")), "checkedAt": now_iso()}


class UsageCheck:
    def __init__(self, counter: Counter | None, creds_path: Path):
        self.counter, self.creds_path = counter, creds_path

    def answer(self, body: dict) -> dict:
        what = body.get("what")
        if what == "claude":
            return claude_usage(self.creds_path)
        if what == "firestore":
            today = self.counter.today() if self.counter else {}
            return {"today": today, "freeTier": FREE_TIER, "checkedAt": now_iso(), "counted": self.counter is not None}
        raise ValueError("ask for claude or firestore")


def default_creds_path() -> Path:
    return Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude") / ".credentials.json"
