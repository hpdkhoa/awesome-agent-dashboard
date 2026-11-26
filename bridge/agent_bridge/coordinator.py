"""F7, question routing (plan bf73af63; the step: "each inbox item has a kind: owner-only (scope, policy, approval,
spend) or coordinator"; its check: "a non-owner kind never reaches the owner's inbox"; the owner, 2026-11-19: "Lift the
hold, build F7", "Plan session answers"; the source, rules-review.md: "Ask the right party: --needs-user only for what
the user alone decides (scope, policy, approvals, spending); GPU, host, job, CI, review and agent conflicts go to the
coordinator").

Every question a session asks names its route: one of OWNER_TOPICS (it goes to the owner's inbox as before) or
"coordinator". A coordinator question never goes to inbox/: it is kept in coordinator/<id>, sends no push, and the
bridge asks the plan's own session: a fork of it (--resume <plan session> --fork-session, never saved) reads the question
with the whole plan context, changes nothing, and ends with one JSON line; its answer goes back to the asking run's
inbox_ask / inbox_wait as the coordinator's answer.

coordinator/<id>: {id, kind "question", route "coordinator", topic, sessionId (asker), machine, cwd, planId, stepId,
  title, text, options, recommended, status open | running | answered | failed | delivered, createdAt, commandId,
  answer {choice, text, by "plan session", runId, at}, error}.
"""
from __future__ import annotations

import json
import re
import uuid

from .inbox import now_iso
from .redact import redact

OWNER_TOPICS = ("scope", "policy", "approval", "spend")
COORDINATOR = "coordinator"
ROUTES = (*OWNER_TOPICS, COORDINATOR)
# the fork answers only: no edits, no inbox (it never asks the owner on the asker's behalf), no approval prompts
NO_TOOLS = "Edit,Write,NotebookEdit,mcp__agent-inbox"


def route_of(route: str) -> str:
    """The route given to inbox_ask, cleaned; raises when it is missing or unknown."""
    r = str(route or "").strip().lower()
    if r not in ROUTES:
        raise ValueError("Every question names its route: one of " + ", ".join(OWNER_TOPICS) + " (only the owner "
                         "decides: it goes to the owner's inbox) or coordinator (GPU, host, job, CI, review, disk, agent "
                         "conflicts: the plan's session answers, never the owner's inbox). Got: " + (r or "nothing") + ".")
    return r


def ask(inbox, question: str, title: str = "", options: list[dict] | None = None, recommended: int | None = None,
        context: str = "", more_questions: list[dict] | None = None, route: str = "",
        files: list[str] | None = None) -> tuple[str, list[str]]:
    """inbox_ask's routing: every question names its route; one batch goes to one party. Owner topics go to the
    owner's inbox (inbox/, as before, the item stamped with its topic); coordinator questions go to coordinator/ and
    the plan's session. Returns (party "owner" | "coordinator", ids); raises ValueError when it refuses."""
    routes = [route_of(route)] + [route_of((q or {}).get("route", "")) for q in more_questions or []]
    if len({r == COORDINATOR for r in routes}) > 1:
        raise ValueError("One batch goes to one party: ask the owner's questions and the coordinator's questions in "
                         "two inbox_ask calls.")
    first = (title or question[:80], (context + "\n\n" + question).strip(), options, recommended)
    rest = [(q.get("title") or str(q.get("question", ""))[:80], str(q.get("question", "")), q.get("options"),
             q.get("recommended")) for q in more_questions or []]
    if routes[0] == COORDINATOR:
        return COORDINATOR, [post(inbox, *q) for q in [first, *rest]]
    from .inbox import repeat_of
    plan = inbox.open_plan()
    why = repeat_of(inbox.store, (plan or {}).get("id", ""), [q[0] for q in [first, *rest]])
    if why:
        raise ValueError(why.removeprefix("Not asked: "))
    if rest:
        own = [files] + [(q or {}).get("files") for q in more_questions or []]
        batch = [{"title": t, "text": x, "options": o, "recommended": r, "files": f, "extra": {"topic": topic}}
                 for (t, x, o, r), topic, f in zip([first, *rest], routes, own)]
        return "owner", inbox.post_batch(batch)
    return "owner", [inbox.post("question", *first, files, {"topic": routes[0]})]


