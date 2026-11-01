"""Starts, messages and stops Claude Code runs the owner asks for on the dashboard (P3 and the message box).

The page writes commands/<id> with action "start" (a registered folder and a prompt), "message" (a message to an
existing session) or "stop" (a run to end). The bridge on the named machine runs the owner's own `claude` CLI:

    start:    claude -p <prompt> --output-format json --session-id <new id> --permission-prompt-tool <inbox approve>
    message:  claude -p <message> --output-format json --resume <session> --permission-prompt-tool <inbox approve>

A session's state comes from its messages, not from a heartbeat (the owner's model, 2026-11-01: "the session not
sent or completed just count as closed ... when I start the message send then that session become open and wait til
EOB or the done token then the state become closed again"). A message waits ("waiting") while:

- a turn is running in the session: a run of this bridge works in it, or its log has no turn end yet (waitReason
  "turn"); it goes once the turn ends;
- the session is open in the app or a terminal (waitReason "app"): a second process would split the conversation, so
  the page points to Remote Control (the owner's choice "do 1 and 3"). Open is measured, not guessed (the owner's
  choice "do 3"): the desktop app runs one claude process per open session with --resume=<id>. A terminal started
  with plain `claude` shows no id, so a session last used in a terminal counts as open while a claude process without
  an id runs in its folder. When the process list can't be read, a session last used in a window counts as open.
  The owner can send it anyway (force) or cancel it on the page ("do 2 and 3"); a running turn always waits.

Rules from the plan: only folders registered in WORK_ROOTS, a fixed list of actions, the prompt goes to claude as one
argument (never through a shell), permissions stay on and every approval goes to the owner's inbox (no bypass mode),
ANTHROPIC_API_KEY is removed so the run uses the plan (terms T7).
"""

from __future__ import annotations

import json
import os
import re
import time
import signal
import subprocess
import uuid
from pathlib import Path

from .aggregate import work_type_of
from .inbox import now_iso
from .redact import redact

APPROVAL_TOOL = "mcp__agent-inbox__inbox_approve"
NO_CLI = "No signed-in claude CLI on this machine. Install Claude Code and sign in, or set CLAUDE_BIN."
SESSION_ARG = re.compile(r"^--(?:resume|session-id)(?:=(.+))?$")
SCAN_SECONDS = 3  # one process scan serves every waiting message and answer of one bridge round
TAIL_BYTES = 256 * 1024  # the end of a session log: enough for its last turn's closing lines
SKIP = {"queue-operation", "frame-link", "api-request", "api-request-shape", "api-request-blob", "attachment",
        "file-history-snapshot", "summary", "custom-title", "last-prompt"}  # lines that are not conversation turns


def last_turn(path: Path) -> tuple[bool, str, str]:
    """(a turn is still running, the entrypoint of the last turn, its folder) from the end of a session log. A turn ends with the
    assistant's end_turn, the stop hooks' summary, an interrupt, or a slash command's output."""
    with open(path, "rb") as f:
        f.seek(max(0, f.seek(0, 2) - TAIL_BYTES))
        lines = f.read().decode("utf-8", errors="replace").splitlines()
    for line in reversed(lines):
        try:
            d = json.loads(line)
        except ValueError:
            continue  # the cut first line, or a line still being written
        kind = d.get("type")
        if kind in SKIP or kind not in ("user", "assistant", "system"):
            continue
        entry, cwd = d.get("entrypoint") or "", d.get("cwd") or ""
        msg = d.get("message") or {}
        if kind == "system":
            if d.get("subtype") in ("stop_hook_summary", "turn_duration"):
                return False, entry, cwd
            continue
        if kind == "assistant":
            return msg.get("stop_reason") not in ("end_turn", "stop_sequence", "max_tokens", "refusal"), entry, cwd
        content = msg.get("content")
        text = content if isinstance(content, str) else " ".join(
            c.get("text", "") for c in content or [] if isinstance(c, dict))
        # an interrupt ends the turn; a slash command (/login, /model) writes lines but runs no turn
        return not text.lstrip().startswith(("[Request interrupted", "<local-command", "<command-")), entry, cwd
    return False, "", ""


def from_window(entry: str) -> bool:
    """The app, a terminal or an IDE; the bridge's own runs and SDK runs are sdk-*."""
    return bool(entry) and not entry.startswith("sdk")


_scan: tuple[float, list[tuple[str | None, str]] | None] = (0.0, None)


