"""Step check runner (step i8; round 1, 2026-11-10: "The bridge, ticked command"; the owner's picks 2026-11-12:
"Session proposes, you edit + tick", "On done + a Run check button", "Step turns failed, chain stops", "PowerShell,
plan folder, 10 min").

One record per step, planChecks/<plan id>_<step id>:
  command: the check command; proposedBy "session" (step_update's check_command) or "owner" (edited on the page).
  tick: {ok, hash, at}: the owner's tick; it holds the command's hash, so an edited command is unticked until the
        owner ticks it again (the same rule as the harness ticks).
  state: "idle", "queued" (a run is asked for) or "running".
  last, runs: each run's exit code, time, trigger ("done" or "button") and the last 200 lines of its output.

A run is a command {action: "step_check"} for the plan's machine: the session's done report asks for one when the
command is ticked, and the page's Run check button asks for one any time. The bridge runs only a ticked command, with
powershell -NoProfile in the plan's folder, which must sit inside WORK_ROOTS; it stops the run at 10 minutes. When a
check exits non-zero while the step stands done, the step gets a failed version with the exit code, so Run all steps
stops there; Run all steps waits while a check is queued or running.

F4, done needs a receipt (plan bf73af63; the owner's picks, 2026-11-13: "Check or checked pictures", "Badge only";
2026-11-19: "Done waits for its receipt", "All done before F4 without receipt"): a session's done report saves the step
as "checking" (inbox.py step_update); the ticked check run here then settles it: exit 0 -> a done version with its
receipt {kind "check", commit, at, exit, seconds, command, output}; any other end -> failed. The pictures path settles
in evidence.py the same way, with settle() below.
"""
from __future__ import annotations

import os
import subprocess
import threading
import time
import uuid

from .chain import item_hash
from .inbox import now_iso, step_v
from .redact import redact

TIMEOUT_S = 600
TAIL_LINES = 200
TAIL_CHARS = 16000
KEEP_RUNS = 10
BUSY = ("queued", "running")
CHECKING = "checking"


