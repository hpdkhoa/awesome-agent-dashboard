"""Starts, messages and stops Claude Code runs the owner asks for on the dashboard (P3 and the message box).

The page writes commands/<id> with action "start" (a registered folder and a prompt), "message" (a message to an
existing session), "plan" (a plan from a session's real record, planfrom.py) or "stop" (a run to end). The bridge on the named machine runs the owner's own `claude` CLI:

    start:    claude -p <prompt> <STREAM> --session-id <new id> --permission-prompt-tool <inbox approve>
    message:  claude -p <message> <STREAM> --resume <session> --permission-prompt-tool <inbox approve>

STREAM is `--output-format stream-json --verbose --include-partial-messages` (step i3, the owner's choice,
2026-11-12: "Token stream"): the .out file grows while the run works, so the page shows the running turn
(texts.live); its last line is claude's result, the same object `--output-format json` writes (parse_result).

Both add `--permission-mode auto` when the owner's one setting, meta/runs permissionMode, says "auto" (the owner's
choice, 2026-11-02: "do 1 but it is one setting use for all kinds not set every run"). It covers every kind of run:
starts, plan starts, messages and delivered answers. Auto lets Claude Code's safety check decide most approvals; the
inbox stays the fallback when the check pauses or an ask rule applies. Any other value is Manual: every approval goes to
the inbox. There is no bypass mode.

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

An owner's answer that the session did not take live comes here too, as a message with inboxId (deliver.py): it gets
the same wait rule, approvals in the inbox, a push when it ends, and a row in Runs; its outcome is written back on the
inbox item (the owner's choice, 2026-11-02: "build the fix", so a plan stays one session).

Rules from the plan: only folders registered in WORK_ROOTS, a fixed list of actions, the prompt goes to claude as one
argument (never through a shell), permissions stay on: in Manual every approval goes to the owner's inbox, in Auto the
safety check decides first and the inbox is the fallback (never bypass mode),
ANTHROPIC_API_KEY is removed so the run uses the plan (terms T7).

A run cut by the usage limit is "paused", not failed (the owner's words, 2026-11-09: "I need the continue button inside
run tab and session tab to do the leftover work manually"; choice "Continue + auto at reset", note "auto only the last
or the message I choose to auto restart when limit lifted"). "continue" (target) makes the leftover run: a plan from a
session again (its finished pages are kept, _earlier_notes), or a message to the run's session that goes on from where
it stopped. At the reset time the bridge continues by itself only the run that paused last, plus every paused run the
owner marked with "auto_continue" (target, on).
"""

from __future__ import annotations

import json
import os
import shutil
import re
import time
from datetime import datetime, timedelta, timezone
import signal
import subprocess
import threading
import uuid
from pathlib import Path

from .aggregate import work_type_of
from .archiver import Archiver
from .handoff import CHOICES, DEFAULT_FRESH_OVER, handoff_prompt, last_context, should_fresh
from .digest import find_log, write_pages
from .logs import window_cost
from .inbox import KINDS, PLAN_FORMAT, format_of, now_iso
from .chain import Chains
from .stepcheck import StepChecks
from .planfrom import NO_EDITS, mark_quotes, note_command, plan_prompt, scoped, system_args
from .redact import redact

APPROVAL_TOOL = "mcp__agent-inbox__inbox_approve"
STREAM = ["--output-format", "stream-json", "--verbose", "--include-partial-messages"]
NOTE_SECONDS = 20 * 60  # one page's notes
NO_CLI = "No signed-in claude CLI on this machine. Install Claude Code and sign in, or set CLAUDE_BIN."
SESSION_ARG = re.compile(r"^--(?:resume|session-id)(?:=(.+))?$")
LIMIT_MARGIN = 120  # seconds after the reset time before an auto continue, so the limit is surely lifted
CONTINUE_NOTE = ("The last run of this message stopped at the usage limit. Go on with the leftover work from where it "
                 "stopped; do not redo what is already done. The message was:\n\n")
MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
RESETS = re.compile(r"resets\s+(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)", re.I)
CLOSE_PUSH_SECONDS = 180  # i9: a message waiting this long for a session open in the app pushes the owner once
SCAN_SECONDS = 3 # one process scan serves every waiting message and answer of one bridge round
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


def session_status(logs: Path | None, session_id: str) -> dict:
    """What the wait rule sees for one session, for the page's "Check now" (the owner's choice, 2026-11-02: "do both"):
    whether a turn runs, where the last turn came from, and since when the app or a terminal has it open."""
    out = {"turn": False, "lastFrom": "", "open": False, "openSince": None, "openIn": None}
    if logs and logs.is_dir():
        for f in logs.glob(f"*/{session_id}.jsonl"):
            out["turn"], out["lastFrom"], cwd = last_turn(f)
            break
        else:
            cwd = ""
    else:
        cwd = ""
    try:
        import psutil

        for p in psutil.process_iter(["name", "create_time"]):
            if not (p.info["name"] or "").lower().startswith("claude"):
                continue
            try:
                args = p.cmdline()
            except psutil.Error:
                continue
            if any(a.startswith("--type") for a in args) or "-p" in args or "--print" in args:
                continue
            sid = next((m.group(1) or (args[i + 1] if i + 1 < len(args) else None)
                        for i, a in enumerate(args) if (m := SESSION_ARG.match(a))), None)
            if sid == session_id:
                where = "app"
            elif sid is None and from_window(out["lastFrom"]) and _same_folder(_cwd(p), cwd):
                where = "terminal"
            else:
                continue
            since = datetime.fromtimestamp(p.info["create_time"], timezone.utc).isoformat()
            if not out["open"] or since < out["openSince"]:
                out.update(open=True, openSince=since, openIn=where)
    except Exception:
        out["open"] = None  # the process list could not be read
    if out["open"] is False:
        out["turn"] = False  # no process holds the session: a log with no turn end is a turn cut off
    return out


def _cwd(p) -> str:
    try:
        return p.cwd()
    except Exception:
        return ""


def _same_folder(a: str, b: str) -> bool:
    return bool(a and b) and os.path.normcase(os.path.normpath(a)) == os.path.normcase(os.path.normpath(b))


def log_wait_reason(logs: Path | None, session_id: str, force: bool = False, procs=claude_processes) -> str | None:
    """"turn" while a turn runs in the session, "app" while it is open in the app or a terminal (unless forced), else
    None. Used for messages (Runs) and for inbox answers (deliver.py)."""
    if logs and logs.is_dir():
        for f in logs.glob(f"*/{session_id}.jsonl"):
            running, entry, cwd = last_turn(f)
            seen = procs()
            held = seen is None or any(sid == session_id for sid, _ in seen) or (
                from_window(entry) and any(sid is None and _same_folder(c, cwd) for sid, c in seen))
            if running and held:
                return "turn"  # a log with no turn end and no process holding the session is a turn cut off
            if force:
                return None
            if seen is None:
                return "app" if from_window(entry) else None
            if held:
                return "app"  # the app runs it, or a terminal with no id in this session's folder may be it
    return None


EFFORTS = ("low", "medium", "high", "xhigh", "max")
# Exact models and efforts, never the CLI's own default (the owner's words, 2026-11-10: "I don't want default option I
# want exact option"; picks: claude-opus-5-5 and medium when nothing else is set). An older alias maps to its exact id.
MODELS = ("claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5")
ALIASES = {"fable": "claude-fable-5-1", "opus": "claude-opus-5-5", "sonnet": "claude-sonnet-5-5", "haiku": "claude-haiku-5-5"}
DEFAULT_MODEL, DEFAULT_EFFORT = "claude-opus-5-5", "medium"
MODEL_RE = re.compile(r"^[a-z][a-z0-9.\-]{1,60}$")  # an alias (fable, opus, sonnet, haiku) or a full model name


