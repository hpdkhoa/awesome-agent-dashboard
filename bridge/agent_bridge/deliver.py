"""Hands the owner's answers to sessions that did not take them live to the runs path (runs.py), as a message to the
same session.

The session itself takes an answer while its inbox_ask still waits (inbox.py). After that, the answer goes as a
message with inboxId: the same `claude -p --resume <session>`, approvals in the inbox, the same wait rule (a running
turn, a session open in the app), a push when it ends, and a row in Runs, without blocking the bridge (the owner's
choice, 2026-11-02: "build the fix", so a plan stays one session). Runs writes the outcome back on the inbox item; a
failed try goes again after 10 minutes. Only sessions of this machine. The `claude` program must be the unmodified CLI,
signed in through Anthropic's own flow (terms T5, T6).
"""

from __future__ import annotations

import os
import shutil
import uuid
from datetime import datetime, timezone

from .inbox import answer_text, is_live, now_iso

RETRY_SECONDS = 600


def find_claude(env_value: str = "") -> str | None:
    if env_value:
        return env_value if os.path.exists(env_value) else None
    return shutil.which("claude")


def deliver(store, machine: str, claude: str | None) -> list[str]:
    """Turns each answer still to deliver into a message command. Returns one line per item acted on."""
    log = []
    for item in store.where("inbox", "status", "delivering"):
        # an answer whose message the owner cancelled on the Runs tab
        c = store.get(f"commands/{item.get('commandId')}") if item.get("commandId") else None
        if item.get("machine") == machine and c and c.get("status") == "cancelled":
            store.update(f"inbox/{item['id']}", {"status": "closed", "error": "Cancelled on the page.", "waitReason": None})
            log.append(f"{item['id']}: cancelled")
    for item in store.where("inbox", "status", "answered"):
        if item.get("kind") == "approval":
            continue  # approvals are only ever answered live, inside the waiting run
        if item.get("machine") != machine or item.get("sessionId") in (None, "", "unknown"):
            continue
        if is_live(store, item["sessionId"]):
            continue  # the session's inbox_ask is still waiting and takes the answer itself
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
        cid = uuid.uuid4().hex[:20]
        store.put_many({f"commands/{cid}": {
            "id": cid, "action": "message", "machine": machine, "sessionId": item["sessionId"], "cwd": item.get("cwd", ""),
            "prompt": answer_text(item), "inboxId": item["id"], "force": bool(item.get("force")), "status": "new",
            "createdAt": now_iso(),
        }})
        store.update(f"inbox/{item['id']}", {"status": "delivering", "commandId": cid, "lastTryAt": now_iso(), "error": None})
        log.append(f"{item['id']}: handed to run {cid}")
    return log