def post(inbox, title: str, text: str, options: list[dict] | None, recommended: int | None) -> str:
    """Keeps a coordinator question and asks the plan's machine for the coordinator run. Returns the question's id."""
    plan = inbox.open_plan()
    if not plan:
        raise ValueError("A coordinator question needs a plan: this session has none, so no plan session can answer it.")
    if not plan.get("sessionId"):
        raise ValueError(f"Plan {plan['id']} has no session to answer coordinator questions.")
    qid, cid = uuid.uuid4().hex[:20], uuid.uuid4().hex[:20]
    opts = [{"label": redact(o.get("label", ""), 120), "detail": redact(o.get("detail", ""), 400)}
            for o in options or [] if isinstance(o, dict)]
    if recommended is not None and not 0 <= recommended < len(opts):
        recommended = None
    at = now_iso()
    inbox.store.put_many({
        f"coordinator/{qid}": {
            "id": qid, "kind": "question", "route": COORDINATOR, "topic": COORDINATOR, "sessionId": inbox.session_id,
            "machine": inbox.machine, "cwd": inbox.cwd, "planId": plan["id"], "stepId": plan.get("activeStep") or "",
            "title": redact(title, 200), "text": redact(text, 4000), "options": opts, "recommended": recommended,
            "status": "open", "createdAt": at, "commandId": cid, "answer": None, "error": None},
        f"commands/{cid}": {
            "id": cid, "action": "coordinator", "questionId": qid, "planId": plan["id"],
            "machine": plan.get("machine") or inbox.machine, "folder": plan.get("cwd", ""), "status": "new",
            "createdAt": at},
    })
    return qid


def prompt_for(plan: dict, q: dict) -> str:
    opts = "\n".join(f"- {o['label']}" + (f": {o['detail']}" if o.get("detail") else "")
                     + (" (the asker recommends this)" if q.get("recommended") == k else "")
                     for k, o in enumerate(q.get("options") or []))
    return (
        f"You are the coordinator of the plan \"{plan.get('title', '')}\" ({plan.get('id', '')}). A run on step "
        f"{q.get('stepId') or '(none)'} asks a question that is not the owner's to decide (not scope, policy, approval "
        "or spend), so it comes to you, the plan's own session, and never reaches the owner's inbox.\n"
        f"The question: {q.get('title', '')}\n{q.get('text', '')}\n"
        + (f"Its options:\n{opts}\n" if opts else "")
        + "Decide it from the plan, its rules and lessons, the records and the owner's rules. You may read files; "
        "change nothing. If it is really the owner's decision (scope, policy, approval, spend), say so as your answer "
        "and pick no option.\n"
        'End your answer with one line of JSON only: {"choice": "one option label exactly, or empty", '
        '"text": "your answer and the reason, a few words"}'
    )


def parse_answer(text: str, options: list[dict]) -> dict | None:
    """The last JSON line with a choice or a text; a choice that is not an option's label is dropped."""
    labels = {o.get("label", "") for o in options or []}
    for m in reversed(list(re.finditer(r"\{.*\}", text or ""))):
        try:
            j = json.loads(m.group(0))
        except ValueError:
            continue
        if not isinstance(j, dict) or not ({"choice", "text"} & j.keys()):
            continue
        choice = str(j.get("choice") or "").strip()
        return {"choice": choice if choice in labels else "", "text": redact(str(j.get("text") or ""), 1000)}
    return None


