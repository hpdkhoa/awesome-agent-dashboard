"""C, the owner's gate on a step's check (the owner, 2026-11-25: "the check/validate for the steps now seems to be hard to
use and very unpredictable, it need inbox review but I said ok or agree but the plan step still failed, and I don't
have the auto check run config so the steps will stop mid run if reach check run phase inside a step"; the pick:
"build a b c, for c default is off").

When a done report cannot get its receipt by itself, the step no longer fails or throws: it stays "checking" and the
bridge asks the owner one inbox question with buttons that act on the step:
  tick:    a check command is proposed but not ticked: "Tick and run the check" / "I checked it" / "Not done"
  none:    no check command and no picture: "I checked it" / "Not done"
  unclear: the LLM check of the pictures could not tell: "I checked it" / "Check the pictures again" / "Not done"
  refused: the check or the LLM check could not run: "Tick and run the check" (when a command exists) / "I checked it"
           / "Not done"
The answer goes to the bridge, never to a session (sessionId ""): deliver.py turns it into a command {action:
"step_gate"}, runs.py calls act() and moves the plan's chain on. A written "ok", "agree", "yes" (and the Vietnamese
"đồng ý", "được") with no button picks the recommended option; any other text without a button opens the question
again with a note. A written "ok" on the step's result card, while its gate question is open, answers that question.

Auto-tick (planPicks/<plan id>.autoTick, default off; the owner turns it on per plan): the session's proposed check is
ticked by the bridge when proposed (stepcheck.propose), tick.by "auto", so a done report runs it with no question.
"""
from __future__ import annotations

import re
import uuid

from .inbox import now_iso
from .redact import redact

TICK, CHECKED, AGAIN, NOT_DONE = "Tick and run the check", "I checked it", "Check the pictures again", "Not done"
KINDS = ("tick", "none", "unclear", "refused")
AGREE = re.compile(r"^\s*(ok(ay)?|yes|y|agree[ds]?|approve[ds]?|lgtm|go( ahead)?|đồng ý|dong y|được|duoc|ừ|uh)\b[\s.!,]*$", re.I)

WHY = {
    "tick": "The session proposed a check but it is not ticked, and the report has no picture.",
    "none": "The step has no check command and the report has no picture.",
    "unclear": "The LLM check of the pictures could not tell if the step is done.",
    "refused": "The check could not run.",
}
DOES = {
    TICK: ("ticks the command and the bridge runs it now", "exit 0 = done, else failed"),
    CHECKED: ("your word is the receipt (kind owner)", "done now, no run"),
    AGAIN: ("runs the LLM check of the pictures again", "pass = done, unclear = asks again"),
    NOT_DONE: ("the step turns failed", "the chain stops there"),
}


def options_for(kind: str, command: str) -> list[str]:
    if kind == "tick" or (kind == "refused" and command):
        return [TICK, CHECKED, NOT_DONE]
    if kind == "unclear":
        return [CHECKED, AGAIN, NOT_DONE]
    return [CHECKED, NOT_DONE]


def open_gate(store, plan_id: str, step_id: str) -> dict | None:
    return next((i for i in store.where("inbox", "planId", plan_id)
                 if i.get("stepGate") and i.get("stepId") == step_id and i.get("status") == "open"), None)


def ask(store, plan: dict, sid: str, kind: str, detail: str, machine: str, push=None) -> str:
    """Posts the gate question for a step waiting for its receipt (one open per step: an older one closes). Returns
    its id."""
    pid = plan["id"]
    old = open_gate(store, pid, sid)
    if old:
        store.update(f"inbox/{old['id']}", {"status": "closed", "closedWhy": "a newer gate question on the step"})
    command = str((store.get(f"planChecks/{pid}_{sid}") or {}).get("command") or "").strip()
    labels = options_for(kind, command)
    opts = [{"label": lab, "detail": DOES[lab][0], "differs": DOES[lab][1],
             "example": {"type": "text", "draft": (f"Runs: {command}" if lab == TICK else DOES[lab][0])}} for lab in labels]
    iid = uuid.uuid4().hex[:20]
    text = (f"- {WHY[kind]}\n" + (f"- Check command: `{command}`\n" if command else "")
            + (f"- {detail.strip()}\n" if detail.strip() else "")
            + "- The step waits as checking; nothing runs until you answer. Writing ok picks the recommended option.")
    store.put_many({f"inbox/{iid}": {
        "id": iid, "kind": "question", "sessionId": "", "machine": plan.get("machine") or machine, "cwd": plan.get("cwd", ""),
        "title": redact(f"Step {sid}: how is it checked?", 200), "text": redact(text, 4000), "options": opts,
        "recommended": 0, "files": [], "status": "open", "createdAt": now_iso(), "answer": None,
        "planId": pid, "stepId": sid, "round": int(plan.get("current", 0)), "route": "owner", "topic": "approval",
        "stepGate": {"kind": kind, "at": now_iso()},
    }})
    if push is not None:
        push.notify(f"Step {sid} waits for you", WHY[kind][:160], f"/?item={iid}", iid)
    return iid


