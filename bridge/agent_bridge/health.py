"""The health panel's answer (plan 4672cf3d step i10): POST /health and POST /restart on the file viewer's port,
signed in as the owner, reached by the page through the owner's Cloudflare Tunnel.

The owner's choices, 2026-11-12: "Ping through the tunnel" (the page asks /health every 20 s while it is open, so a
stopped bridge shows red with 0 extra Firestore writes); "Task watchdog" (the Windows task fires every 1 min and starts
the bridge when it is not running, bridge/install-task.ps1); "Load new code" (Update shows the commit the bridge runs
and the repo's commit, and restarts to load it, no git pull). Restart and Update: "Confirm tap, owner only" (round 2):
the page asks once, the bridge checks the owner's sign-in, writes who and when to restarts.log and bridge.log, and
exits; the task starts it again (at once through a detached Start-ScheduledTask, else within 1 min by the watchdog).

Nothing here is stored in Firestore.
"""

from __future__ import annotations

import os
import re
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

TASK = "AgentDashboardBridge"
STAMP = re.compile(r"^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) (.*)$")
ERROR = re.compile(r"failed|error|traceback|exception", re.I)
TAIL_BYTES = 512 * 1024
ERROR_HOURS = 24


def _iso(t: float) -> str:
    return datetime.fromtimestamp(t, timezone.utc).isoformat(timespec="seconds")


def commit_of(repo: Path) -> str:
    """The repo's HEAD commit (short), read from .git without running git: HEAD, its ref file, else packed-refs."""
    g = repo / ".git"
    try:
        head = (g / "HEAD").read_text(encoding="utf-8").strip()
        if not head.startswith("ref: "):
            return head[:7]
        ref = head[5:]
        f = g / ref
        if f.is_file():
            return f.read_text(encoding="utf-8").strip()[:7]
        for line in (g / "packed-refs").read_text(encoding="utf-8").splitlines():
            if line.endswith(" " + ref):
                return line.split()[0][:7]
    except OSError:
        pass
    return ""


def log_errors(log: Path, now: float, hours: float = ERROR_HOURS, keep: int = 5) -> dict:
    """Lines of bridge.log from the last `hours` that say failed or error: their count and the newest `keep`."""
    try:
        with open(log, "rb") as f:
            f.seek(max(0, f.seek(0, 2) - TAIL_BYTES))
            text = f.read().decode("utf-8", "replace")
    except OSError:
        return {"count": 0, "last": [], "hours": hours}
    since = now - hours * 3600
    hits = []
    for line in text.splitlines():
        m = STAMP.match(line)
        if not m or not ERROR.search(m.group(2)):
            continue
        try:
            t = time.mktime(time.strptime(m.group(1), "%Y-%m-%d %H:%M:%S"))
        except ValueError:
            continue
        if t >= since:
            hits.append({"at": _iso(t), "line": m.group(2)[:300]})
    return {"count": len(hits), "last": hits[-keep:], "hours": hours}


class Health:
    def __init__(self, repo: Path, data: Path, machine: str, runs=None, clock=time.time, exit_fn=None, kick=None):
        self.repo, self.data, self.machine, self.runs, self.clock = repo, data, machine, runs, clock
        self.started = clock()
        self.commit = commit_of(repo)  # the code this process loaded
        self.last_sync = ""
        self.restart_asked: dict | None = None
        self.exit_fn = exit_fn or (lambda: os._exit(0))
        self.kick = kick if kick is not None else start_task_later

    def synced(self) -> None:
        self.last_sync = _iso(self.clock())

    def answer(self, body: dict | None = None) -> dict:
        now = self.clock()
        repo = commit_of(self.repo)
        going = len(getattr(self.runs, "procs", {}) or {}) if self.runs is not None else 0
        return {
            "alive": True, "machine": self.machine, "pid": os.getpid(), "startedAt": _iso(self.started),
            "uptimeSeconds": int(now - self.started), "runningCommit": self.commit, "repoCommit": repo,
            "newCode": bool(repo and self.commit and repo != self.commit), "lastSync": self.last_sync,
            "runsGoing": going, "errors": log_errors(self.data / "bridge.log", now),
            "lastRestart": last_restart(self.data / "restarts.log"), "at": _iso(now),
        }

    def restart(self, body: dict, who: str) -> dict:
        """One confirm tap on the page: body {"confirm": true, "why": "restart" or "update"}. Logs, answers, then exits
        on a short timer so the answer reaches the page first."""
        if body.get("confirm") is not True:
            raise ValueError("confirm the restart on the page")
        why = "update" if body.get("why") == "update" else "restart"
        at = _iso(self.clock())
        line = f"{at} {why} asked by {who} on the page; running {self.commit}, repo {commit_of(self.repo)}"
        with open(self.data / "restarts.log", "a", encoding="utf-8") as f:
            f.write(line + "\n")
        print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} health {line}", flush=True)
        self.restart_asked = {"at": at, "why": why}
        threading.Timer(1.5, self._go).start()
        return {"ok": True, "at": at, "why": why}

    def _go(self) -> None:
        try:
            self.kick()
        finally:
            self.exit_fn()


def last_restart(path: Path) -> str:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return ""
    return lines[-1] if lines else ""


def start_task_later(task: str = TASK, wait: int = 4) -> None:
    """A detached PowerShell waits until this process is gone, then starts the task, so the bridge is back in seconds.
    If Windows ends it with the task, the watchdog trigger (every 1 min) starts the bridge instead."""
    if os.name != "nt":
        return
    log = str(Path(os.environ.get("APPDATA", ".")) / "awesome-agent-dashboard" / "restarts.log")
    ps = (f"Start-Sleep -Seconds {wait}; $s = (Get-ScheduledTask -TaskName '{task}').State; "
          f"Start-ScheduledTask -TaskName '{task}'; "
          f"Add-Content -Path '{log}' -Value ((Get-Date).ToString('s') + ' kick: task was ' + $s + ', started')")
    flags = 0x00000008 | 0x00000200 | 0x01000000  # DETACHED_PROCESS, NEW_PROCESS_GROUP, BREAKAWAY_FROM_JOB
    for f in (flags, flags & ~0x01000000):  # breakaway is refused when the job does not allow it
        try:
            subprocess.Popen(["powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command", ps], creationflags=f,
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return
        except OSError:
            continue