def claude_processes() -> list[tuple[str | None, str]] | None:
    """(session id or None, folder) of each Claude Code session process on this machine: the app's open sessions
    (--resume=<id>) and terminals. Leaves out headless runs (-p, the bridge's own) and the app's own Electron processes.
    None when the process list can't be read."""
    global _scan
    if time.monotonic() - _scan[0] < SCAN_SECONDS:
        return _scan[1]
    try:
        import psutil

        procs, helpers_of = [], set()
        for p in psutil.process_iter(["name"]):
            if not (p.info["name"] or "").lower().startswith("claude"):
                continue
            try:
                args = p.cmdline()
                if any(a.startswith("--type") for a in args):
                    helpers_of.add(p.ppid())  # an Electron helper: its parent is the app itself, not a session
                    continue
                procs.append((p.pid, args, p.cwd()))
            except psutil.Error:
                continue
        out = []
        for pid, args, cwd in procs:
            if pid in helpers_of or "-p" in args or "--print" in args:
                continue
            sid = None
            for i, a in enumerate(args):
                m = SESSION_ARG.match(a)
                if m:
                    sid = m.group(1) or (args[i + 1] if i + 1 < len(args) else None)
                    break
            out.append((sid, cwd))
    except Exception:
        out = None
    _scan = (time.monotonic(), out)
    return out


def _same_folder(a: str, b: str) -> bool:
    return bool(a and b) and os.path.normcase(os.path.normpath(a)) == os.path.normcase(os.path.normpath(b))


def log_wait_reason(logs: Path | None, session_id: str, force: bool = False, procs=claude_processes) -> str | None:
    """"turn" while a turn runs in the session, "app" while it is open in the app or a terminal (unless forced), else
    None. Used for messages (Runs) and for inbox answers (deliver.py)."""
    if logs and logs.is_dir():
        for f in logs.glob(f"*/{session_id}.jsonl"):
            running, entry, cwd = last_turn(f)
            if running:
                return "turn"
            if force:
                return None
            seen = procs()
            if seen is None:
                return "app" if from_window(entry) else None
            if any(sid == session_id for sid, _ in seen):
                return "app"
            if from_window(entry) and any(sid is None and _same_folder(c, cwd) for sid, c in seen):
                return "app"  # a terminal with no id in this session's folder may be this session
    return None


def start_command(claude: str, prompt: str, session_id: str) -> list[str]:
    return [claude, "-p", prompt, "--output-format", "json", "--session-id", session_id,
            "--permission-prompt-tool", APPROVAL_TOOL]


def message_command(claude: str, message: str, session_id: str) -> list[str]:
    return [claude, "-p", message, "--output-format", "json", "--resume", session_id,
            "--permission-prompt-tool", APPROVAL_TOOL]