def choice_of(item: dict) -> str:
    """The button, or the recommended one for a written agree word; "" when the answer names neither."""
    a = item.get("answer") or {}
    labels = [o.get("label", "") for o in item.get("options") or []]
    if a.get("choice") in labels:
        return a["choice"]
    rec = item.get("recommended")
    if AGREE.match(str(a.get("text") or "")) and isinstance(rec, int) and 0 <= rec < len(labels):
        return labels[rec]
    return ""


def gate_for_result(store, item: dict) -> dict | None:
    """A written agree word on a step's result card while the step's gate question is open: that question."""
    if item.get("kind") != "result" or not item.get("planId") or not item.get("stepId"):
        return None
    if not AGREE.match(str((item.get("answer") or {}).get("text") or "")) or (item.get("answer") or {}).get("choice"):
        return None
    return open_gate(store, item["planId"], item["stepId"])


def act(store, item: dict, machine: str, push=None) -> tuple[str, bool]:
    """The owner's answer on a gate question, done on the step. Returns (what happened, the step settled)."""
    from .evidence import queue as evidence_queue
    from .stepcheck import CHECKING, check_hash, owner_confirm, queue, settle

    iid, pid, sid = item["id"], item.get("planId", ""), item.get("stepId", "")
    a = item.get("answer") or {}
    pick = choice_of(item)
    note = str(a.get("text") or "").strip()
    if not pick:
        store.update(f"inbox/{iid}", {"status": "open", "answer": None, "error": "Pick one of the buttons (or write ok for "
                                      f"the recommended one). Your words were kept: {note[:200]}",
                                      "thread": list(item.get("thread") or []) + [{"who": "owner", "kind": "answer", "text": note, "at": now_iso()}]})
        return f"{iid}: gate answer names no option, asked again", False
    plan = store.get(f"plans/{pid}") or {}
    step = store.get(f"planSteps/{pid}_{sid}") or {}
    done = {"status": "closed", "gateDone": {"choice": pick, "at": now_iso()}, "deliveredAt": now_iso(), "error": None}
    if not plan or step.get("state") not in (CHECKING, "failed"):
        store.update(f"inbox/{iid}", {**done, "gateDone": {**done["gateDone"], "outcome": f"nothing: the step is {step.get('state') or 'gone'}"}})
        return f"{iid}: step {sid} is {step.get('state')}, nothing to do", False
    plan = {**plan, "id": pid}
    outcome, settled = "", False
    if pick == TICK:
        path = f"planChecks/{pid}_{sid}"
        rec = store.get(path) or {}
        cmd = str(rec.get("command") or "").strip()
        if not cmd:
            outcome = "no check command to tick"
        else:
            store.update(path, {"tick": {"ok": True, "hash": check_hash(cmd), "at": now_iso(), "by": "owner-inbox"}})
            if step.get("state") != CHECKING:  # failed after a done report: wait for the run again
                vs = list(step.get("versions") or [])
                vs.append({"n": len(vs) + 1, "state": CHECKING, "at": now_iso(), "planVersion": int(plan.get("current", 0)),
                           "by": "owner", "reply": "- The owner ticked the check: running it", "receiptBy": "check"})
                store.put_many({f"planSteps/{pid}_{sid}": {**step, "state": CHECKING, "versions": vs, "updatedAt": now_iso()}})
            queue(store, plan, sid, "done", machine)
            outcome = f"ticked and queued: {cmd}"
    elif pick == CHECKED:
        try:
            owner_confirm(store, plan, sid, note or "inbox: " + pick, push)
            outcome, settled = "done on the owner's receipt", True
        except ValueError as e:
            outcome = str(e)
    elif pick == AGAIN:
        evidence_queue(store, plan, sid, "check", "receipt", machine)
        outcome = "LLM check queued again"
    elif pick == NOT_DONE:
        settled = settle(store, plan, sid, None, "- The owner: not done" + (f": {note}" if note else ""), "owner", push)
        outcome = "failed on the owner's word" if settled else "the step was not waiting"
    store.update(f"inbox/{iid}", {**done, "gateDone": {**done["gateDone"], "outcome": redact(outcome, 400)}})
    return f"{iid}: gate {sid} {pick}: {outcome}", settled
