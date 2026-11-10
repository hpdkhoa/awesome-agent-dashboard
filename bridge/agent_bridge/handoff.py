"""A fresh session with a handoff instead of resuming a long one (the owner's words, 2026-11-10: "For the cache reads,
is it affect my performance and downgrade my 5-hour limit? If yes then I need an optimize option in here ... I care
about the performance and the work I can do with agent dashboard first"; the pick: "Both": a size rule on the Runs tab
and a choice on each message).

A resumed run sends the whole conversation as input on every turn. Over the size the owner set, a message starts a new
session whose prompt is a handoff: the last turns of the old session (its prompts and final replies, from the log on
this PC), the plan it carries, and the owner's message. The old log stays; the new session may read it with its tools.
"""

from __future__ import annotations

import json
from pathlib import Path

from .redact import redact

DEFAULT_FRESH_OVER = 300_000  # tokens of context; 0 turns the rule off
HANDOFF_TURNS = 6
HANDOFF_CHARS = 24_000
TAIL_BYTES = 2 * 1024 * 1024
CHOICES = ("auto", "always", "never")


def last_context(path: Path) -> int:
    """The context the next turn would send: input, cache read and cache write tokens of the log's last assistant
    message that carried usage (what the model was given on the last turn)."""
    try:
        size = path.stat().st_size
        with open(path, "rb") as f:
            f.seek(max(0, size - TAIL_BYTES))
            data = f.read()
    except OSError:
        return 0
    best = 0
    for raw in data.splitlines():
        try:
            d = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            continue
        if d.get("type") != "assistant":
            continue
        u = (d.get("message") or {}).get("usage") or {}
        if not u:
            continue
        n = int(u.get("input_tokens") or 0) + int(u.get("cache_read_input_tokens") or 0) + int(u.get("cache_creation_input_tokens") or 0)
        if n:
            best = n  # the last one wins
    return best


def should_fresh(choice: str, context: int, over: int) -> bool:
    """always: fresh; never: resume; auto: fresh when the rule is on (over > 0) and the context is over it."""
    if choice == "always":
        return True
    if choice == "never":
        return False
    return over > 0 and context > over


def handoff_prompt(old_sid: str, old_log: str, turns: list[dict], message: str, plan_id: str = "", context: int = 0) -> str:
    """The new session's first prompt: the handoff, then the owner's message."""
    head = [f"This is a fresh session that continues session {old_sid} with a handoff, so each turn stays fast: the old "
            f"session's context had grown to about {context:,} tokens. Its log is at {old_log}; read it with your tools "
            f"only when this handoff is not enough. Keep the owner's rules and the work's state as this handoff says."]
    body: list[str] = []
    budget = HANDOFF_CHARS
    for t in turns[-HANDOFF_TURNS:]:
        prompt = redact(str(t.get("prompt") or ""), 2000)
        reply = redact(str(t.get("text") or ""), max(500, budget // max(1, len(turns[-HANDOFF_TURNS:]))))
        block = f"### turn {t.get('n', '?')} · {t.get('at', '')}\nThe owner asked:\n{prompt}\n\nThe session replied:\n{reply}"
        budget -= len(block)
        body.append(block)
        if budget <= 0:
            break
    parts = head + ["## The last turns of the old session", *body]
    if plan_id:
        parts.append(f"## Plan\nPlan {plan_id} now belongs to this session: its tools (plan_version, step_update, the "
                     f"inbox) work with plan_id=\"{plan_id}\" as before. Read the plan's parts from its current version before "
                     f"changing anything.")
    parts.append(f"## The owner's message now\n{message}")
    return "\n\n".join(parts)
