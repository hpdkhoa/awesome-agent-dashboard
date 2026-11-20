"""The owner's 10 s glance test of the report board (plan 44fc4979 s5). The owner's words: "Both" (auto rule check +
owner 10 s glance test: what for, done, next, blocked, per redesign); the pick, 2026-11-20: "Button on the board" (the
board shows 10 s, hides, the owner writes 4 answers; the session scores them against the plan, 0 to 4, saved per version).

One record per plan, planGlance/<plan id>:
  tests: newest first (KEEP): {at, version, answers {whatFor, done, next, blocked}, truth (what the plan said then),
         score 0..4 or None, marks [{q, verdict right | partly | wrong, why}], runId, error}.
  state: "idle", "queued" or "running".
The scoring is a fresh one-off claude run with no edits (like the evidence check); it ends with one JSON line.
right = 1, partly = 0.5, wrong = 0.
"""
from __future__ import annotations

import json
import re
import uuid

from .inbox import now_iso
from .redact import redact

KEEP = 20
QUESTIONS = [("whatFor", "What is this plan for?"), ("done", "What is done?"), ("next", "What is next?"),
             ("blocked", "What is blocked or waits for the owner?")]
POINTS = {"right": 1.0, "partly": 0.5, "wrong": 0.0}


def truth_of(store, pid: str, n: int) -> dict:
    """What the plan said at version n: What for, and the steps by state (done, next, blocked = failed or waiting)."""
    v = store.get(f"planVersions/{pid}_v{n}") or {}
    parts = v.get("parts") or {}
    steps = parts.get("steps") or []
    state = {s["id"]: (store.get(f"planSteps/{pid}_{s['id']}") or {}).get("state", "next") for s in steps}
    name = lambda s: f"{s['id']} {s.get('title', '')}"  # noqa: E731
    waiting = [i.get("title", "") for i in store.where("inbox", "planId", pid)
               if i.get("kind") == "question" and not i.get("answer") and not i.get("withdrawn")]
    return {"whatFor": (parts.get("board") or {}).get("whatFor", ""),
            "done": [name(s) for s in steps if state[s["id"]] == "done"],
            "next": [name(s) for s in steps if state[s["id"]] in ("next", "now", "checking")],
            "blocked": [name(s) for s in steps if state[s["id"]] == "failed"] + [f"question: {t}" for t in waiting]}


def score_prompt(truth: dict, answers: dict) -> str:
    return (
        "Score the owner's glance test of a plan's report board. The owner looked at the board for 10 seconds, then "
        "answered 4 questions from memory. Compare each answer with what the plan says and judge the meaning, not the "
        "wording: right = it names the same thing, partly = some of it or vague, wrong = different or empty.\n"
        "What the plan says:\n" + json.dumps(truth, ensure_ascii=False, indent=1) + "\n"
        "The owner's answers:\n" + "\n".join(f"- {q} {answers.get(k, '')!r}" for k, q in QUESTIONS) + "\n"
        "Change nothing. End your answer with one line of JSON only: "
        '{"marks": [{"q": "whatFor|done|next|blocked", "verdict": "right|partly|wrong", "why": "a few words"}]}'
    )


def parse_score(text: str) -> dict | None:
    for m in reversed(list(re.finditer(r"\{.*\}", text or ""))):
        try:
            j = json.loads(m.group(0))
        except ValueError:
            continue
        if not isinstance(j, dict) or not isinstance(j.get("marks"), list):
            continue
        marks = {}
        for r in j["marks"]:
            if isinstance(r, dict) and r.get("q") in dict(QUESTIONS):
                v = str(r.get("verdict", "")).lower()
                marks[r["q"]] = {"q": r["q"], "verdict": v if v in POINTS else "wrong", "why": redact(str(r.get("why", "")), 300)}
        rows = [marks.get(k, {"q": k, "verdict": "wrong", "why": "not scored"}) for k, _ in QUESTIONS]
        return {"score": sum(POINTS[r["verdict"]] for r in rows), "marks": rows}
    return None


class Glance:
    def __init__(self, runs):
        self.runs = runs

    def start(self, c: dict) -> str:
        from .runs import NO_CLI, start_command
        from .planfrom import NO_EDITS
        r, store = self.runs, self.runs.store
        cid, pid = c["id"], str(c.get("planId") or "")
        plan = store.get(f"plans/{pid}") or {}
        path = f"planGlance/{pid}"
        rec = store.get(path) or {"id": pid, "planId": pid, "tests": []}
        n = int(c.get("version") or plan.get("current") or 0)
        answers = {k: redact(str((c.get("answers") or {}).get(k, "")), 1000) for k, _ in QUESTIONS}
        truth = truth_of(store, pid, n) if plan else {}
        test = {"at": now_iso(), "version": n, "answers": answers, "truth": truth, "score": None, "marks": [], "runId": cid}
        why = "No such plan." if not plan else NO_CLI if not r.claude else ""
        if why:
            test["error"] = why
            store.put_many({path: {**rec, "tests": ([test] + list(rec.get("tests") or []))[:KEEP], "state": "idle"}})
            store.update(f"commands/{cid}", {"status": "failed", "endedAt": now_iso(), "error": why})
            return f"{cid}: glance refused, {why}"
        store.put_many({path: {**rec, "id": pid, "planId": pid, "tests": ([test] + list(rec.get("tests") or []))[:KEEP],
                               "state": "running"}})
        session, mode = str(uuid.uuid4()), r.mode()
        model, effort = r.run_with(c)
        cmd = start_command(r.claude, score_prompt(truth, answers), session, mode, model, effort, keep=False) + ["--disallowedTools", NO_EDITS]
        p = r._spawn(cid, cmd, plan.get("cwd") or "")
        store.update(f"commands/{cid}", {"status": "running", "sessionId": session, "pid": p.pid, "startedAt": now_iso(),
                                         "permissionMode": mode, "model": model, "effort": effort, "noSession": True,
                                         "workType": f"glance test · plan v{n}"})
        return f"{cid}: glance test scoring for {pid} v{n}"

    def finished(self, c: dict, status: str, result: str, error: str = "") -> None:
        store = self.runs.store
        pid = c.get("planId", "")
        path = f"planGlance/{pid}"
        rec = store.get(path) or {}
        got = parse_score(result) if status == "done" else None
        tests = list(rec.get("tests") or [])
        for t in tests:
            if t.get("runId") == c["id"]:
                if got:
                    t.update(got)
                else:
                    t["error"] = redact(error or "The scoring gave no JSON line.", 500)
        store.put_many({path: {**rec, "tests": tests, "state": "idle"}})
