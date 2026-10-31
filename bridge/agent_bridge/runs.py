"""Starts and stops Claude Code runs the owner asks for on the dashboard (P3).

The page writes commands/<id> with action "start" (a registered folder and a prompt) or "stop" (a run to end). The
bridge on the named machine runs the owner's own `claude` CLI:

    claude -p <prompt> --output-format json --session-id <new id>
           --permission-prompt-tool mcp__agent-inbox__inbox_approve

Rules from the plan: only a folder registered in WORK_ROOTS, a fixed list of actions, the prompt goes to claude as one
argument (never through a shell), permissions stay on and every approval goes to the owner's inbox (no bypass mode),
ANTHROPIC_API_KEY is removed so the run uses the plan (terms T7).
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import uuid
from pathlib import Path

from .inbox import now_iso
from .redact import redact

APPROVAL_TOOL = "mcp__agent-inbox__inbox_approve"


def start_command(claude: str, prompt: str, session_id: str) -> list[str]:
    return [claude, "-p", prompt, "--output-format", "json", "--session-id", session_id,
            "--permission-prompt-tool", APPROVAL_TOOL]


def folder_ok(folder: str, roots: list[tuple[str, str]]) -> str | None:
    """The work type of folder when it is exactly a registered root, else None."""
    norm = folder.replace("\\", "/").rstrip("/").lower()
    for wt, root in roots:
        if root.replace("\\", "/").rstrip("/").lower() == norm:
            return wt
    return None


def _kill_tree(p: subprocess.Popen) -> None:
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True)
    else:
        os.killpg(p.pid, signal.SIGTERM)


class Runs:
    """The runs this bridge started, kept in memory while it lives."""

    def __init__(self, store, machine: str, roots: list[tuple[str, str]], claude: str | None, out_dir: Path,
                 popen=subprocess.Popen):
        self.store, self.machine, self.roots, self.claude, self.popen = store, machine, roots, claude, popen
        self.out_dir = out_dir  # each run's output goes to files, so a long run never blocks on a full pipe
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self.procs: dict[str, subprocess.Popen] = {}

    def forget_lost(self) -> None:
        """On start: runs marked running by an earlier bridge on this machine can no longer be followed."""
        for c in self.store.where("commands", "status", "running"):
            if c.get("machine") == self.machine and c["id"] not in self.procs:
                self.store.update(f"commands/{c['id']}", {"status": "lost", "endedAt": now_iso(),
                                  "error": "The bridge restarted while this run was going; its result is in the session log."})

    def step(self) -> list[str]:
        log = []
        for c in self.store.where("commands", "status", "new"):
            if c.get("machine") != self.machine:
                continue
            if c.get("action") == "start":
                log.append(self._start(c))
            elif c.get("action") == "stop":
                log.append(self._stop(c))
            else:
                self.store.update(f"commands/{c['id']}", {"status": "failed", "error": "Unknown action."})
        for cid, p in list(self.procs.items()):
            if p.poll() is not None:
                log.append(self._finish(cid, p))
        return log

    def _start(self, c: dict) -> str:
        path = f"commands/{c['id']}"
        wt = folder_ok(c.get("folder", ""), self.roots)
        prompt = (c.get("prompt") or "").strip()
        if not wt or not os.path.isdir(c["folder"]):
            self.store.update(path, {"status": "failed", "error": "Not a registered folder on this machine."})
            return f"{c['id']}: refused, folder not registered"
        if not prompt:
            self.store.update(path, {"status": "failed", "error": "Empty prompt."})
            return f"{c['id']}: refused, empty prompt"
        if not self.claude:
            self.store.update(path, {"status": "failed",
                              "error": "No signed-in claude CLI on this machine. Install Claude Code and sign in, or set CLAUDE_BIN."})
            return f"{c['id']}: no claude CLI"
        sid = str(uuid.uuid4())
        env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}
        extra = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True}
        with (
            open(self.out_dir / f"{c['id']}.out", "w", encoding="utf-8") as out,
            open(self.out_dir / f"{c['id']}.err", "w", encoding="utf-8") as err,
        ):
            p = self.popen(start_command(self.claude, prompt, sid), cwd=c["folder"], env=env, stdout=out, stderr=err,
                           stdin=subprocess.DEVNULL, **extra)
        self.procs[c["id"]] = p
        self.store.update(path, {"status": "running", "sessionId": sid, "workType": wt, "pid": p.pid, "startedAt": now_iso()})
        return f"{c['id']}: started session {sid} in {c['folder']}"

    def _stop(self, c: dict) -> str:
        target = c.get("target", "")
        p = self.procs.get(target)
        if p is None or p.poll() is not None:
            self.store.update(f"commands/{c['id']}", {"status": "failed", "error": "That run is not running on this machine."})
            return f"{c['id']}: nothing to stop"
        _kill_tree(p)
        self.store.update(f"commands/{target}", {"status": "stopping"})
        self.store.update(f"commands/{c['id']}", {"status": "done", "endedAt": now_iso()})
        return f"{c['id']}: stopped {target}"

    def _finish(self, cid: str, p: subprocess.Popen) -> str:
        del self.procs[cid]
        out = (self.out_dir / f"{cid}.out").read_text(encoding="utf-8", errors="replace")
        err = (self.out_dir / f"{cid}.err").read_text(encoding="utf-8", errors="replace")
        stopped = (self.store.get(f"commands/{cid}") or {}).get("status") == "stopping"
        fields = {"endedAt": now_iso(), "exitCode": p.returncode}
        try:
            r = json.loads(out or "{}")
        except ValueError:
            r = {}
        if isinstance(r, dict) and r.get("result") is not None:
            fields["result"] = redact(str(r["result"]), 4000)
        if isinstance(r, dict) and r.get("total_cost_usd") is not None:
            fields["costUsd"] = float(r["total_cost_usd"])
        if stopped:
            fields["status"] = "stopped"
        elif p.returncode == 0:
            fields["status"] = "done"
        else:
            fields["status"] = "failed"
            fields["error"] = redact((err or out or "")[-800:], 800)
        self.store.update(f"commands/{cid}", fields)
        return f"{cid}: {fields['status']}"