def answer_text(q: dict) -> str:
    a = q.get("answer") or {}
    parts = [f'The coordinator (the plan\'s session) answered your question "{q.get("title", "")}".']
    if a.get("choice"):
        parts.append(f"Choice: {a['choice']}.")
    parts.append(f"Note: {a['text']}" if a.get("text") else "No note.")
    return " ".join(parts)


def take(store, qid: str) -> str | None:
    """The coordinator's answer (or why it could not answer) for the asking run, marking it delivered; None while
    it is still open or running."""
    q = dict(store.get(f"coordinator/{qid}") or {})
    if q.get("status") not in ("answered", "failed"):
        return None
    store.update(f"coordinator/{qid}", {"status": "delivered", "deliveredAt": now_iso()})
    if q.get("status") == "failed":
        return (f'The coordinator could not answer "{q.get("title", "")}": {q.get("error") or "no answer"}. '
                "Ask again with inbox_ask, or go on with the part you can decide.")
    return answer_text(q)


class Coordinator:
    """The bridge side: starts the coordinator run (a fork of the plan's session) and keeps its answer."""

    def __init__(self, runs):
        self.runs = runs  # runs.Runs: _spawn, store, roots, claude, mode, run_with

    def _fail(self, cid: str, qid: str, why: str) -> str:
        store = self.runs.store
        store.update(f"commands/{cid}", {"status": "failed", "endedAt": now_iso(), "error": why})
        if store.get(f"coordinator/{qid}"):
            store.update(f"coordinator/{qid}", {"status": "failed", "error": why, "updatedAt": now_iso()})
        return f"{cid}: coordinator refused, {why}"

    def start(self, c: dict) -> str:
        import os

        from .runs import NO_CLI, STREAM, folder_ok, mode_args, model_args
        r, store = self.runs, self.runs.store
        cid, qid = c["id"], str(c.get("questionId") or "")
        q = store.get(f"coordinator/{qid}") or {}
        plan = store.get(f"plans/{c.get('planId', '')}") or {}
        cwd = plan.get("cwd", "")
        why = ("No such question." if not q else "No such plan." if not plan
               else "The plan has no session." if not plan.get("sessionId")
               else "The plan's folder is not inside a work folder on this machine." if not (cwd and os.path.isdir(cwd) and folder_ok(cwd, r.roots))
               else NO_CLI if not r.claude else "")
        if why:
            return self._fail(cid, qid, why)
        model, effort = r.run_with(c)
        cmd = [r.claude, "-p", prompt_for(plan, q), *STREAM, "--resume", plan["sessionId"], "--fork-session",
               "--no-session-persistence", *mode_args(r.mode()), *model_args(model, effort), "--disallowedTools", NO_TOOLS]
        p = r._spawn(cid, cmd, cwd)
        store.update(f"commands/{cid}", {"status": "running", "pid": p.pid, "startedAt": now_iso(), "model": model,
                                         "effort": effort, "noSession": True, "forkOf": plan["sessionId"],
                                         "workType": f"coordinator · {q.get('stepId') or 'plan'} · {q.get('title', '')[:60]}"})
        store.update(f"coordinator/{qid}", {"status": "running", "updatedAt": now_iso()})
        return f"{cid}: coordinator run for {plan['id']} on {qid}"

    def finished(self, c: dict, status: str, result: str, error: str = "") -> None:
        store = self.runs.store
        qid = str(c.get("questionId") or "")
        q = store.get(f"coordinator/{qid}") or {}
        if not q:
            return
        a = parse_answer(result, q.get("options") or []) if status == "done" else None
        if a and (a["choice"] or a["text"]):
            store.update(f"coordinator/{qid}", {"status": "answered", "updatedAt": now_iso(),
                                                "answer": {**a, "by": "plan session", "runId": c["id"], "at": now_iso()}})
        else:
            store.update(f"coordinator/{qid}", {"status": "failed", "updatedAt": now_iso(),
                                                "error": redact(error or f"The coordinator run {status} with no answer line.", 500)})
