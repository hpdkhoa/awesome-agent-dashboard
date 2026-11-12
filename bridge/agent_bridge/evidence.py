"""8. Evidence: pictures that show each done step working (the owner's words, 2026-11-12: "I need the plan when done
will have an evidence section after result section, which capture the evidence of done for each step, this section
will have two flows: first is when done each step will add the evidence auto, second is I will have a button to manual
generate the evidence and another button to do the auto check from LLM side"; notes: "I want to have the image
evidences, not text", "I want to see the feature, the visual, the evidence"; picks: "Attach, else picture run",
"Fresh one-off run", "Mark only").

One record per step, planEvidence/<plan id>_<step id>:
  sets: the picture sets, newest first (KEEP_SETS): {at, by "report" | "run", trigger "done" | "button", runId,
        stepVersion, pictures: [absolute paths]}.
  state: "idle", "queued" or "running"; what: "pictures" or "check" while busy; error: the last refusal or failure.
  check: the last LLM check: {at, runId, set (the set's at), overall pass | fail | unclear, pictures: [{path, verdict,
         why}], note}. Mark only: the step's state never changes.

Flow 1, auto: a done report (step_update) attaches picture paths (evidence=); the ones that exist and are pictures
make a set. None attached, or none found: the bridge starts a picture run.
Flow 2, buttons: Generate evidence (a picture run) and LLM check (a check run) on the page.
Both runs are fresh one-off claude runs (--no-session-persistence) in the plan's folder: a picture run saves its
pictures under .plan_data/<plan id>/evidence/<step id>/<run id>/ and the bridge takes every picture found there; a
check run reads the last set's pictures and ends with one JSON line, which the bridge keeps as the marks.
"""
from __future__ import annotations

import json
import os
import re
import uuid
from pathlib import Path

from .inbox import now_iso
from .redact import redact

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif", ".svg"}
KEEP_SETS = 10
MAX_PICTURES = 24
BUSY = ("queued", "running")
VERDICTS = ("pass", "fail", "unclear")


def evidence_dir(cwd: str, plan_id: str, step_id: str, run_id: str) -> Path:
    return Path(cwd) / ".plan_data" / plan_id / "evidence" / step_id / run_id


def pictures(paths, cwd: str) -> list[str]:
    """The given paths that are pictures and exist, absolute (a relative path is read from the plan's folder)."""
    out: list[str] = []
    for p in paths or []:
        p = str(p or "").strip().strip("`'\"")
        if not p:
            continue
        full = Path(p) if os.path.isabs(p) else Path(cwd or ".") / p
        if full.suffix.lower() in IMAGE_EXT and full.is_file():
            s = str(full.resolve())
            if s not in out:
                out.append(s)
    return out[:MAX_PICTURES]


def found_in(folder: Path) -> list[str]:
    """Every picture a picture run saved in its folder, by name."""
    if not folder.is_dir():
        return []
    return sorted(str(f.resolve()) for f in folder.rglob("*") if f.is_file() and f.suffix.lower() in IMAGE_EXT)[:MAX_PICTURES]


def add_set(store, plan_id: str, step_id: str, pics: list[str], by: str, trigger: str, run_id: str = "",
            step_version: int | None = None) -> None:
    path = f"planEvidence/{plan_id}_{step_id}"
    old = store.get(path) or {}
    s = {"at": now_iso(), "by": by, "trigger": trigger, "runId": run_id, "pictures": pics}
    if step_version is not None:
        s["stepVersion"] = step_version
    sets = ([s] + list(old.get("sets") or []))[:KEEP_SETS]
    store.put_many({path: {**old, "id": f"{plan_id}_{step_id}", "planId": plan_id, "stepId": step_id, "sets": sets,
                           "state": "idle", "what": None, "error": None, "updatedAt": now_iso()}})


