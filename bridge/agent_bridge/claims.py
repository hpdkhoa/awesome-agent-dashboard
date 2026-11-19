"""F8, claims across boxes (plan bf73af63; the step: "a session claims a step or folder; shown on the page; a second box
is refused"; its check: "two boxes on one step: second refused"; the source, rules-review.md: "Claim every gap you work
on right after `register`").

The truth sits on the control plane every box shares (Firestore, the boxes' registry already lives there; the owner's
words, 2026-11-13: "use firestore as control plane"): claims/<key>, written with one atomic create (precondition
exists=false), so when two boxes claim the same step at once, one wins and the other is refused with the holder's name.
The same box claiming again (the next run on the step, a session's second call) refreshes its claim.

Each box keeps a copy of the claims it holds in its own database, boxClaims/<key> (never mirrored: Firestore already has
the truth), so the page reads them from the boxes like everything else, with no Firestore read.

Who claims:
  - a Run step: the bridge claims the step before it starts the run, for the run's session; refused -> the run fails
    with the holder's box, session and time, and never starts;
  - a session: the inbox tool claim(step=... or folder=...).
Dead box (the owner, 2026-11-19: "dead box need both expiry and button"):
  - expiry: a claim whose box has not written its registry heartbeat (bridges/<box>.seenAt, every KEEPALIVE_SECONDS =
    15 min, registry.py) for 2 x 15 = 30 minutes counts as the claim of a dead box: the next box that claims the step
    takes it over, and the claim keeps whom it took it from. A box with no registry entry never expires (no heartbeat
    to judge by): the button frees it;
  - button: Release on the page's claim chip deletes the claim on Firestore and the box's copy.
Release: when the run ends (done, failed, stopped), the bridge drops every claim of that run and of its session on this
box. A paused run (usage limit) keeps its claim: it goes on later.

claims/<key> = boxClaims/<key> = {key, kind "step" | "folder", planId, stepId, folder, machine, sessionId, runId, by
"run" | "session", at}.
"""
from __future__ import annotations

import hashlib
import os
import time
from datetime import datetime

from .inbox import now_iso

LOCAL = "boxClaims"
EXPIRE_SECONDS = 2 * 900  # two missed registry heartbeats (registry.KEEPALIVE_SECONDS = 900)


def step_key(plan_id: str, step_id: str) -> str:
    return f"step~{plan_id}~{step_id}"


def folder_key(folder: str) -> str:
    """A folder's key: its full path, case and separators as the OS compares them."""
    norm = os.path.normcase(os.path.normpath(os.path.abspath(folder)))
    return "folder~" + hashlib.sha1(norm.encode("utf-8")).hexdigest()[:20]


def holder_text(c: dict) -> str:
    what = f"step {c.get('stepId')} of plan {c.get('planId')}" if c.get("kind") == "step" else f"folder {c.get('folder')}"
    return (f"{what} is claimed by box {c.get('machine')} (session {str(c.get('sessionId'))[:8]}"
            + (f", run {str(c.get('runId'))[:8]}" if c.get("runId") else "") + f", since {c.get('at')})")


class Claims:
    def __init__(self, control, local, machine: str, clock=time.time):
        self.fs, self.local, self.machine, self.clock = control, local, machine, clock  # control: Firestore

    def dead(self, machine: str) -> float | None:
        """Seconds since the box's last registry heartbeat when that is over EXPIRE_SECONDS; None while it lives or when
        it has no registry entry (nothing to judge by)."""
        seen = (self.fs.get(f"bridges/{machine}") or {}).get("seenAt")
        if not seen:
            return None
        try:
            age = self.clock() - datetime.fromisoformat(str(seen)).timestamp()
        except ValueError:
            return None
        return age if age > EXPIRE_SECONDS else None

    def take(self, kind: str, session_id: str, run_id: str = "", by: str = "run", plan_id: str = "", step_id: str = "",
             folder: str = "") -> tuple[bool, dict]:
        """Claims a step or a folder for this box. Returns (True, the claim) or (False, the other box's claim)."""
        if kind == "step":
            if not (plan_id and step_id):
                raise ValueError("A step claim needs the plan and the step.")
            key = step_key(plan_id, step_id)
        elif kind == "folder":
            if not folder:
                raise ValueError("A folder claim needs the folder.")
            key = folder_key(folder)
        else:
            raise ValueError("A claim is a step or a folder.")
        mine = {"key": key, "kind": kind, "planId": plan_id, "stepId": step_id, "folder": folder, "machine": self.machine,
                "sessionId": session_id, "runId": run_id, "by": by, "at": now_iso()}
        if not self.fs.create(f"claims/{key}", mine):
            held = self.fs.get(f"claims/{key}") or {}
            if held and held.get("machine") != self.machine:
                age = self.dead(held["machine"])
                if age is None:
                    return False, held
                mine["tookOver"] = {"machine": held["machine"], "sessionId": held.get("sessionId", ""),
                                    "silentMinutes": round(age / 60)}
            # this box's own claim (or it was released between the two calls): take it again, refreshed
            self.fs.put_many({f"claims/{key}": mine})
        self.local.put_many({f"{LOCAL}/{key}": mine})
        return True, mine

    def release(self, key: str) -> bool:
        """Drops one claim of this box: on the control plane (only when this box holds it) and in the local copy."""
        held = self.fs.get(f"claims/{key}")
        ok = bool(held) and held.get("machine") == self.machine
        if ok:
            self.fs.delete(f"claims/{key}")
        if self.local.get(f"{LOCAL}/{key}") is not None:
            self.local.delete(f"{LOCAL}/{key}")
        return ok

    def release_run(self, run_id: str, session_id: str = "") -> list[str]:
        """After a run ends: drops this box's claims made by the run or by its session. Returns the keys dropped."""
        out = []
        for c in self.local.where(LOCAL, "machine", self.machine):
            if (run_id and c.get("runId") == run_id) or (session_id and c.get("sessionId") == session_id):
                self.release(c["key"])
                out.append(c["key"])
        return out

    def mine(self) -> list[dict]:
        return self.local.where(LOCAL, "machine", self.machine)