def model_args(model: str = "", effort: str = "") -> list[str]:
    """--model and --effort for a run (the owner's words, 2026-11-10: "I don't have any choice to select model and
    effort add it"). Empty means the CLI's own default; anything not a model name or effort level is dropped."""
    out: list[str] = []
    if model and MODEL_RE.match(model):
        out += ["--model", model]
    if effort in EFFORTS:
        out += ["--effort", effort]
    return out


def mode_args(mode: str) -> list[str]:
    """Only "auto" changes the mode; anything else stays Manual. Bypass is never passed."""
    return ["--permission-mode", "auto"] if mode == "auto" else []


def start_command(claude: str, prompt: str, session_id: str, mode: str = "manual", model: str = "", effort: str = "",
                  keep: bool = True, kind: str = "", step: str = "") -> list[str]:
    """keep=False: a one-off job whose session is never saved (--no-session-persistence), so it leaves no log and no
    session on the dashboard (the owner's words, 2026-11-10: "A "don't keep the session" tick on Start")."""
    return [claude, "-p", scoped(prompt, kind, step), *STREAM, "--session-id", session_id,
            "--permission-prompt-tool", APPROVAL_TOOL, *mode_args(mode), *model_args(model, effort),
            *([] if keep else ["--no-session-persistence"]), *system_args(kind, step)]


# Generated files (the owner's choice, 2026-11-04: "use The project folder and add .gitignore"; approved: named by
# plan id, never overwritten inside a version, kept when a plan is deleted): <project>/.plan_data/<plan id>/v<n>/.
PLAN_DATA = ".plan_data/"


def ensure_plan_data_ignored(cwd: str) -> bool:
    """Adds .plan_data/ to the project's .gitignore when the folder is in a git work tree and the line is missing.
    Only appends a line; returns whether it wrote."""
    folder = Path(cwd)
    if not any((d / ".git").exists() for d in (folder, *folder.parents)):
        return False
    gi = folder / ".gitignore"
    old = gi.read_text(encoding="utf-8", errors="replace") if gi.exists() else ""
    if any(line.strip() in (PLAN_DATA, PLAN_DATA.rstrip("/"), "/" + PLAN_DATA) for line in old.splitlines()):
        return False
    sep = "" if not old or old.endswith("\n") else "\n"
    note = "# Files a plan's Generate makes (agent dashboard), one folder per plan version"
    with gi.open("a", encoding="utf-8") as f:  # appends only: the lines already there are never rewritten
        f.write(f"{sep}\n{note}\n{PLAN_DATA}\n")
    return True


def message_command(claude: str, message: str, session_id: str, mode: str = "manual", kind: str = "",
                    step: str = "", model: str = "", effort: str = "") -> list[str]:
    """kind: a plan message's kind (qa, goal, step, rule, lesson); step: a Run step's step id. Either goes as an
    appended system prompt; a Run step has no kind."""
    return [claude, "-p", scoped(message, kind, step), *STREAM, "--resume", session_id,
            "--permission-prompt-tool", APPROVAL_TOOL, *mode_args(mode), *system_args(kind, step),
            *model_args(model, effort)]


GEN_KINDS = ("mockup", "diagram", "image", "chart", "screenshot", "data", "docs")  # web/src/planCheck.ts KINDS, and docs
GEN_BY_EXT = {".png": "image", ".jpg": "image", ".jpeg": "image", ".svg": "image", ".webp": "image", ".gif": "image",
              ".csv": "data", ".json": "data", ".html": "mockup", ".htm": "mockup", ".md": "docs"}


def generated_kind(name: str) -> str:
    """A generated file's kind: its name's first word when that is a kind (mockup-x.png), else by its type (a numbered
    picture in a subfolder, 1-plans-board-PASS.png, is an image)."""
    first = name.split("-", 1)[0].lower()
    return first if first in GEN_KINDS else GEN_BY_EXT.get(os.path.splitext(name)[1].lower(), "file")


class _Ended:
    """Stands in for the process of a run whose output file is complete but whose process an earlier bridge owned."""

    def __init__(self, returncode: int):
        self.returncode = returncode

    def poll(self):
        return self.returncode


class _Adopted:
    """Stands in for the process of a run an earlier bridge started that still lives (step i10, the owner's choice,
    2026-11-12: "Adopt live runs"). A restart used to mark it lost, and the plan chain then sent the same step again
    into the same session: 3 claude processes on one session at once, measured 11:49 to 11:51."""

    def __init__(self, proc):
        self.proc, self.pid, self.returncode = proc, proc.pid, None

    def poll(self):
        if self.returncode is None:
            try:
                code = self.proc.wait(timeout=0)
                self.returncode = 0 if code is None else code
            except Exception as e:  # psutil.TimeoutExpired: still running
                if type(e).__name__ != "TimeoutExpired":
                    self.returncode = 1
        return self.returncode


def live_claude(pid, started: str, slack: float = 120.0):
    """The claude process a run's pid names, if it still lives and is that run's own (a claude program created within
    `slack` seconds of the run's startedAt, so a reused pid is never taken). None otherwise."""
    if not pid or not started:
        return None
    try:
        import psutil

        p = psutil.Process(int(pid))
        t = datetime.fromisoformat(started.replace("Z", "+00:00")).timestamp()
        if "claude" in p.name().lower() and abs(p.create_time() - t) <= slack and p.is_running():
            return p
    except Exception:
        return None
    return None


class _Adopted:
    """Stands in for the process of a run an earlier bridge started that still lives (step i10, the owner's choice,
    2026-11-12: "Adopt live runs"). A restart used to mark it lost, and the plan chain then sent the same step again
    into the same session: 3 claude processes on one session at once, measured 11:49 to 11:51."""

    def __init__(self, proc):
        self.proc, self.pid, self.returncode = proc, proc.pid, None

    def poll(self):
        if self.returncode is None:
            try:
                code = self.proc.wait(timeout=0)
                self.returncode = 0 if code is None else code
            except Exception as e:  # psutil.TimeoutExpired: still running
                if type(e).__name__ != "TimeoutExpired":
                    self.returncode = 1
        return self.returncode


def live_claude(pid, started: str, slack: float = 120.0):
    """The claude process a run's pid names, if it still lives and is that run's own (a claude program created within
    `slack` seconds of the run's startedAt, so a reused pid is never taken). None otherwise."""
    if not pid or not started:
        return None
    try:
        import psutil

        p = psutil.Process(int(pid))
        t = datetime.fromisoformat(started.replace("Z", "+00:00")).timestamp()
        if "claude" in p.name().lower() and abs(p.create_time() - t) <= slack and p.is_running():
            return p
    except Exception:
        return None
    return None


def parse_result(out: str | None) -> dict:
    """claude's JSON result. An "is_error" result carries its message in "result", such as "Not logged in".
    A stream .out (STREAM, step i3) holds one event per line: its result is the last line of type "result"; a run
    still working has none yet ({})."""
    try:
        r = json.loads(out or "{}")
    except ValueError:
        r = None
        for line in reversed((out or "").splitlines()):
            if '"type":"result"' in line.replace(" ", ""):
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if isinstance(r, dict) and r.get("type") == "result":
                    break
                r = None
        if r is None:
            return {}
    if isinstance(r, dict) and r.get("type") not in (None, "result"):  # a stream .out with one event line so far
        return {}
    return r if isinstance(r, dict) else {}