def queue(store, plan: dict, step_id: str, what: str, trigger: str, machine: str) -> str:
    """Asks the plan's machine for a picture run or a check run. Returns the command id."""
    pid = plan["id"]
    cid = uuid.uuid4().hex[:20]
    store.put_many({f"commands/{cid}": {"id": cid, "action": "evidence", "what": what, "machine": plan.get("machine") or machine,
                                        "planId": pid, "stepId": step_id, "trigger": trigger, "status": "new",
                                        "folder": plan.get("cwd", ""), "createdAt": now_iso()}})
    path = f"planEvidence/{pid}_{step_id}"
    old = store.get(path) or {}
    store.put_many({path: {**old, "id": f"{pid}_{step_id}", "planId": pid, "stepId": step_id, "state": "queued",
                           "what": what, "error": None, "updatedAt": now_iso()}})
    return cid


def on_done(store, plan: dict, step_id: str, attached, step_version: int, machine: str) -> str:
    """Flow 1 (the owner's pick "Attach, else picture run"): the report's pictures, else a picture run."""
    pics = pictures(attached, plan.get("cwd", ""))
    if pics:
        add_set(store, plan["id"], step_id, pics, "report", "done", step_version=step_version)
        return f"{len(pics)} pictures from the report"
    queue(store, plan, step_id, "pictures", "done", machine)
    return "no pictures attached: picture run queued"


def _step(plan_v: dict, step_id: str) -> dict:
    return next((s for s in (plan_v.get("parts") or {}).get("steps") or [] if s.get("id") == step_id), {})


def picture_prompt(plan: dict, step: dict, reply: str, folder: Path) -> str:
    return (
        f"Take the evidence pictures for step {step.get('id')}: {step.get('title', '')} of the plan \"{plan.get('title', '')}\".\n"
        f"The step's check: {step.get('check', '')}\n"
        f"The step's last report:\n<report>\n{reply[:4000]}\n</report>\n\n"
        "The owner wants to see the feature itself working, as pictures, not text. Open the real thing the step built "
        "and take pictures of it: a web page or app as screenshots (desktop width and 390 px phone width when it is a "
        "page), a 3D result as renders, a command line tool as a screenshot of its real run. Each picture shows one "
        "thing the check asks for, with a marker and its number on it when it reports a pass or a fail.\n"
        f"Save every picture as a PNG in this folder (make it): {folder}\n"
        "Change no project file; write only in that folder. When you cannot take a picture, say why in one line.\n"
        "End with the list of the pictures you saved, one path per line."
    )


def check_prompt(plan: dict, step: dict, pics: list[str]) -> str:
    goal = ((plan.get("_v") or {}).get("parts") or {}).get("goal", "")
    return (
        f"Check the evidence pictures of step {step.get('id')}: {step.get('title', '')}.\n"
        f"The plan's goal: {str(goal)[:1500]}\n"
        f"The step's check: {step.get('check', '')}\n"
        "Read each picture below with the Read tool and judge only what the picture shows: does it prove the step is "
        "done as its check says? pass = it shows it, fail = it shows the step is not done, unclear = it cannot tell.\n"
        + "\n".join(f"- {p}" for p in pics)
        + "\nChange nothing. End your answer with one line of JSON only: "
        '{"overall": "pass|fail|unclear", "pictures": [{"path": "...", "verdict": "pass|fail|unclear", "why": "a few words"}], '
        '"note": "what is missing, a few words"}'
    )


def parse_marks(text: str, pics: list[str]) -> dict | None:
    """The last JSON object in the check run's answer, cleaned; None when there is none."""
    for m in reversed(list(re.finditer(r"\{.*\}", text or ""))):
        try:
            j = json.loads(m.group(0))
        except ValueError:
            continue
        if not isinstance(j, dict) or "overall" not in j:
            continue
        rows = []
        for r in j.get("pictures") or []:
            if isinstance(r, dict):
                v = str(r.get("verdict", "")).lower()
                rows.append({"path": str(r.get("path", "")), "verdict": v if v in VERDICTS else "unclear",
                             "why": redact(str(r.get("why", "")), 300)})
        o = str(j.get("overall", "")).lower()
        return {"overall": o if o in VERDICTS else "unclear", "pictures": rows, "note": redact(str(j.get("note", "")), 500)}
    return None