def parse_result(out: str | None) -> dict:
    """claude's JSON result. An "is_error" result carries its message in "result", such as "Not logged in"."""
    try:
        r = json.loads(out or "{}")
    except ValueError:
        return {}
    return r if isinstance(r, dict) else {}


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
                 popen=subprocess.Popen, logs: Path | None = None, push=None, procs=claude_processes):
        self.store, self.machine, self.roots, self.claude, self.popen = store, machine, roots, claude, popen
        self.logs = logs  # Claude Code's log folder, to see whether a session wrote recently
        self.push = push  # a push.Pusher: tells the owner's phone when a run ended
        self.procs_seen = procs  # which sessions are open in the app or a terminal (injectable for tests)
        self.out_dir = out_dir  # each run's output goes to files, so a long run never blocks on a full pipe
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self.procs: dict[str, subprocess.Popen] = {}
        # "new" commands already acted on: a listener snapshot can lag behind our own write, never act twice
        self.acted: set[str] = set()

    def forget_lost(self) -> None:
        """On start: runs marked running by an earlier bridge on this machine can no longer be followed."""
        for c in self.store.where("commands", "status", "running"):
            if c.get("machine") == self.machine and c["id"] not in self.procs:
                self.store.update(f"commands/{c['id']}", {"status": "lost", "endedAt": now_iso(),
                                  "error": "The bridge restarted while this run was going; its result is in the session log."})

    def step(self, todo: list[dict] | None = None) -> list[str]:
        """Acts on the commands still to do. `todo` comes from the listener (listen.py); without it, ask Firestore."""
        log = []
        if todo is None:
            todo = self.store.where("commands", "status", "new") + self.store.where("commands", "status", "waiting")
        for c in todo:
            if c.get("machine") != self.machine:
                continue
            if c.get("status") == "new":
                if c["id"] in self.acted:
                    continue
                self.acted.add(c["id"])
            action = c.get("action")
            line = (self._start(c) if action == "start" else self._message(c) if action == "message"
                    else self._stop(c) if action == "stop" else self._unknown(c))
            if line:
                log.append(line)
        for cid, p in list(self.procs.items()):
            if p.poll() is not None:
                log.append(self._finish(cid, p))
        return log

    def _unknown(self, c: dict) -> str:
        self.store.update(f"commands/{c['id']}", {"status": "failed", "error": "Unknown action."})
        return f"{c['id']}: refused, unknown action"

    def _spawn(self, cid: str, cmd: list[str], cwd: str) -> subprocess.Popen:
        env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}
        extra = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True}
        with (
            open(self.out_dir / f"{cid}.out", "w", encoding="utf-8") as out,
            open(self.out_dir / f"{cid}.err", "w", encoding="utf-8") as err,
        ):
            p = self.popen(cmd, cwd=cwd, env=env, stdout=out, stderr=err, stdin=subprocess.DEVNULL, **extra)
        self.procs[cid] = p
        return p

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
            self.store.update(path, {"status": "failed", "error": NO_CLI})
            return f"{c['id']}: no claude CLI"
        sid = str(uuid.uuid4())
        p = self._spawn(c["id"], start_command(self.claude, prompt, sid), c["folder"])
        self.store.update(path, {"status": "running", "sessionId": sid, "workType": wt, "pid": p.pid, "startedAt": now_iso()})
        return f"{c['id']}: started session {sid} in {c['folder']}"

    def wait_reason(self, session_id: str, force: bool = False) -> str | None:
        """"turn", "app", or None when the message can go now."""
        for k in self.procs:
            if (self.store.get(f"commands/{k}") or {}).get("sessionId") == session_id:
                return "turn"  # a run of this bridge is working in it
        return log_wait_reason(self.logs, session_id, force, self.procs_seen)

    def _message(self, c: dict) -> str | None:
        path = f"commands/{c['id']}"
        sid, cwd, text = c.get("sessionId", ""), c.get("cwd", ""), (c.get("prompt") or "").strip()
        if not sid or not text:
            self.store.update(path, {"status": "failed", "error": "A message needs a session and some text."})
            return f"{c['id']}: refused, empty"
        wt = work_type_of(cwd, self.roots)
        if wt == "other" or not os.path.isdir(cwd):
            self.store.update(path, {"status": "failed",
                              "error": "The session's folder is not under a registered folder on this machine."})
            return f"{c['id']}: refused, folder not registered"
        if not self.claude:
            self.store.update(path, {"status": "failed", "error": NO_CLI})
            return f"{c['id']}: no claude CLI"
        why = self.wait_reason(sid, bool(c.get("force")))
        if why:
            if c.get("status") != "waiting" or c.get("waitReason") != why:
                self.store.update(path, {"status": "waiting", "waitReason": why, "workType": wt})
                return f"{c['id']}: session {sid} {'is in a turn' if why == 'turn' else 'was last used in a window'}, the message waits"
            return None
        p = self._spawn(c["id"], message_command(self.claude, text, sid), cwd)
        self.store.update(path, {"status": "running", "workType": wt, "pid": p.pid, "startedAt": now_iso()})
        return f"{c['id']}: sent to session {sid}"

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
        r = parse_result(out)
        if r.get("total_cost_usd") is not None:
            fields["costUsd"] = float(r["total_cost_usd"])
        if stopped:
            fields["status"] = "stopped"
        elif r.get("is_error"):
            # claude ran but reported an error: show its message, not the raw JSON
            fields["status"] = "failed"
            fields["error"] = redact(str(r.get("result") or r.get("terminal_reason") or "claude reported an error"), 800)
        elif p.returncode == 0:
            fields["status"] = "done"
            if r.get("result") is not None:
                fields["result"] = redact(str(r["result"]), 4000)
        else:
            fields["status"] = "failed"
            fields["error"] = redact(str(r.get("result") or (err or out or "")[-800:]), 800)
        self.store.update(f"commands/{cid}", fields)
        if self.push is not None and fields["status"] in ("done", "failed"):
            c = self.store.get(f"commands/{cid}") or {}
            first = (fields.get("result") or fields.get("error") or "").strip().split("\n")
            body = next((line for line in first if line.strip(" -")), "")[:160]
            what = "message" if c.get("action") == "message" else "run"
            self.push.notify(f"{what.capitalize()} {fields['status']}: {c.get('workType') or c.get('folder') or ''}".rstrip(": "),
                             body or "No text.", f"/?run={cid}", cid)
        return f"{cid}: {fields['status']}"
