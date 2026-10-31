"""Turns the read log files into the documents the dashboard shows: sessions, daily usage and work types."""

from __future__ import annotations

from collections import defaultdict

from .logs import FileState
from .prices import cost

TOKEN_KEYS = ("input", "output", "cacheWrite5m", "cacheWrite1h", "cacheRead")


def work_type_of(cwd: str, roots: list[tuple[str, str]]) -> str:
    """The work type whose root folder holds cwd (the longest match wins), else "other"."""
    path = cwd.replace("\\", "/").rstrip("/").lower()
    best, best_len = "other", -1
    for wt, root in roots:
        r = root.replace("\\", "/").rstrip("/").lower()
        if (path == r or path.startswith(r + "/")) and len(r) > best_len:
            best, best_len = wt, len(r)
    return best


def _zero() -> dict:
    return {**{k: 0 for k in TOKEN_KEYS}, "total": 0, "costUsd": 0.0, "unpricedTokens": 0}


def _add(acc: dict, model: str, t: list[int]) -> None:
    for k, v in zip(TOKEN_KEYS, t):
        acc[k] += v
    n = sum(t)
    acc["total"] += n
    c = cost(model, *t)
    if c is None:
        acc["unpricedTokens"] += n
    else:
        acc["costUsd"] = round(acc["costUsd"] + c, 6)


def build(
    sessions: dict[str, list[FileState]], machine: str, roots: list[tuple[str, str]]
) -> tuple[dict[str, dict], dict[str, dict], dict[str, dict]]:
    """(session docs, usage docs by day, work type docs).

    A message.id counts once: in the session its log line names when that session is loaded, else in the earliest one.
    """
    order = sorted(sessions, key=lambda s: min((f.first_ts for f in sessions[s] if f.first_ts), default="~"))
    owner: dict[str, str] = {}
    best: dict[str, list[int]] = {}  # the largest value of each token field over every copy of the message
    for sid in order:
        for f in sessions[sid]:
            for mid, (_, _, origin, *t) in f.msgs.items():
                best[mid] = t if mid not in best else [max(a, b) for a, b in zip(best[mid], t)]
                if origin in sessions:
                    owner[mid] = origin
                else:
                    owner.setdefault(mid, sid)
    seen: set[str] = set()
    docs: dict[str, dict] = {}
    usage: dict[str, dict] = {}
    wts: dict[str, dict] = {}
    for sid in order:
        files = sessions[sid]
        main = files[0]
        wt = work_type_of(main.cwd, roots)
        tokens, days, models = _zero(), defaultdict(_zero), defaultdict(int)
        for f in files:
            for mid, (day, model, _origin, *_t) in f.msgs.items():
                if mid in seen or owner[mid] != sid:
                    continue
                t = best[mid]
                seen.add(mid)
                models[model] += 1
                _add(tokens, model, t)
                _add(days[day], model, t)
                u = usage.setdefault(day, {"day": day, **_zero(), "byWorkType": {}, "byModel": {}, "sessions": []})
                _add(u, model, t)
                _add(u["byWorkType"].setdefault(wt, _zero()), model, t)
                _add(u["byModel"].setdefault(model, _zero()), model, t)
                if sid not in u["sessions"]:
                    u["sessions"].append(sid)
        last_reply = max(files, key=lambda f: f.last_ts).last_reply if files else ""
        doc = {
            "id": sid,
            "machine": machine,
            "workType": wt,
            "cwd": main.cwd,
            "title": main.title or main.first_prompt or sid[:8],
            "firstPrompt": main.first_prompt,
            "lastPrompt": main.last_prompt,
            "lastReply": last_reply,
            "startedAt": min((f.first_ts for f in files if f.first_ts), default=""),
            "lastAt": max((f.last_ts for f in files), default=""),
            "prompts": main.prompts,
            "subagents": len(files) - 1,
            "messages": sum(models.values()),
            "models": dict(models),
            "tokens": tokens,
            "days": dict(days),
        }
        docs[sid] = doc
        w = wts.setdefault(wt, {"id": wt, "sessions": 0, "lastAt": "", **_zero()})
        w["sessions"] += 1
        w["lastAt"] = max(w["lastAt"], doc["lastAt"])
        for k in (*TOKEN_KEYS, "total", "unpricedTokens"):
            w[k] += tokens[k]
        w["costUsd"] = round(w["costUsd"] + tokens["costUsd"], 6)
    for u in usage.values():
        u["sessionCount"] = len(u.pop("sessions"))
    return docs, usage, wts