class Evidence:
    """The bridge side: starts the picture and check runs (fresh one-off claude runs) and keeps what they give."""

    def __init__(self, runs):
        self.runs = runs  # runs.Runs: spawn, store, roots, claude, mode, run_with

    def start(self, c: dict) -> str:
        from .runs import NO_CLI, folder_ok, start_command
        from .planfrom import NO_EDITS
        r, store = self.runs, self.runs.store
        cid, pid, sid, what = c["id"], str(c.get("planId") or ""), str(c.get("stepId") or ""), c.get("what")
        plan = store.get(f"plans/{pid}") or {}
        path = f"planEvidence/{pid}_{sid}"
        rec = store.get(path) or {}
        v = store.get(f"planVersions/{pid}_v{plan.get('current', 0)}") or {}
        step = _step(v, sid)
        cwd = plan.get("cwd", "")
        last = (rec.get("sets") or [{}])[0]
        pics = [p for p in last.get("pictures") or [] if os.path.isfile(p)]
        why = ("No such plan." if not plan else f"Plan v{plan.get('current', 0)} has no step {sid}." if not step
               else "Not a picture run or a check run." if what not in ("pictures", "check")
               else "The plan's folder is not inside a work folder on this machine." if not (cwd and os.path.isdir(cwd) and folder_ok(cwd, r.roots))
               else NO_CLI if not r.claude
               else "No pictures to check yet: Generate evidence first." if what == "check" and not pics
               else "")
        if why:
            store.update(f"commands/{cid}", {"status": "failed", "endedAt": now_iso(), "error": why})
            store.put_many({path: {**rec, "id": f"{pid}_{sid}", "planId": pid, "stepId": sid, "state": "idle", "what": None,
                                   "error": why, "updatedAt": now_iso()}})
            return f"{cid}: evidence refused, {why}"
        if what == "pictures":
            sv = store.get(f"planSteps/{pid}_{sid}") or {}
            reply = ((sv.get("versions") or [{}])[-1]).get("reply", "")
            folder = evidence_dir(cwd, pid, sid, cid)
            prompt, extra = picture_prompt(plan, step, reply, folder), []
            fields = {"evidenceDir": str(folder)}
        else:
            prompt, extra = check_prompt({**plan, "_v": v}, step, pics), ["--disallowedTools", NO_EDITS]
            fields = {"checkedSet": last.get("at"), "checkedPictures": pics}
        session, mode = str(uuid.uuid4()), r.mode()
        model, effort = r.run_with(c)
        cmd = start_command(r.claude, prompt, session, mode, model, effort, keep=False) + extra
        p = r._spawn(cid, cmd, cwd)
        store.update(f"commands/{cid}", {"status": "running", "sessionId": session, "pid": p.pid, "startedAt": now_iso(),
                                         "permissionMode": mode, "model": model, "effort": effort, "noSession": True,
                                         "workType": f"evidence {what} · step {sid}", **fields})
        store.update(path, {"state": "running", "what": what, "error": None, "updatedAt": now_iso()})
        return f"{cid}: evidence {what} run for {pid} {sid}"

    def finished(self, c: dict, status: str, result: str, error: str = "") -> None:
        """After an evidence run ends (runs._finish): keeps the pictures it saved, or the marks it gave."""
        store = self.runs.store
        pid, sid, what = c.get("planId", ""), c.get("stepId", ""), c.get("what")
        path = f"planEvidence/{pid}_{sid}"
        if what == "pictures":
            pics = found_in(Path(c.get("evidenceDir") or ""))
            if pics:
                sv = store.get(f"planSteps/{pid}_{sid}") or {}
                add_set(store, pid, sid, pics, "run", c.get("trigger") or "button", c["id"], len(sv.get("versions") or []))
                return
            err = error or "The picture run saved no picture. " + (result.strip().splitlines() or [""])[-1][:300]
            store.update(path, {"state": "idle", "what": None, "error": redact(err, 500), "updatedAt": now_iso()})
            return
        marks = parse_marks(result, c.get("checkedPictures") or []) if status == "done" else None
        if marks:
            store.update(path, {"state": "idle", "what": None, "error": None, "updatedAt": now_iso(),
                                "check": {"at": now_iso(), "runId": c["id"], "set": c.get("checkedSet"), **marks}})
        else:
            store.update(path, {"state": "idle", "what": None, "updatedAt": now_iso(),
                                "error": redact(error or "The LLM check gave no marks (no JSON line).", 500)})
