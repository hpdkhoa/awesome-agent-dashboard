"""The question hook: Claude Code's own question box (AskUserQuestion) goes to the dashboard inbox first.

The owner's choice, 2026-11-01, "A1 N use 10 minutes": each question waits in the inbox for up to 10 minutes. Answered
there, the hook hands the answers back to the session (PreToolUse allow + updatedInput.answers, as Claude Code's hooks
docs describe). Not answered in time, the hook steps aside and the session's own question box opens.

Registered once in ~/.claude/settings.json as a PreToolUse hook on AskUserQuestion, with a timeout above 10 minutes.
Any error (not signed in, no network) also steps aside: the hook never blocks a question.
"""

from __future__ import annotations

import json
import os
import sys
import time

from .inbox import BEAT_SECONDS, Inbox, now_iso

WAIT_SECONDS = 10 * 60
POLL_SECONDS = 5


def post_questions(inbox: Inbox, questions: list[dict]) -> list[str]:
    """One inbox item per question; options keep their labels, so an answer maps back to the label Claude offered."""
    ids = []
    for q in questions:
        # an option's preview is its example; a plan question with an option that has none is refused, and the
        # session's own question box opens instead
        opts = [{"label": o.get("label", ""), "detail": o.get("description", ""),
                 **({"example": {"type": "text", "draft": o["preview"]}} if o.get("preview") else {})}
                for o in q.get("options") or []]
        text = q.get("question", "")
        if q.get("multiSelect"):
            text += "\n\n(More than one option may be picked.)"
        ids.append(inbox.post("question", q.get("header") or q.get("question", "")[:80], text, opts,
                              extra={"via": "hook", "multi": bool(q.get("multiSelect"))}))
    return ids


def answer_of(item: dict) -> str:
    """The text Claude gets for one question: the picked label(s), with the owner's note after it."""
    a = item.get("answer") or {}
    choice, note = (a.get("choice") or "").strip(), (a.get("text") or "").strip()
    if choice and note:
        return f"{choice}. Note: {note}"
    return choice or note


def wait_answers(inbox: Inbox, ids: list[str], wait: float = WAIT_SECONDS, poll: float = POLL_SECONDS,
                 clock=time.time, sleep=time.sleep) -> dict[str, dict] | None:
    """The answered items by id once every question has an answer; None after `wait` seconds or if one was deleted.

    A heartbeat on liveSessions/<session> while waiting keeps the bridge from resuming this session with the same answer.
    """
    end, next_beat = clock() + wait, 0.0
    while True:
        if clock() >= next_beat:
            inbox.beat()
            next_beat = clock() + BEAT_SECONDS
        items = {i: inbox.store.get(f"inbox/{i}") for i in ids}
        if any(v is None for v in items.values()):
            return None
        if all(v.get("status") == "answered" for v in items.values()):
            return items
        if clock() >= end:
            return None
        sleep(poll)


def hook_output(tool_input: dict, items: dict[str, dict], ids: list[str]) -> dict:
    answers = {q.get("question", ""): answer_of(items[i]) for q, i in zip(tool_input.get("questions") or [], ids)}
    return {"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "allow",
        "permissionDecisionReason": "Answered by the owner on the dashboard.",
        "updatedInput": {**tool_input, "answers": answers},
    }}


def handle(event: dict, inbox: Inbox, **waits) -> dict | None:
    """The hook's whole job for one event: the output to print, or None to let the session ask as usual."""
    tool_input = event.get("tool_input") or {}
    questions = tool_input.get("questions") or []
    if event.get("tool_name") != "AskUserQuestion" or not questions:
        return None
    ids = post_questions(inbox, questions)
    items = wait_answers(inbox, ids, **waits)
    if items is None:
        for i in ids:
            if inbox.store.get(f"inbox/{i}") is not None:
                inbox.store.update(f"inbox/{i}", {"status": "closed", "error": "No answer in 10 minutes; asked in the session instead."})
        return None
    for i in ids:
        inbox.store.update(f"inbox/{i}", {"status": "delivered", "deliveredAt": now_iso(), "deliveredVia": "live"})
    return hook_output(tool_input, items, ids)


def main() -> None:
    try:
        event = json.load(sys.stdin)
        from .auth import Session
        from .config import Config
        from .firestore import Firestore

        cfg = Config.load()
        from .push import pusher

        store = Firestore(Session(cfg))
        inbox = Inbox(store, cfg.machine, cfg.roots, event.get("session_id", ""), event.get("cwd") or os.getcwd(),
                      pusher(store, cfg.owner_email))
        out = handle(event, inbox)
    except (Exception, SystemExit) as e:
        print(f"agent-inbox question hook skipped: {e}", file=sys.stderr)
        return
    if out is not None:
        print(json.dumps(out, ensure_ascii=False))