def run_cost(logs: Path | None, r: dict, c: dict, ended: str, finished: str = "") -> dict:
    """The run's own cost: its messages in the session log between startedAt and its end (logs.window_cost).
    claude's total_cost_usd is the session's running total on a resume (step i1, 2026-11-12: run f2069f82 said
    $1,182.04 for a 2.5-min message; its own messages cost $2.94, the same as the rise of that total since the run
    before it). claude's figure is kept only for a fresh run with no log (a one-off Start keeps no session); a
    message with no log gets no cost rather than a wrong one.
    finished: when claude wrote its result (the .out file's time). The window ends at the earlier of `ended` and
    finished + 5 s: an end written late (run 18442aa6 kept "running" 9 h behind a 429 write) would take in the
    session's later runs. claude's duration_ms is no end: a 22-min run (b0774266) reported 3 s."""
    start = c.get("startedAt") or ""
    if finished:
        try:
            cap = datetime.fromisoformat(finished.replace("Z", "+00:00")) + timedelta(seconds=5)
            ended = min(cap, datetime.fromisoformat(ended.replace("Z", "+00:00"))).isoformat()
        except (ValueError, TypeError):
            pass
    w = window_cost(logs, r.get("session_id") or c.get("sessionId") or "", start, ended)
    if w is not None:
        return {"costUsd": w["costUsd"], "costFrom": "log"}
    if r.get("total_cost_usd") is not None and c.get("action") != "message":
        return {"costUsd": float(r["total_cost_usd"]), "costFrom": "claude"}
    return {}


