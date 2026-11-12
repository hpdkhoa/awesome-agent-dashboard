"""Run all steps: the bridge runs a plan's steps one after another (the owner's words, 2026-11-10: "when plan steps
start I need an automatic job or way to start all the steps without need me to press every single one"; picks "Chain,
stop on fail" and "Button only"; note: "when resume or restart just work on the remaining not done items, if the item
is out dated then I'll be the one press rerun manually").

One record per plan, planChains/<plan id>, written by the page's Run all steps button:
  state "on": the chain goes; "stopped": the owner's Stop or a fail; "done": no step left.
  runId, stepId: the Run step command going now and its step.
The steps run in the plan's one session, so one at a time. The next step starts only when the last run ended done and
the session reported the step done (step_update). A run that failed or was stopped, or a step reported failed or left
without a done report, stops the chain and pushes the owner. A run lost to a bridge restart is not a fail: the chain
goes on with the steps not done, that step first. A paused run (usage limit) waits for its continue and follows it.
A step counts as done when its last report is done, on any plan version: an outdated step is the owner's to rerun.
"""
from __future__ import annotations

import time
import uuid

from .inbox import now_iso

GOING = ("new", "running", "waiting", "stopping")


def item_hash(h: dict) -> str:
    """FNV-1a, 32 bits, the same as the page's itemHash (web/src/harness.ts): a tick holds it, so an item whose text
    changed shows unticked until the owner approves it again."""
    x = 0x811C9DC5
    for ch in f"{h.get('kind', '')}:{h.get('item', '')}":
        x = ((x ^ ord(ch)) * 0x01000193) & 0xFFFFFFFF
    return f"{x:08x}"


def harness_note(items: list[dict] | None, ticks: dict | None) -> str:
    """The same note as the page's buildNote (web/src/harness.ts), made when each step starts, from the harness of the
    plan's current version and the owner's ticks then (the owner's words, 2026-11-04: "the unticked item won't be used
    or added into build phase")."""
    if not items:
        return ""
    t = (ticks or {}).get("items") or {}
    ok = [h["id"] for h in items if (t.get(h["id"]) or {}).get("ok") and t[h["id"]].get("hash") == item_hash(h)]
    left = [h["id"] for h in items if h["id"] not in ok]
    return f" Use only the approved harness items: {', '.join(ok) or 'none'}." + (f" Not approved, left out: {', '.join(left)}." if left else "")


def step_text(step: dict, harness: str = "") -> str:
    """The same words as the page's Run step (web/src/data.ts runStep)."""
    return f"Work on step {step['id']}: {step['title']}. Report it with step_update.{harness}"


