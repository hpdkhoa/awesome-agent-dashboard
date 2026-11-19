"""F11 run end guard (plan bf73af63; the step: "a run that ends on a promise ('I will ...') or with an open step is
flagged"; the owner's picks 2026-11-19 "Start F11, build now", "No report this run").

When a run ends, the bridge reads its last reply (the result in <cid>.out, the same text the page shows) and flags it:
- promise: a line of the last reply that says what the session will do later ("I will", "I'll", "I am going to",
  "I'm going to"), kept whole (up to 3 lines, 240 chars each);
- open step: a Run step (a message on a plan step, no plan kind) whose step got no step_update between the run's
  start and its end ("No report this run").
The flag is stored on the run row as endGuard and shown on the Runs tab; a run with neither gets no field.
"""

from __future__ import annotations

import re

from .redact import redact

PROMISE = re.compile(r"\b(I\s+will|I['’]ll|I\s+am\s+going\s+to|I['’]m\s+going\s+to)\b", re.I)
MAX_LINES, MAX_CHARS = 3, 240


def promises(text: str) -> list[str]:
    """The lines of the last reply that promise later work, cleaned of markdown marks."""
    out = []
    for line in (text or "").splitlines():
        if PROMISE.search(line):
            clean = re.sub(r"[*_`]+", "", line).strip().lstrip("-• ").strip()
            out.append(redact(clean, MAX_CHARS))
            if len(out) == MAX_LINES:
                break
    return out


def is_step_run(c: dict) -> bool:
    """A Run step message: on a plan step, not a plan kind (Ask, Change, Quote on a step carry a kind)."""
    return c.get("action") == "message" and bool(c.get("planId")) and bool(c.get("stepId")) and not c.get("kind")


def reported(store, c: dict, ended: str) -> bool:
    """The run's step got a step_update while the run went (any state)."""
    st = store.get(f"planSteps/{c['planId']}_{c['stepId']}") or {}
    start = c.get("startedAt") or c.get("createdAt") or ""
    return any(start <= str(v.get("at") or "") <= ended for v in st.get("versions") or [])


def flag(store, c: dict, last_reply: str, ended: str) -> dict | None:
    """The run's endGuard, or None when it ends clean."""
    g: dict = {}
    lines = promises(last_reply)
    if lines:
        g["promise"] = lines
    if is_step_run(c) and not reported(store, c, ended):
        g["openStep"] = str(c["stepId"])
    if not g:
        return None
    g["at"] = ended
    return g