def commit_of(cwd: str) -> str:
    """The plan folder's git commit (short hash, "+dirty" when it has changes), or "" outside git."""
    try:
        head = subprocess.run(["git", "-C", cwd, "rev-parse", "--short", "HEAD"], capture_output=True, text=True, timeout=20,
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if head.returncode != 0:
            return ""
        dirty = subprocess.run(["git", "-C", cwd, "status", "--porcelain", "--untracked-files=no"], capture_output=True,
                               text=True, timeout=20, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return head.stdout.strip() + ("+dirty" if dirty.stdout.strip() else "")
    except (OSError, subprocess.SubprocessError):
        return ""


def settle(store, plan: dict, sid: str, receipt: dict | None, why: str, by: str, push=None) -> bool:
    """F4: a step waiting for its receipt ("checking") becomes done with the receipt, or failed with why. Returns False
    when the step is not checking (nothing changes)."""
    pid = plan["id"]
    path = f"planSteps/{pid}_{sid}"
    step = store.get(path) or {}
    if step.get("state") != CHECKING:
        return False
    versions = list(step.get("versions") or [])
    state = "done" if receipt else "failed"
    ver = {"n": len(versions) + 1, "state": state, "at": now_iso(), "planVersion": int(plan.get("current", 0)), "by": by,
           "stepV": step_v(store, plan, sid),
           "reply": (f"- Receipt: {receipt.get('kind')} passed" + (f" · commit {receipt['commit']}" if receipt.get("commit") else "")
                     if receipt else redact(why, 8000))}
    if receipt:
        ver["receipt"] = receipt
    versions.append(ver)
    store.put_many({path: {**step, "state": state, "versions": versions, "updatedAt": now_iso()}})
    if push is not None:
        push.notify(f"Step {state}: {sid}", (f"receipt {receipt.get('kind')}" if receipt else why)[:160], f"/?plan={pid}", f"plan-{pid}-{sid}")
    return True


def owner_confirm(store, plan: dict, sid: str, note: str = "", push=None) -> dict:
    """The owner's "I checked it" receipt (the owner, 2026-11-22, plan 41188c93: "option C and use it to mark S6
    done"): for a check only a person can run (a real phone, a sign-in), the owner's own word on the page is the
    receipt. Only for a step whose session reported done: waiting for its receipt (checking), or failed after a done
    report. The step becomes done with receipt {kind "owner", at, note, commit}. Raises ValueError otherwise."""
    pid = plan["id"]
    path = f"planSteps/{pid}_{sid}"
    step = store.get(path) or {}
    versions = list(step.get("versions") or [])
    reported = any(v.get("state") in ("checking", "done") or v.get("receiptBy") for v in versions)
    if step.get("state") not in (CHECKING, "failed") or not reported:
        raise ValueError(f"{sid} is {step.get('state') or 'not started'}: the owner's receipt is only for a step the "
                         "session reported done (waiting for its receipt, or failed after a done report)")
    receipt = {"kind": "owner", "at": now_iso(), "note": redact(str(note or "").strip(), 2000),
               "commit": commit_of(plan.get("cwd", "")) if plan.get("cwd") else ""}
    ver = {"n": len(versions) + 1, "state": "done", "at": receipt["at"], "planVersion": int(plan.get("current", 0)),
           "by": "owner", "stepV": step_v(store, plan, sid), "reply": "- Receipt: the owner checked it" + (f": {receipt['note']}" if receipt["note"] else ""),
           "receipt": receipt}
    store.put_many({path: {**step, "state": "done", "versions": versions + [ver], "updatedAt": now_iso()}})
    if push is not None:
        push.notify(f"Step done: {sid}", "receipt owner", f"/?plan={pid}", f"plan-{pid}-{sid}")
    return receipt


def check_hash(command: str) -> str:
    """The same hash as the page's checkHash (web/src/harness.ts itemHash with kind "check")."""
    return item_hash({"kind": "check", "item": command})


def ticked(rec: dict | None) -> bool:
    t = (rec or {}).get("tick") or {}
    cmd = str((rec or {}).get("command") or "").strip()
    return bool(cmd) and bool(t.get("ok")) and t.get("hash") == check_hash(cmd)


def tail(text: str) -> str:
    lines = text.replace("\r\n", "\n").rstrip("\n").split("\n")
    return redact("\n".join(lines[-TAIL_LINES:])[-TAIL_CHARS:], TAIL_CHARS)


def inside(cwd: str, roots: list[tuple[str, str]]) -> bool:
    """The plan's folder is one of WORK_ROOTS or inside one (real paths, any case)."""
    if not cwd or not os.path.isdir(cwd):
        return False
    full = os.path.normcase(os.path.realpath(cwd))
    for _, r in roots:
        root = os.path.normcase(os.path.realpath(r))
        if full == root or full.startswith(root.rstrip("\\/") + os.sep):
            return True
    return False


def auto_tick(store, plan_id: str, step_id: str) -> bool:
    """C, the plan's Auto-tick switch (planPicks/<plan id>.autoTick; the owner's pick 2026-11-25 "for c default is
    off"): when on, the step's command is ticked by the bridge (tick.by "auto"). Returns True when it ticked now."""
    if not (store.get(f"planPicks/{plan_id}") or {}).get("autoTick"):
        return False
    path = f"planChecks/{plan_id}_{step_id}"
    rec = store.get(path) or {}
    cmd = str(rec.get("command") or "").strip()
    if not cmd or ticked(rec):
        return False
    store.update(path, {"tick": {"ok": True, "hash": check_hash(cmd), "at": now_iso(), "by": "auto"}, "updatedAt": now_iso()})
    return True


def propose(store, plan_id: str, step_id: str, command: str) -> None:
    """The session's proposal (step_update's check_command). A changed command keeps the old tick, which no longer
    matches its hash, so it shows unticked until the owner ticks it."""
    path = f"planChecks/{plan_id}_{step_id}"
    old = store.get(path) or {}
    if str(old.get("command") or "") != command:
        store.put_many({path: {**old, "id": f"{plan_id}_{step_id}", "planId": plan_id, "stepId": step_id, "command": command,
                               "proposedBy": "session", "proposedAt": now_iso(), "state": old.get("state") or "idle",
                               "updatedAt": now_iso()}})
    auto_tick(store, plan_id, step_id)


def queue(store, plan: dict, step_id: str, trigger: str, machine: str) -> str | None:
    """Asks the plan's machine to run the step's check, if it is ticked. Returns the command id, or None."""
    pid = plan["id"]
    path = f"planChecks/{pid}_{step_id}"
    rec = store.get(path)
    if not ticked(rec):
        return None
    cid = uuid.uuid4().hex[:20]
    store.put_many({f"commands/{cid}": {"id": cid, "action": "step_check", "machine": plan.get("machine") or machine,
                                        "planId": pid, "stepId": step_id, "trigger": trigger, "status": "new",
                                        "createdAt": now_iso()}})
    store.update(path, {"state": "queued", "updatedAt": now_iso()})
    return cid


def run_command(command: str, cwd: str, timeout: int = TIMEOUT_S) -> tuple[int | None, str, float]:
    """(exit code or None when stopped at the timeout, the output, seconds). stdout and stderr together, as UTF-8."""
    t0 = time.monotonic()
    ps = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ErrorActionPreference = 'Continue'; " + command + \
         "; if ($LASTEXITCODE -ne $null) { exit $LASTEXITCODE } elseif (-not $?) { exit 1 }"
    p = subprocess.Popen(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps], cwd=cwd,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    try:
        out, _ = p.communicate(timeout=timeout)
        code: int | None = p.returncode
    except subprocess.TimeoutExpired:
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(p.pid)], capture_output=True,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        out, _ = p.communicate()
        code = None
    return code, out.decode("utf-8", errors="replace"), round(time.monotonic() - t0, 1)


class StepChecks:
    def __init__(self, store, machine: str, roots: list[tuple[str, str]], chains=None, push=None, runner=run_command):
        self.store, self.machine, self.roots, self.chains, self.push, self.runner = store, machine, roots, chains, push, runner
        self.threads: dict[str, threading.Thread] = {}

    def start(self, c: dict, wait: bool = False) -> str:
        """The command {action: "step_check"}: refused unless ticked and inside WORK_ROOTS; else runs in a thread."""
        cid, pid, sid = c["id"], str(c.get("planId") or ""), str(c.get("stepId") or "")
        path = f"planChecks/{pid}_{sid}"
        plan = self.store.get(f"plans/{pid}") or {}
        rec = self.store.get(path) or {}
        why = ("No such plan." if not plan else "No check command on this step." if not str(rec.get("command") or "").strip()
               else "The check command is not ticked." if not ticked(rec)
               else "The plan's folder is not inside a work folder on this machine." if not inside(plan.get("cwd", ""), self.roots)
               else "")
        if why:
            self.store.update(f"commands/{cid}", {"status": "failed", "endedAt": now_iso(), "error": why})
            if rec:
                self.store.update(path, {"state": "idle", "updatedAt": now_iso()})
            if plan and (self.store.get(f"planSteps/{pid}_{sid}") or {}).get("state") == CHECKING:
                # C: a check that cannot run asks the owner (stepgate.py) instead of failing the step
                from .stepgate import ask as gate_ask
                gate_ask(self.store, {**plan, "id": pid}, sid, "refused", f"Why: {why}", self.machine, self.push)
            self._after(pid)
            return f"{cid}: step check refused, {why}"
        self.store.update(f"commands/{cid}", {"status": "running", "startedAt": now_iso()})
        self.store.update(path, {"state": "running", "updatedAt": now_iso()})
        t = threading.Thread(target=self._run, args=(c, plan, rec), daemon=True)
        self.threads[cid] = t
        t.start()
        if wait:
            t.join()
        return f"{cid}: step check {pid} {sid} running"

    def _run(self, c: dict, plan: dict, rec: dict) -> None:
        cid, pid, sid = c["id"], plan["id"], c["stepId"]
        path = f"planChecks/{pid}_{sid}"
        at = now_iso()
        commit = commit_of(plan["cwd"])
        try:
            code, out, secs = self.runner(rec["command"], plan["cwd"])
        except OSError as e:
            code, out, secs = -1, f"could not start: {e}", 0.0
        run = {"at": at, "endedAt": now_iso(), "exit": code, "seconds": secs, "trigger": c.get("trigger") or "button",
               "command": rec["command"], "tail": tail(out) if code is not None else tail(out) + f"\n[stopped at {TIMEOUT_S // 60} min]",
               "timedOut": code is None, "runId": cid}
        cur = self.store.get(path) or {}
        runs = ([run] + list(cur.get("runs") or []))[:KEEP_RUNS]
        self.store.update(path, {"state": "idle", "last": run, "runs": runs, "updatedAt": now_iso()})
        ok = code == 0
        self.store.update(f"commands/{cid}", {"status": "done", "endedAt": now_iso(), "exit": code})
        step = self.store.get(f"planSteps/{pid}_{sid}") or {}
        if step.get("state") == CHECKING:  # F4: the done report waits for this run
            receipt = {"kind": "check", "commit": commit, "at": run["endedAt"], "exit": code, "seconds": secs,
                       "command": rec["command"], "output": run["tail"], "runId": cid} if ok else None
            settle(self.store, plan, sid, receipt, self._why(run), "check", self.push)
        elif not ok and step.get("state") == "done":
            self._fail(plan, sid, step, run)
        self._after(pid)

    @staticmethod
    def _why(run: dict) -> str:
        code = "stopped at 10 min" if run["timedOut"] else f"exit {run['exit']}"
        lines = run["tail"].split("\n")[-20:]
        return (f"- Check failed ({code}, {run['seconds']} s, by the bridge): `{run['command']}`\n"
                "- The step was reported done; the check says otherwise\n\n```\n" + "\n".join(lines) + "\n```")

    def _fail(self, plan: dict, sid: str, step: dict, run: dict) -> None:
        """The owner's pick "Step turns failed, chain stops": a failed step version with the exit code and the output."""
        pid = plan["id"]
        versions = list(step.get("versions") or [])
        n = len(versions) + 1
        code = "stopped at 10 min" if run["timedOut"] else f"exit {run['exit']}"
        reply = self._why(run)
        versions.append({"n": n, "state": "failed", "reply": redact(reply, 8000), "at": now_iso(),
                         "planVersion": int(plan.get("current", 0)), "by": "check", "stepV": step_v(self.store, plan, sid)})
        self.store.put_many({f"planSteps/{pid}_{sid}": {**step, "state": "failed", "versions": versions, "updatedAt": now_iso()}})
        if self.push is not None:
            self.push.notify(f"Check failed: step {sid}", f"{code}: {run['command']}"[:160], f"/?plan={pid}", f"plan-{pid}-{sid}")

    def _after(self, pid: str) -> None:
        if self.chains is not None:
            try:
                self.chains.after({"planId": pid})
            except Exception:  # the chain re-checks on the next run's end and at the bridge's start
                pass