def reset_time(text: str, after: datetime) -> datetime | None:
    """When the usage limit lifts, from claude's message ("resets 5:30pm (Asia/Ho_Chi_Minh)", or with a date "resets
    Nov 10, 5:30pm"): the first such time after `after`. Claude Code writes it in this PC's own time zone, the zone the
    bridge runs in, so it is read as local time (no time zone data needed). None when the message has no time."""
    m = RESETS.search(text or "")
    if not m:
        return None
    mon, day, h, mi, ap = m.groups()
    hour, minute = int(h) % 12 + (12 if ap.lower() == "pm" else 0), int(mi or 0)
    local = after.astimezone()
    try:
        if mon:
            t = local.replace(month=MONTHS.index(mon.lower()) + 1, day=int(day), hour=hour, minute=minute, second=0,
                              microsecond=0)
            return t if t >= local - timedelta(days=1) else t.replace(year=t.year + 1)
        t = local.replace(hour=hour, minute=minute, second=0, microsecond=0)
    except ValueError:  # a month name or a day that is not real
        return None
    return t if t > local else t + timedelta(days=1)


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
        self.archiver = Archiver(out_dir / "archiver")  # archiver.py: frees a session open in the app; the same
        # folder as the archiver tools in inbox.py (data_dir()/runs/archiver)
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self.procs: dict[str, subprocess.Popen] = {}
        # p16 (the owner's pick, 2026-11-12: "Add step: read once, then listen"): while a message waits for its
        # session's turn, the 5 s step asked Firestore each time for the running run's session and for meta/runs
        # (406 reads in 21 min, measured). Each running run's session is now read once and kept here; meta/runs comes
        # from a listen (prefs_feed, set by cli.py), read once only until the listen's first answer.
        self.sid_of: dict[str, str] = {}
        self.prefs_feed = None  # listen.QueryFeed on meta/runs; None = read the document
        # "new" commands already acted on: a listener snapshot can lag behind our own write, never act twice
        self.acted: set[str] = set()
        self.reading: dict[str, dict] = {}  # plan commands still reading pages: {"proc": the page run, "stop": bool}
        # paused runs to continue at the reset: {run id: {"due": epoch seconds, "by": "last" | "owner"}}; read from the
        # store once on the first step, so a bridge restart keeps them
        self.auto: dict[str, dict] | None = None
        self.auto_lock = threading.Lock()  # a plan pauses from its reading thread
        self.chains = Chains(store, machine, push)  # chain.py: Run all steps, one step after another
        # step i8: the ticked check command of a step, run by the bridge (stepcheck.py); roots is the same list as
        # self.roots, so a folder added on the page counts at once
        self.checks = StepChecks(store, machine, self.roots, self.chains, push)
        # step i4: a work folder added on the page joins self.roots in place (the same list the sync and the inbox
        # read); on_roots tells the others that keep their own copy (the file viewer); env_path is where WORK_ROOTS lives
        self.on_roots: list = []
        self.budget = None  # budget.Budget (step i5): set by cli.py; None = no guard (tests, dry runs)
        self.env_path: Path | None = None

    def forget_lost(self) -> list[str]:
        """On start: runs an earlier bridge on this machine left running. One whose .out already holds claude's
        complete result is finished from that file as if its process had just ended (the owner's choice, 2026-11-08:
        "Finish from the .out file"); the rest can no longer be followed and are lost. Also reads the paused runs that
        continue by themselves at the reset, and the Run all steps chains left on."""
        log = [f"{k}: continues by itself at the reset" for k in self._auto_runs()]
        for c in self.store.where("commands", "status", "running"):
            if c.get("machine") != self.machine or c["id"] in self.procs:
                continue
            out = self.out_dir / f"{c['id']}.out"
            r = parse_result(out.read_text(encoding="utf-8", errors="replace")) if out.is_file() else {}
            if r.get("result") is not None or r.get("is_error"):
                self.procs[c["id"]] = _Ended(1 if r.get("is_error") else 0)
                log.append(self._finish(c["id"], self.procs[c["id"]]) + " (finished from its .out after a bridge restart)")
                continue
            live = live_claude(c.get("pid"), c.get("startedAt", "")) if c.get("action") in ("start", "message") else None
            if live is not None:  # i10: keep following it; it ends through _finish like a run this bridge started
                self.procs[c["id"]] = _Adopted(live)
                if c.get("sessionId"):
                    self.sid_of[c["id"]] = c["sessionId"]
                log.append(f"{c['id']}: still running after a bridge restart (pid {live.pid}), followed again")
                continue
            live = live_claude(c.get("pid"), c.get("startedAt", "")) if c.get("action") in ("start", "message") else None
            if live is not None:  # i10: keep following it; it ends through _finish like a run this bridge started
                self.procs[c["id"]] = _Adopted(live)
                if c.get("sessionId"):
                    self.sid_of[c["id"]] = c["sessionId"]
                log.append(f"{c['id']}: still running after a bridge restart (pid {live.pid}), followed again")
                continue
            error = "The bridge restarted while this run was going; its result is in the session log."
            self.store.update(f"commands/{c['id']}", {"status": "lost", "endedAt": now_iso(), "error": error})
            self._answer_back(c, {"status": "answered", "error": error})
            log.append(f"{c['id']}: lost to a bridge restart")
        return log + self.chains.resume()  # chain.py: a chain left on goes on with the steps not done

    def _answer_back(self, c: dict, fields: dict) -> None:
        """Writes a delivered answer's outcome on its inbox item."""
        if c.get("inboxId"):
            self.store.update(f"inbox/{c['inboxId']}", fields)

    def prefs(self) -> dict:
        """meta/runs, the owner's run settings: from the listen once it answered, else read once now (p16)."""
        rows = self.prefs_feed.current() if self.prefs_feed is not None else None
        if rows is not None:
            return dict(rows[0]) if rows else {}
        return self.store.get("meta/runs") or {}

    def mode(self) -> str:
        """The owner's one setting for every run, read when a run starts: "auto" or "manual"."""
        return "auto" if self.prefs().get("permissionMode") == "auto" else "manual"

    def run_with(self, c: dict) -> tuple[str, str]:
        """(model, effort) for a run, always exact: the run's own choice, else the owner's setting in meta/runs, else
        claude-opus-5-5 and medium (the owner's picks, 2026-11-10: "Setting plus a choice on each message"; "I want exact
        option"). A name that is not one of MODELS, or an effort not in EFFORTS, falls to the next in that order."""
        prefs = self.prefs()
        exact = lambda m: ALIASES.get(str(m or ""), str(m or ""))
        model = next((m for m in (exact(c.get("model")), exact(prefs.get("model"))) if m in MODELS), DEFAULT_MODEL)
        effort = next((e for e in (c.get("effort"), prefs.get("effort")) if e in EFFORTS), DEFAULT_EFFORT)
        return model, effort

    def step(self, todo: list[dict] | None = None) -> list[str]:
        """Acts on the commands still to do. `todo` comes from the listener (listen.py); without it, ask Firestore."""
        log = self._archiver_reports()
        if todo is None:
            todo = self.store.where("commands", "status", "new") + self.store.where("commands", "status", "waiting")
        # oldest first: Firestore returns them by document id, so two messages to one session could flip (the owner's
        # choice, 2026-11-02: "do 1": sort by the time sent)
        for c in sorted(todo, key=lambda c: c.get("createdAt") or ""):
            if c.get("machine") != self.machine:
                continue
            if c.get("status") == "new":
                if c["id"] in self.acted:
                    continue
                self.acted.add(c["id"])
            action = c.get("action")
            line = (self._start(c) if action == "start" else self._message(c) if action == "message"
                    else self._stop(c) if action == "stop" else self._check(c) if action == "check"
                    else self._plan(c) if action == "plan" else self._approve_generated(c) if action == "approve_generated"
                    else self._delete_plan_files(c) if action == "delete_plan_files"
                    else self.chains.start(c) if action == "chain"
                    else self.checks.start(c) if action == "step_check"
                    else self._add_root(c) if action == "add_root"
                    else self._continue(c) if action == "continue" else self._auto_continue(c) if action == "auto_continue"
                    else self._unknown(c))
            if line:
                log.append(line)
        for cid, p in list(self.procs.items()):
            if p.poll() is not None:
                log.append(self._finish(cid, p))
        log += self._archiver_freed()
        log += self._continue_due()
        return log

    def _auto_runs(self) -> dict[str, dict]:
        """The auto continues; on the first call, read from this machine's paused runs in the store."""
        with self.auto_lock:
            if self.auto is None:
                self.auto = {}
                for c in self.store.where("commands", "status", "paused"):
                    at = c.get("pausedUntilAt")
                    if c.get("machine") == self.machine and c.get("autoContinue") and at and not c.get("continuedBy"):
                        try:
                            self.auto[c["id"]] = {"due": datetime.fromisoformat(at).timestamp() + LIMIT_MARGIN,
                                                  "by": c.get("autoBy") or "last"}
                        except ValueError:
                            pass
            return self.auto

    def _pause(self, cid: str, res: dict, stage: str | None = None, at: datetime | None = None) -> None:
        """A run cut by the usage limit: paused, with the reset time. It becomes the one "last" auto continue; an
        earlier "last" one stops being auto, the owner's own picks stay (the owner's note, 2026-11-09: "auto only the
        last or the message I choose to auto restart when limit lifted")."""
        text = str(res.get("result") or "")
        at = at or reset_time(text, datetime.now(timezone.utc))
        auto = self._auto_runs()
        with self.auto_lock:
            for k in [k for k, a in auto.items() if a["by"] == "last"]:
                del auto[k]
                self.store.update(f"commands/{k}", {"autoContinue": False, "autoBy": None})
            if at is not None:
                auto[cid] = {"due": at.timestamp() + LIMIT_MARGIN, "by": "last"}
        fields = {"status": "paused", "endedAt": now_iso(), "error": redact(text, 300),
                  "pausedUntil": text.partition("resets ")[2].strip() or (at.astimezone().strftime("%H:%M") if at else "the usage limit resets"),
                  "pausedUntilAt": at.isoformat() if at else None,
                  "autoContinue": at is not None, "autoBy": "last" if at else None}
        if stage:
            fields["stage"] = stage
        self.store.update(f"commands/{cid}", fields)

    def continue_run(self, target: str) -> tuple[str | None, str]:
        """The leftover run of a paused run (or a failed plan from a session): (the new command's id, a log line or
        why not). A plan goes again from its session and keeps the finished pages; a start or a message goes on in
        its session; a start whose session never got a log starts again."""
        old = self.store.get(f"commands/{target}") or {}
        act, status = old.get("action"), old.get("status")
        why = ("No such run." if not old else "That run is on another machine." if old.get("machine") != self.machine
               else f"Already continued as run {old['continuedBy']}." if old.get("continuedBy")
               else "" if status == "paused" or (act == "plan" and status == "failed")
               else f"Only a paused run can continue (this one is {status}).")
        if why:
            return None, why
        nid = uuid.uuid4().hex[:20]
        prompt = str(old.get("prompt") or "")
        if act == "plan":
            new = {"action": "plan", **{k: old[k] for k in ("sourceSessionId", "cwd", "goal", "upgradeOf") if k in old},
                   "prompt": prompt if prompt.startswith("Plan from session") else "Plan from session (continued)"}
        elif act == "start" and (not old.get("sessionId") or find_log(self.logs, old["sessionId"]) is None):
            new = {"action": "start", "folder": old.get("folder", ""), "prompt": prompt}
        else:
            new = {"action": "message", "sessionId": old.get("sessionId", ""), "cwd": old.get("cwd") or old.get("folder", ""),
                   "prompt": prompt if prompt.startswith(CONTINUE_NOTE) else CONTINUE_NOTE + prompt,
                   **{k: old[k] for k in ("kind", "planId", "stepId", "inboxId", "ownerText", "generate", "planCheck",
                                          "phaseOrder", "chain") if k in old}}
        self.store.put_many({f"commands/{nid}": {"id": nid, "machine": self.machine, "status": "new",
                                                 "createdAt": now_iso(), "continueOf": target, **new}})
        with self.auto_lock:
            (self.auto or {}).pop(target, None)
        self.store.update(f"commands/{target}", {"continuedBy": nid, "autoContinue": False, "autoBy": None})
        return nid, f"{target}: continued as {nid}"

    def _continue(self, c: dict) -> str:
        """The Continue button on a run."""
        nid, line = self.continue_run(c.get("target", ""))
        self.store.update(f"commands/{c['id']}", {"status": "done" if nid else "failed", "endedAt": now_iso(),
                                                  **({"continuedAs": nid} if nid else {"error": line})})
        return line if nid else f"{c['id']}: refused, {line}"

    def _auto_continue(self, c: dict) -> str:
        """The owner's pick: continue this paused run at the reset (on), or not (off)."""
        path, target, on = f"commands/{c['id']}", c.get("target", ""), bool(c.get("on"))
        old = self.store.get(f"commands/{target}") or {}
        try:
            at = datetime.fromisoformat(old["pausedUntilAt"]) if old.get("pausedUntilAt") else None
        except ValueError:
            at = None
        why = ("Only a paused run of this machine can continue at the reset." if old.get("status") != "paused"
               or old.get("machine") != self.machine or old.get("continuedBy")
               else "The reset time is unknown: use Continue after the limit lifts." if on and at is None else "")
        if why:
            self.store.update(path, {"status": "failed", "endedAt": now_iso(), "error": why})
            return f"{c['id']}: refused, {why}"
        auto = self._auto_runs()
        with self.auto_lock:
            if on:
                auto[target] = {"due": at.timestamp() + LIMIT_MARGIN, "by": "owner"}
            else:
                auto.pop(target, None)
        self.store.update(f"commands/{target}", {"autoContinue": on, "autoBy": "owner" if on else None})
        self.store.update(path, {"status": "done", "endedAt": now_iso()})
        return f"{c['id']}: {target} {'continues' if on else 'does not continue'} at the reset"

    def _continue_due(self) -> list[str]:
        """Continues the auto runs whose reset time has passed. No store query here: the list is read on the bridge's
        start (forget_lost) or on the first pause."""
        auto, now = self.auto or {}, time.time()
        with self.auto_lock:
            due = [k for k, a in auto.items() if a["due"] <= now]
            for k in due:
                del auto[k]
        log = []
        for k in due:
            nid, line = self.continue_run(k)
            log.append(line + " (auto at the reset)" if nid else f"{k}: no auto continue, {line}")
        return log

    def _add_root(self, c: dict) -> str:
        """A work folder added on the page (step i4, the owner's choice, 2026-11-12: "Bridge checks"): checked
        (config.root_refusal), then usable at once with no restart: the folder list in memory, WORK_ROOTS in .env, the
        file viewer and the machine's folder list on the page."""
        from .config import root_refusal, save_roots

        path, name, folder = f"commands/{c['id']}", str(c.get("name") or "").strip(), str(c.get("folder") or "").strip()
        why = root_refusal(name, folder, self.roots)
        if why:
            self.store.update(path, {"status": "failed", "endedAt": now_iso(), "error": why})
            return f"{c['id']}: refused work folder {folder!r}, {why}"
        full = os.path.realpath(folder)
        save_roots([*self.roots, (name, full)], self.env_path)  # .env first: a failed write adds nothing
        self.roots.append((name, full))
        for f in self.on_roots:
            f(self.roots)
        self.store.update(f"machines/{self.machine}", {"folders": [{"workType": w, "path": r} for w, r in self.roots]})
        self.store.update(path, {"status": "done", "endedAt": now_iso(), "workType": name, "folder": full})
        return f"{c['id']}: work folder {name} = {full} added, no restart"

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
        sid, mode = str(uuid.uuid4()), self.mode()
        model, effort = self.run_with(c)
        keep = not c.get("noSession")
        p = self._spawn(c["id"], start_command(self.claude, prompt, sid, mode, model, effort, keep), c["folder"])
        self.store.update(path, {"status": "running", "sessionId": sid, "workType": wt, "pid": p.pid,
                                 "startedAt": now_iso(), "permissionMode": mode, "model": model, "effort": effort})
        return f"{c['id']}: started {'one-off (not kept) ' if not keep else ''}session {sid} in {c['folder']}"

    def wait_reason(self, session_id: str, force: bool = False) -> str | None:
        """"turn", "app", or None when the message can go now."""
        for k, p in list(self.procs.items()):
            if p.poll() is None and self._session_of(k) == session_id:
                return "turn"  # a run of this bridge is working in it
        return log_wait_reason(self.logs, session_id, force, self.procs_seen)

    def _session_of(self, cid: str) -> str:
        """The session a running run works in: read once from its command, then kept until the run ends (p16)."""
        if cid not in self.sid_of:
            sid = (self.store.get(f"commands/{cid}") or {}).get("sessionId") or ""
            if not sid:
                return ""  # not written yet: asked again next time
            self.sid_of[cid] = sid
        return self.sid_of[cid]

    def _upgrade_first(self, c: dict) -> tuple[bool, str | None]:
        """A message on a plan in an older format (its format number below PLAN_FORMAT) waits while a plan from that plan's session brings it
        to the latest format; then the message goes on to the new plan, and the old plan is closed with a link (the
        owner's words, 2026-11-07: "all plans will have to update to latest format when I resume the plan").
        Returns (go on with c, log line)."""
        plan = self.store.get(f"plans/{c.get('planId')}") if c.get("planId") else None
        if not plan or format_of(plan) >= PLAN_FORMAT:
            return True, None
        path, up = f"commands/{c['id']}", c.get("upgradeId")
        if not up:
            up = uuid.uuid4().hex[:20]
            self.store.put_many({f"commands/{up}": {
                "id": up, "action": "plan", "machine": plan.get("machine", self.machine),
                "sourceSessionId": plan.get("sessionId", ""), "cwd": plan.get("cwd", ""), "upgradeOf": plan["id"],
                "prompt": f"Plan from session (latest format): {plan.get('title', '')}", "status": "new",
                "createdAt": now_iso()}})
            self.store.update(path, {"status": "waiting", "waitReason": "upgrade", "upgradeId": up, "waitingSince": now_iso()})
            self._answer_back(c, {"waitReason": "upgrade"})
            return False, f"{c['id']}: plan {plan['id']} is in an older format, {up} brings it to the latest first"
        u = self.store.get(f"commands/{up}") or {}
        if u.get("status") in ("new", "running"):
            return False, None
        new = self.store.get(f"plans/{u.get('planId', '')}") if u.get("status") == "done" and u.get("planId") else None
        if not new:
            error = "The plan could not be brought to the latest format: " + str(u.get("error") or u.get("status") or "no new plan")
            self.store.update(path, {"status": "failed", "endedAt": now_iso(), "error": redact(error, 800)})
            self._answer_back(c, {"status": "answered", "error": redact(error, 800)})
            return False, f"{c['id']}: refused, {error}"
        note = (plan.get("closeNote") or "").strip()
        link = f"Moved to the latest format: plan {new['id']} ({new.get('title', '')})."
        self.store.update(f"plans/{plan['id']}", {"status": "done", "upgradedTo": new["id"], "updatedAt": now_iso(),
                                                  "closeNote": f"{note} {link}".strip() if link not in note else note})
        prompt = str(c.get("prompt") or "")
        if c.get("generate"):  # the order names the old plan's folder; the files go to the new plan's folder
            prompt = re.sub(rf"\.plan_data/{re.escape(plan['id'])}/v\d+", f".plan_data/{new['id']}/v{new.get('current', 1)}", prompt)
        moved = {"planId": new["id"], "sessionId": new.get("sessionId", ""), "cwd": new.get("cwd", c.get("cwd", "")),
                 "prompt": prompt, "upgradedFrom": plan["id"]}
        self.store.update(path, moved)
        c.update(moved)
        return True, f"{c['id']}: plan {plan['id']} moved to the latest format as {new['id']}; the message goes on"

    def _message(self, c: dict) -> str | None:
        go, line = self._upgrade_first(c)
        if not go:
            return line
        path = f"commands/{c['id']}"
        sid, cwd, text = c.get("sessionId", ""), c.get("cwd", ""), (c.get("prompt") or "").strip()
        if not sid or not text:
            self.store.update(path, {"status": "failed", "error": "A message needs a session and some text."})
            self._answer_back(c, {"status": "answered", "error": "A message needs a session and some text."})
            return f"{c['id']}: refused, empty"
        wt = work_type_of(cwd, self.roots)
        if wt == "other" or not os.path.isdir(cwd):
            self.store.update(path, {"status": "failed",
                              "error": "The session's folder is not under a registered folder on this machine."})
            self._answer_back(c, {"status": "answered", "error": "The session's folder is not under a registered folder."})
            return f"{c['id']}: refused, folder not registered"
        if not self.claude:
            self.store.update(path, {"status": "failed", "error": NO_CLI})
            self._answer_back(c, {"status": "answered", "error": NO_CLI})
            return f"{c['id']}: no claude CLI"
        fresh, context = self._fresh_choice(c, sid)
        if fresh:
            return self._fresh_message(c, sid, cwd, text, wt, context)
        why = self.wait_reason(sid, bool(c.get("force")))
        if why:
            if c.get("status") != "waiting" or c.get("waitReason") != why:
                self.store.update(path, {"status": "waiting", "waitReason": why, "workType": wt, "waitingSince": now_iso()})
                self._answer_back(c, {"waitReason": why})
                return f"{c['id']}: session {sid} {'is in a turn' if why == 'turn' else 'is open in the app or a terminal'}, the message waits"
            if why == "app" and self._ask_archive(c, sid, cwd):
                self.store.update(path, {"archive": "asked"})
                return f"{c['id']}: waited 1 minute for session {sid}, the archiver is asked to free it"
            if why == "app" and self._push_close(c, sid):
                return f"{c['id']}: waited 3 minutes for session {sid}, the owner is pushed to close it in the app"
            return None
        mode, kind = self.mode(), c.get("kind") if c.get("kind") in KINDS else ""
        if c.get("generate"):
            try:
                ensure_plan_data_ignored(cwd)
            except OSError:
                pass  # a read-only .gitignore never stops the order; the session's files still go to .plan_data
        model, effort = self.run_with(c)
        p = self._spawn(c["id"], message_command(self.claude, text, sid, mode, kind, str(c.get("stepId") or "")[:20], model, effort), cwd)
        self.store.update(path, {"status": "running", "workType": wt, "pid": p.pid, "startedAt": now_iso(),
                                 "permissionMode": mode, "model": model, "effort": effort})
        self._answer_back(c, {"waitReason": None})
        if self.archiver.of(c["id"]) == "archived":
            self.archiver.ask_unarchive(c["id"])
            self.store.update(path, {"archive": "unarchiving"})
        return f"{c['id']}: sent to session {sid}"

    def _log_of(self, sid: str):
        files = list(self.logs.glob(f"*/{sid}.jsonl")) if self.logs and self.logs.is_dir() else []
        return max(files, key=lambda p: p.stat().st_size) if files else None

    def _fresh_choice(self, c: dict, sid: str) -> tuple[bool, int]:
        """(start a fresh session with a handoff?, the old session's context in tokens). The message's own choice
        (auto, always, never) over the owner's size rule in meta/runs freshOver (handoff.py; the owner's pick,
        2026-11-10: "Both")."""
        choice = c.get("fresh") if c.get("fresh") in CHOICES else "auto"
        prefs = self.prefs()
        over = prefs.get("freshOver")
        over = DEFAULT_FRESH_OVER if over is None else int(over)
        path = self._log_of(sid)
        context = last_context(path) if path else 0
        if choice == "auto" and path is None:
            return False, 0  # nothing to measure: resume as before
        return should_fresh(choice, context, over), context

    def _fresh_message(self, c: dict, sid: str, cwd: str, text: str, wt: str, context: int) -> str:
        """The message goes to a new session with a handoff built from the old session's log on this PC. A plan the
        message belongs to moves to the new session; the run row links the two."""
        from .texts import turns_of

        path = self._log_of(sid)
        turns = turns_of(path, 2000) if path else []
        new_sid = str(uuid.uuid4())
        plan_id = str(c.get("planId") or "")
        prompt = handoff_prompt(sid, str(path or ""), turns, text, plan_id, context)
        mode, kind = self.mode(), c.get("kind") if c.get("kind") in KINDS else ""
        model, effort = self.run_with(c)
        cmd = start_command(self.claude, prompt, new_sid, mode, model, effort, kind=kind, step=str(c.get("stepId") or "")[:20])
        p = self._spawn(c["id"], cmd, cwd)
        self.store.update(f"commands/{c['id']}", {"status": "running", "workType": wt, "pid": p.pid, "startedAt": now_iso(),
                                                  "permissionMode": mode, "model": model, "effort": effort,
                                                  "sessionId": new_sid, "freshFrom": sid, "contextTokens": context, "waitReason": None})
        self._answer_back(c, {"waitReason": None})
        if plan_id and self.store.get(f"plans/{plan_id}"):
            self.store.update(f"plans/{plan_id}", {"sessionId": new_sid, "previousSessionId": sid, "updatedAt": now_iso()})
        return f"{c['id']}: fresh session {new_sid} with a handoff from {sid} ({context:,} tokens of context)"

    def _ask_archive(self, c: dict, sid: str, cwd: str) -> bool:
        """After 1 minute of waiting for a session open in the app, ask the archiver (archiver.py) to free it."""
        try:
            since = datetime.fromisoformat(str(c.get("waitingSince"))).timestamp()
        except ValueError:
            return False
        logs = list(self.logs.glob(f"*/{sid}.jsonl")) if self.logs and self.logs.is_dir() else []
        last = datetime.fromtimestamp(logs[0].stat().st_mtime, timezone.utc).isoformat() if logs else ""
        return self.archiver.maybe_ask(c["id"], sid, cwd, since, last)

    def _push_close(self, c: dict, sid: str) -> bool:
        """Step i9, the owner's choice (2026-11-10): "Keep waiting, push me". After CLOSE_PUSH_SECONDS waiting for a
        session open in the app that the archiver has not freed (not running, refused, or still asked), one push asks
        the owner to close that session in the app. The message keeps waiting and goes once the session is closed; no
        fresh session is started for it."""
        if c.get("closePushed") or self.push is None:
            return False
        try:
            since = datetime.fromisoformat(str(c.get("waitingSince"))).timestamp()
        except ValueError:
            return False
        if time.time() - since < CLOSE_PUSH_SECONDS or self.archiver.of(c["id"]) == "archived":
            return False
        title = ((self.store.get(f"sessions/{sid}") or {}).get("title") or sid[:8])[:80]
        n = self.push.notify("A message waits for a session open in the app",
                             f"Close \"{title}\" in the app; the message goes as soon as it is closed.",
                             f"/?run={c['id']}", f"close-{c['id']}")
        self.store.update(f"commands/{c['id']}", {"closePushed": now_iso(), "closePushDevices": n})
        return True

    def _archiver_reports(self) -> list[str]:
        """The archiver's reports go on their messages, before the messages are looked at."""
        log = []
        for cid, state, note in self.archiver.collect():
            self.store.update(f"commands/{cid}", {"archive": state, "archiveNote": note or None})
            log.append(f"{cid}: archiver {state}{': ' + note if note else ''}")
        return log

    def _archiver_freed(self) -> list[str]:
        """An archived session whose message no longer waits (sent, cancelled or deleted) is unarchived."""
        log = []
        for cid, s in list(self.archiver.state.items()):
            if s.get("state") == "archived" and (self.store.get(f"commands/{cid}") or {}).get("status") not in ("waiting", "new"):
                self.archiver.ask_unarchive(cid)
                self.store.update(f"commands/{cid}", {"archive": "unarchiving"})
                log.append(f"{cid}: the message no longer waits, the archiver is asked to unarchive its session")
        return log

    def _approve_generated(self, c: dict) -> str:
        """The owner approves the final result of a Generate (the owner's words, 2026-11-04: "the generated files I'm not
        approved must stay in a tmp folder inside current folder structure of generated files; then when I approve the
        final result of the generated step then only approved items go to plan, tmp files need to be removed (tmp
        folder and dashboard)"). Moves the approved files from <version>/tmp/ to <version>/ (never overwriting); a ticked file already in <version>/ is approved where it is (2026-11-08),
        removes the tmp folder, and deletes the plan session's "Generated" results that pointed into it."""
        path, cwd = f"commands/{c['id']}", c.get("cwd", "")
        folder = str(c.get("folder") or "")
        plan = self.store.get(f"plans/{c.get('planId', '')}") or {}
        why = ("No such plan." if not plan else "The plan's folder is not under a registered folder on this machine."
               if work_type_of(cwd, self.roots) == "other" or not os.path.isdir(cwd)
               else "The folder is not a plan version folder." if not re.fullmatch(r"\.plan_data/[A-Za-z0-9]+/v\d+", folder)
               or folder.split("/")[1] != plan.get("id") else "")
        if why:
            self.store.update(path, {"status": "failed", "endedAt": now_iso(), "error": why})
            return f"{c['id']}: refused, {why}"
        base = (Path(cwd) / folder).resolve()
        tmp = base / "tmp"
        moved, skipped = [], []
        for rel in c.get("keep") or []:
            src = (Path(cwd) / str(rel)).resolve()
            # subfolders count too (the owner, 2026-11-10: "do as suggested": "let Approve take subfolders"), e.g.
            # <version>/pictures/1-plans-board-PASS.png
            if src.is_file() and base in src.parents and tmp not in src.parents:  # already in the version folder: approved in place
                moved.append({"from": str(rel), "to": src.relative_to(Path(cwd).resolve()).as_posix()})
                continue
            if not src.is_file() or tmp not in src.parents:
                skipped.append(str(rel))
                continue
            at = base / src.parent.relative_to(tmp)  # tmp/pictures/x.png goes to <version>/pictures/x.png
            at.mkdir(parents=True, exist_ok=True)
            dest, n = at / src.name, 2
            while dest.exists():  # never overwrite: -2, -3
                dest = at / f"{src.stem}-{n}{src.suffix}"
                n += 1
            shutil.move(str(src), str(dest))
            moved.append({"from": str(rel), "to": dest.relative_to(Path(cwd).resolve()).as_posix()})
        if tmp.is_dir():
            shutil.rmtree(tmp)
        if moved:  # the plan's Generated section (the owner, 2026-11-04: "not new version because the generated just is
            # the artifact to visualize the plan, it is the supplement for the current version"): one small record per
            # plan, the approved files per version folder; never a plan version
            rec = self.store.get(f"planGenerated/{plan['id']}") or {"planId": plan["id"], "versions": {}}
            key = folder.rsplit("/", 1)[1]
            rec.setdefault("versions", {}).setdefault(key, [])
            for m in moved:
                name = m["to"].rsplit("/", 1)[-1]
                if any(x.get("file") == m["to"] for x in rec["versions"][key]):
                    continue
                rec["versions"][key].append({"file": m["to"], "kind": generated_kind(name), "at": now_iso()})
            self.store.put_many({f"planGenerated/{plan['id']}": rec})
        removed = 0
        for item_id in c.get("drop") or []:
            item = self.store.get(f"inbox/{item_id}") or {}
            if (item.get("kind") == "result" and item.get("sessionId") == plan.get("sessionId")
                    and str(item.get("title", "")).lower().startswith("generated")):
                self.store.delete(f"inbox/{item_id}")
                removed += 1
        self.store.update(path, {"status": "done", "endedAt": now_iso(), "moved": moved, "skipped": skipped,
                                 "removed": removed})
        return f"{c['id']}: approved {len(moved)} generated file(s), removed tmp and {removed} result(s)"

    def _delete_plan_files(self, c: dict) -> str:
        r"""A deleted plan's own folder on this PC (the owner's words, 2026-11-05: "confirmed, deleting a plan will also
        remove that plan's own folder, <project>\.plan_data\<plan id>\, and nothing outside it"). Only
        <cwd>/.plan_data/<plan id>/, and only once the plan's record is gone; the command then deletes itself."""
        path, cwd, pid = f"commands/{c['id']}", c.get("cwd", ""), str(c.get("plan") or "")
        why = ("Not a plan id." if not re.fullmatch(r"[A-Za-z0-9]+", pid)
               else "The plan still exists; its files stay." if self.store.get(f"plans/{pid}")
               else "The plan's folder is not under a registered folder on this machine."
               if work_type_of(cwd, self.roots) == "other" or not os.path.isdir(cwd) else "")
        if why:
            self.store.update(path, {"status": "failed", "endedAt": now_iso(), "error": why})
            return f"{c['id']}: refused, {why}"
        root = (Path(cwd) / ".plan_data").resolve()
        target = (root / pid).resolve()
        gone = False
        if target.parent == root and target.is_dir():
            shutil.rmtree(target)
            gone = True
        self.store.delete(path)
        return f"{c['id']}: plan {pid} deleted, its folder {'removed' if gone else 'was not there'}"

    def _check(self, c: dict) -> str:
        """"Check now" on a session page: writes what the wait rule sees, once, on the command itself."""
        st = session_status(self.logs, c.get("sessionId", ""))
        self.store.update(f"commands/{c['id']}", {"status": "done", "endedAt": now_iso(), "check": st})
        return f"{c['id']}: checked {c.get('sessionId', '')}"

    def _plan(self, c: dict) -> str:
        """A plan from a session: pages, notes per page, then a new session writes the plan (planfrom.py)."""
        path, cid = f"commands/{c['id']}", c["id"]
        src, cwd = c.get("sourceSessionId", ""), c.get("cwd", "")
        log = find_log(self.logs, src)
        why = ("No session to read." if not src else "No claude CLI on this machine." if not self.claude
               else "The session's folder is not under a registered folder on this machine."
               if work_type_of(cwd, self.roots) == "other" or not os.path.isdir(cwd)
               else "The session's log is not on this machine." if log is None else "")
        if why:
            self.store.update(path, {"status": "failed", "error": why})
            return f"{cid}: refused, {why}"
        folder = self.out_dir / "plans" / cid
        self.store.update(path, {"status": "running", "stage": "Reading the log", "startedAt": now_iso(),
                                 "workType": work_type_of(cwd, self.roots), "pagesDir": str(folder)})
        self.reading[cid] = {"proc": None, "stop": False}
        threading.Thread(target=self._read_and_plan, args=(c, log, folder), daemon=True).start()
        return f"{cid}: reading session {src}"

    def _earlier_notes(self, c: dict, folder: Path) -> dict[tuple[int, str], str]:
        """Notes already written for this session (the owner's words, 2026-11-09: "if you don't see anything then the
        plan session need to write down to temp folder so I can restart if this issue happen again"; approved: "Yes,
        build this in the bridge"). {(page number, page text): the notes run's output} from this run's own folder and
        from every earlier plan run on the same session. Read before write_pages rewrites this folder's pages."""
        src = c.get("sourceSessionId", "")
        dirs = [folder] + [Path(x["pagesDir"]) for x in self.store.where("commands", "sourceSessionId", src)
                           if x.get("action") == "plan" and x.get("pagesDir") and x.get("id") != c["id"]]
        found: dict[tuple[int, str], str] = {}
        for d in dirs:
            for out in sorted(d.glob("notes-*.out")) if d.is_dir() else []:
                page = d / f"page-{out.stem[6:]}.txt"
                try:
                    raw, text = out.read_text(encoding="utf-8", errors="replace"), page.read_text(encoding="utf-8")
                except (OSError, ValueError):
                    continue
                res = parse_result(raw)
                if res.get("result") and not res.get("is_error") and out.stem[6:].isdigit():
                    found.setdefault((int(out.stem[6:]), text), raw)
        return found

    def _read_and_plan(self, c: dict, log: Path, folder: Path) -> None:
        path, cid, r = f"commands/{c['id']}", c["id"], self.reading[c["id"]]
        env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}
        try:
            earlier = self._earlier_notes(c, folder)
            pages, quotes, reused = write_pages(log, folder), {"checked": 0, "marked": 0}, 0
            self.store.update(path, {"pages": pages, "stage": f"Read {len(pages)} pages", "pausedUntil": None})
            for i, pg in enumerate(pages, 1):
                if r["stop"]:
                    break
                old = earlier.get((i, (folder / pg["file"]).read_text(encoding="utf-8")))
                if old is not None:  # the same page as an earlier run: keep its notes, no new notes run
                    (folder / f"notes-{i:02d}.out").write_text(old, encoding="utf-8")
                    code, res, reused = 0, parse_result(old), reused + 1
                    self.store.update(path, {"reused": reused})
                else:
                    g = self._guard(cid, "page", f"page {i} of {len(pages)}")
                    if g is None:
                        return
                    self.store.update(path, {"stage": f"Notes on page {i} of {len(pages)}", "budget": g})
                    with open(folder / pg["file"], encoding="utf-8") as inp, \
                            open(folder / f"notes-{i:02d}.out", "w", encoding="utf-8") as out:
                        r["proc"] = self.popen(note_command(self.claude, i, len(pages)), cwd=str(folder), env=env,
                                               stdin=inp, stdout=out, stderr=subprocess.DEVNULL)
                        try:
                            code = r["proc"].wait(NOTE_SECONDS)
                        except subprocess.TimeoutExpired:
                            _kill_tree(r["proc"])
                            raise RuntimeError(f"The notes on page {i} took over {NOTE_SECONDS // 60} minutes.")
                    res = parse_result((folder / f"notes-{i:02d}.out").read_text(encoding="utf-8", errors="replace"))
                    if self.budget is not None:  # the window's rise over this page's cost tunes the next estimate
                        w = self.budget.window()
                        self.budget.learn(g.get("used"), w["percent"] if w else None, res.get("total_cost_usd"))
                if r["stop"]:
                    break
                if res.get("api_error") == "usage_limit_reached":  # paused, not failed: safe to continue after the reset
                    self._pause(cid, res, f"Paused at page {i} of {len(pages)}: usage limit")
                    return
                if code != 0 or res.get("is_error") or not res.get("result"):
                    raise RuntimeError(f"The notes on page {i} failed: " + str(res.get("result") or f"exit {code}")[:300])
                notes, seen, off = mark_quotes(res["result"], (folder / pg["file"]).read_text(encoding="utf-8"), i)
                (folder / f"notes-{i:02d}.md").write_text(notes, encoding="utf-8")
                quotes = {"checked": quotes["checked"] + seen, "marked": quotes["marked"] + off}
                self.store.update(path, {"quotes": quotes})
            if r["stop"]:
                self.store.update(path, {"status": "stopped", "endedAt": now_iso()})
                return
            g = self._guard(cid, "write", "the plan write")
            if g is None:
                return
            sid = str(uuid.uuid4())
            prompt = plan_prompt(c.get("sourceSessionId", ""), folder, len(pages), cid, str(c.get("goal") or "")[:2000])
            cmd = start_command(self.claude, prompt, sid, self.mode(), *self.run_with(c)) + ["--add-dir", str(folder), "--disallowedTools", NO_EDITS]
            p = self._spawn(cid, cmd, c.get("cwd", ""))
            self.store.update(path, {"sessionId": sid, "pid": p.pid, "stage": "Writing the plan", "prompt": prompt, "budget": g})
        except Exception as e:  # a failed page run or an unreadable log ends this plan, never the bridge
            self.store.update(path, {"status": "failed", "endedAt": now_iso(), "error": redact(str(e), 800)})
        finally:
            self.reading.pop(cid, None)

    def _guard(self, cid: str, what: str, name: str) -> dict | None:
        """Step i5 (the owner's choice, 2026-11-12: "Page by page"): the next run's cost against the 5-hour window left
        (budget.py). The guard's numbers when the run may go; None when the plan paused before it."""
        if self.budget is None:
            return {}
        g = self.budget.check(what)
        if g.get("ok"):
            return g
        try:
            at = datetime.fromisoformat(g["resetsAt"]) if g.get("resetsAt") else None
        except ValueError:
            at = None
        text = (f"Budget guard: {name} needs about {g['need']}% of the 5-hour window, {g['left']}% is left. "
                f"Paused before it; it goes on at the reset.")
        self._pause(cid, {"result": text}, f"Paused before {name}: budget guard", at)
        self.store.update(f"commands/{cid}", {"budget": g})
        return None

    def _stop(self, c: dict) -> str:
        """Stops a run. A stop sent by Delete (the owner's choice, 2026-11-03: "Delete also stops the session's work")
        aims at a run whose record is already gone; the stop then deletes itself too, so nothing of the run is left."""
        target = c.get("target", "")
        if c.get("deleting"):
            self._kill(target)
            self.store.delete(f"commands/{c['id']}")
            return f"{c['id']}: stopped deleted run {target}"
        if target in self.reading:  # a plan still reading pages: stop after killing the page run
            r = self.reading[target]
            r["stop"] = True
            if r["proc"] is not None and r["proc"].poll() is None:
                _kill_tree(r["proc"])
            self.store.update(f"commands/{c['id']}", {"status": "done", "endedAt": now_iso()})
            return f"{c['id']}: stopping {target}"
        p = self.procs.get(target)
        if p is None or p.poll() is not None:
            self.store.update(f"commands/{c['id']}", {"status": "failed", "error": "That run is not running on this machine."})
            return f"{c['id']}: nothing to stop"
        _kill_tree(p)
        self.store.update(f"commands/{target}", {"status": "stopping"})
        self.store.update(f"commands/{c['id']}", {"status": "done", "endedAt": now_iso()})
        return f"{c['id']}: stopped {target}"

    def _kill(self, target: str) -> None:
        r = self.reading.get(target)
        if r is not None:
            r["stop"] = True
            if r["proc"] is not None and r["proc"].poll() is None:
                _kill_tree(r["proc"])
        p = self.procs.get(target)
        if p is not None and p.poll() is None:
            _kill_tree(p)

    def _finish(self, cid: str, p: subprocess.Popen) -> str:
        # the run leaves self.procs only after its end is written: a write Firestore refuses (429 quota, network)
        # raises, the run stays, and the next step writes it again (the owner's pick, 2026-11-11: "Close it + fix +
        # restart"; run 18442aa6 stayed "running" for hours when its write met a 429)
        out = (self.out_dir / f"{cid}.out").read_text(encoding="utf-8", errors="replace")
        err_path = self.out_dir / f"{cid}.err"
        err = err_path.read_text(encoding="utf-8", errors="replace") if err_path.is_file() else ""
        stopped = (self.store.get(f"commands/{cid}") or {}).get("status") == "stopping"
        fields = {"endedAt": now_iso(), "exitCode": p.returncode}
        r = parse_result(out)
        done_at = datetime.fromtimestamp((self.out_dir / f"{cid}.out").stat().st_mtime, timezone.utc).isoformat()
        fields.update(run_cost(self.logs, r, self.store.get(f"commands/{cid}") or {}, fields["endedAt"], done_at))
        if not stopped and r.get("api_error") == "usage_limit_reached":
            # paused, not failed: Continue (or the auto continue at the reset) does the leftover work; an answer's
            # inbox item stays as it is until then
            self.store.update(f"commands/{cid}", fields)
            self.procs.pop(cid, None)
            self.sid_of.pop(cid, None)
            self._pause(cid, r, "Paused: usage limit")
            c = self.store.get(f"commands/{cid}") or {}
            if self.push is not None:
                self.push.notify(f"Run paused until {c.get('pausedUntil', 'the reset')}",
                                 "Continue on the page" + (", or it continues by itself at the reset." if c.get("autoContinue") else "."),
                                 f"/?run={cid}", cid)
            return f"{cid}: paused, usage limit"
        if stopped:
            fields["status"] = "stopped"
        elif r.get("is_error"):
            # claude ran but reported an error: show its message, not the raw JSON
            fields["status"] = "failed"
            fields["error"] = redact(str(r.get("result") or r.get("terminal_reason") or "claude reported an error"), 800)
        elif p.returncode == 0:
            fields["status"] = "done"
            # the result itself is not stored: the page reads the whole text from <cid>.out on this PC (texts.py; the
            # owner's choice, 2026-11-08: "the dashboard only load the file stored on the PC")
        else:
            fields["status"] = "failed"
            fields["error"] = redact(str(r.get("result") or (err or out or "")[-800:]), 800)
        self.store.update(f"commands/{cid}", fields)
        self.procs.pop(cid, None)
        self.sid_of.pop(cid, None)
        c = self.store.get(f"commands/{cid}") or {}
        if fields["status"] == "done" and c.get("action") == "plan" and self.budget is not None:
            self.budget.wrote(fields.get("costUsd"))  # step i5: the plan write's measured cost for the next guard
        if fields["status"] == "done":
            # no followUp text: the page reads the run's whole result from the PC (texts.py, the owner's choice,
            # 2026-11-08: "From the PC too")
            self._answer_back(c, {"status": "delivered", "deliveredAt": now_iso(), "deliveredVia": "resume", "error": None})
        elif fields["status"] == "stopped":
            self._answer_back(c, {"status": "closed", "error": "Stopped on the page before it reached the session."})
        else:
            self._answer_back(c, {"status": "answered", "lastTryAt": now_iso(),
                                  "error": fields.get("error") or f"The message run {fields['status']}."})
        if self.push is not None and fields["status"] in ("done", "failed"):
            first = (fields.get("error") or str(r.get("result") or "")).strip().split("\n")
            body = next((line for line in first if line.strip(" -")), "")[:160]
            what = "message" if c.get("action") == "message" else "run"
            self.push.notify(f"{what.capitalize()} {fields['status']}: {c.get('workType') or c.get('folder') or ''}".rstrip(": "),
                             body or "No text.", f"/?run={cid}", cid)
        after = self.chains.after(c) if c.get("chain") else None
        return f"{cid}: {fields['status']}" + (f"; {after}" if after else "")
