"""Delivers the owner's answers to sessions that have closed, by resuming them with the owner's own `claude`.

Only sessions of this machine, only when the session's heartbeat says it is closed, one try per item every 10
minutes. The `claude` program must be the unmodified CLI, signed in through Anthropic's own flow (terms T5, T6);
ANTHROPIC_API_KEY is removed from its environment so it always uses the plan (T7).
"""

from __future__ import annotations

import os
import shutil
import subprocess
from datetime import datetime, timezone

from .inbox import answer_text, is_live, now_iso
from .redact import redact
from .runs import parse_result

RETRY_SECONDS = 600


def find_claude(env_value: str = "") -> str | None:
    if env_value:
        return env_value if os.path.exists(env_value) else None
    return shutil.which("claude")


def resume_command(claude: str, session_id: str, message: str) -> list[str]:
    return [claude, "-p", message, "--resume", session_id, "--output-format", "json"]


def deliver(store, machine: str, claude: str | None, run=subprocess.run) -> list[str]:
    """Resumes closed sessions with their answers. Returns one line per item acted on."""
    log = []
    for item in store.where("inbox", "status", "answered"):
        if item.get("kind") == "approval":
            continue  # approvals are only ever answered live, inside the waiting run
        if item.get("machine") != machine or item.get("sessionId") in (None, "", "unknown"):
            continue
        if is_live(store, item["sessionId"]):
            continue  # the open session picks the answer up itself
        a = item.get("answer") or {}
        if item.get("kind") == "result" and not a.get("text") and not a.get("choice"):
            store.update(f"inbox/{item['id']}", {"status": "closed", "deliveredAt": now_iso()})
            log.append(f"{item['id']}: reviewed, nothing to send")
            continue
        last = item.get("lastTryAt")
        if last and (datetime.now(timezone.utc) - datetime.fromisoformat(last)).total_seconds() < RETRY_SECONDS:
            continue
        if not claude:
            store.update(f"inbox/{item['id']}", {"lastTryAt": now_iso(),
                         "error": "No signed-in claude CLI on this machine. Install Claude Code and sign in, or set CLAUDE_BIN."})
            log.append(f"{item['id']}: no claude CLI")
            continue
        store.update(f"inbox/{item['id']}", {"status": "delivering", "lastTryAt": now_iso()})
        env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}
        cwd = item.get("cwd") if item.get("cwd") and os.path.isdir(item["cwd"]) else None
        try:
            p = run(resume_command(claude, item["sessionId"], answer_text(item)), cwd=cwd, env=env,
                    capture_output=True, text=True, encoding="utf-8", timeout=1800)
            out = parse_result(p.stdout)
            ok = p.returncode == 0 and not out.get("is_error")
            reply = str(out.get("result", "")) if out else (p.stdout or "")
            if ok:
                store.update(f"inbox/{item['id']}", {"status": "delivered", "deliveredAt": now_iso(),
                             "deliveredVia": "resume", "followUp": redact(reply, 2000), "error": None})
                log.append(f"{item['id']}: delivered by resume")
            else:
                store.update(f"inbox/{item['id']}", {"status": "answered",
                             "error": redact(reply if out.get("is_error") else (p.stderr or p.stdout or "")[-600:], 600)})
                log.append(f"{item['id']}: resume failed ({p.returncode})")
        except (OSError, subprocess.TimeoutExpired) as e:
            store.update(f"inbox/{item['id']}", {"status": "answered", "error": redact(str(e), 600)})
            log.append(f"{item['id']}: resume failed ({type(e).__name__})")
    return log