class Chains:
    """Moves only on events, so it adds no store query to the bridge's loop: the page's Run all steps command, the end
    of a chain run, and the bridge's start (a chain left on goes on)."""

    def __init__(self, store, machine: str, push=None):
        self.store, self.machine, self.push = store, machine, push

    def start(self, c: dict) -> str:
        """The page's Run all steps: {action: "chain", planId, model, effort, fresh}."""
        pid = str(c.get("planId") or "")
        old = self.store.get(f"planChains/{pid}") or {}
        if old.get("state") == "on" and (self.store.get(f"commands/{old.get('runId')}") or {}).get("status") in GOING:
            self.store.update(f"commands/{c['id']}", {"status": "failed", "endedAt": now_iso(), "error": "Run all steps is already going."})
            return f"{c['id']}: refused, chain {pid} already going"
        ch = {"planId": pid, "machine": self.machine, "state": "on", "startedAt": now_iso(), "updatedAt": now_iso(),
              "runId": None, "stepId": None, "reason": None, "endedAt": None,
              **{k: c.get(k) or None for k in ("model", "effort", "fresh")}}
        self.store.put_many({f"planChains/{pid}": ch})
        self.store.update(f"commands/{c['id']}", {"status": "done", "endedAt": now_iso()})
        return self._one(ch) or f"chain {pid}: started"

    def after(self, c: dict) -> str | None:
        """A run with the chain mark ended: go on if the chain still waits on it."""
        ch = self.store.get(f"planChains/{c.get('planId', '')}") or {}
        return self._one(ch) if ch.get("state") == "on" and ch.get("machine") == self.machine else None

    def resume(self) -> list[str]:
        """The bridge's start: chains left on go on with the steps not done (the owner's note: "when resume or restart
        just work on the remaining not done items")."""
        return [x for x in (self._one(ch) for ch in self.store.where("planChains", "state", "on")
                            if ch.get("machine") == self.machine) if x]

    def _stop(self, ch: dict, why: str, state: str = "stopped") -> str:
        pid = ch["planId"]
        self.store.update(f"planChains/{pid}", {"state": state, "reason": why, "endedAt": now_iso(), "updatedAt": now_iso()})
        plan = self.store.get(f"plans/{pid}") or {}
        if self.push is not None:
            title = "All steps done" if state == "done" else "Run all steps stopped"
            self.push.notify(f"{title}: {plan.get('title', '')}", why, f"/?plan={pid}", f"chain-{pid}")
        return f"chain {pid}: {state}, {why}"

    def _one(self, ch: dict) -> str | None:
        pid = ch["planId"]
        run_id, step_id = ch.get("runId"), ch.get("stepId")
        if run_id:
            c = self.store.get(f"commands/{run_id}") or {}
            while c.get("continuedBy"):  # a paused run went on as a new run: follow it
                run_id = c["continuedBy"]
                c = self.store.get(f"commands/{run_id}") or {}
                self.store.update(f"planChains/{pid}", {"runId": run_id, "updatedAt": now_iso()})
            status = c.get("status")
            if status in GOING or status == "paused":
                return None
            # step i8: a done report asked for the step's check; wait for it (stepcheck.py calls back at its end)
            if status == "done" and (self.store.get(f"planChecks/{pid}_{step_id}") or {}).get("state") in ("queued", "running"):
                return None
            sv = self.store.get(f"planSteps/{pid}_{step_id}") or {}
            rep = sv.get("state")
            by_check = ((sv.get("versions") or [{}])[-1] or {}).get("by") == "check"
            if status in ("failed", "stopped"):
                return self._stop(ch, f"step {step_id}: the run {status}" + (f": {c['error'][:120]}" if c.get("error") else ""))
            if status == "done" and rep == "failed":
                return self._stop(ch, f"step {step_id}: " + ("its check failed" if by_check else "the session reported it failed"))
            if status == "done" and rep != "done":
                return self._stop(ch, f"step {step_id}: the run ended with no done report (state {rep or 'none'})")
            # done, or lost to a bridge restart: go on with the steps not done
        plan = self.store.get(f"plans/{pid}") or {}
        if not plan:
            return self._stop(ch, "the plan is gone")
        if (plan.get("phase") or "explore") == "explore":
            return self._stop(ch, "the plan is in Explore: no step runs there")
        v = self.store.get(f"planVersions/{pid}_v{plan.get('current', 0)}") or {}
        steps = (v.get("parts") or {}).get("steps") or []
        left = [st for st in steps if (self.store.get(f"planSteps/{pid}_{st['id']}") or {}).get("state") != "done"]
        if not left:
            return self._stop(ch, f"{len(steps)} of {len(steps)} steps done", "done")
        st = left[0]
        nid = uuid.uuid4().hex[:20]
        text = step_text(st, harness_note(v.get("harness"), self.store.get(f"planHarness/{pid}")))
        w = {k: ch[k] for k in ("model", "effort", "fresh") if ch.get(k)}
        self.store.put_many({f"commands/{nid}": {
            "id": nid, "action": "message", "machine": plan.get("machine") or self.machine, "sessionId": plan.get("sessionId", ""),
            "cwd": plan.get("cwd", ""), "prompt": text, "ownerText": text, "planId": pid, "stepId": st["id"],
            "chain": True, "status": "new", "createdAt": now_iso(), **w}})
        self.store.update(f"planChains/{pid}", {"runId": nid, "stepId": st["id"], "left": len(left), "updatedAt": now_iso()})
        return f"chain {pid}: step {st['id']} sent as {nid} ({len(left)} left)"
