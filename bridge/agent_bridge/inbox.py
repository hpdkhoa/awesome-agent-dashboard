"""The inbox: sessions post questions, suggestions and results; the owner answers on the dashboard.

Delivery (the owner's choice, 2026-11-01, "option 1"):
- `inbox_ask` waits for the answer and returns it into the live session as the tool result.
- An answer the session cannot pick up live (it has closed) is delivered by the bridge with
  `claude -p --resume <session>` (deliver.py). The bridge never resumes a session that is still open: each open
  session's inbox server writes a heartbeat to liveSessions/<session> every minute.

Kinds: question, suggestion, result, approval (a tool call in a run started from the dashboard).
Item states: open -> answered (the owner, on the page) -> delivered (live or by resume), or closed (nothing to send).

Plans (the owner's choice, 2026-11-01, "do 2"): a session opens a plan (plans/<id>) and posts its versions
(planVersions/<id>_v<n>). Each question the session asks while the plan is open joins it, in the round of the version
it was asked on (round 0: before v1), so the page shows v1, its questions and answers, v2, and so on.
Each version keeps its parent and the answers that made it (madeBy). When the owner reopens an answer on the page, the
session posts a version whose parent is the version that question was asked on: a branch. Old branches stay.

Plan from a session (the owner's words, 2026-11-03, cc/dashboard/SESSION_PLAN.md): a plan made from a session's real
record has six parts, in the owner's order: goal, summary, rules, lessons (each with how it was applied), leftover and
steps. Two kinds of version (the owner's words: "The version I mention in this request is the plan version, the
previous 2026-11-01 version will be the step version, which in each step I can see the last reply like a normal
message"):
- plan version (planVersions): only when the plan's data changes, never when a step moves;
- step version (planSteps): each report on a step (step_update), its state and its reply; no plan version.
A message on the plan has a kind: qa, goal, step, rule or lesson. A Q&A run never changes the plan: plan_version is
refused in it until the owner confirms a switch to another kind (plan_switch).
Every option of a question in a plan carries an example (the owner's words: "every choose will have an example"): a
picture pair, a code diff with a benchmark, or a draft. A plan question without one is refused.
"""


import json
import os
import re
import threading
import time
import uuid
from datetime import datetime, timezone

from .aggregate import work_type_of
from .redact import redact
from .planfrom import check_parts

BEAT_SECONDS = 60
LIVE_SECONDS = 180  # a session whose heartbeat is older than this is treated as closed
POLL_SECONDS = 5
# how long one archiver_wait call blocks before it returns "nothing": measured 2026-11-07 on CLI 2.1.316, a tool call
# held 30, 330, 660 and 1260 s with no timeout; 1200 s stays under the longest measured. An ask returns at once anyway.
ARCHIVER_WAIT = 1200
MAX_WAIT_MINUTES = 25  # under Claude Code's 30-minute idle limit for a local MCP server
PUSH_TITLE = {"question": "Question", "suggestion": "Suggestion", "result": "Result to review"}
PARTS = ("goal", "summary", "rules", "lessons", "leftover", "steps")
KINDS = {"qa": "Q&A", "goal": "Shift goal", "step": "Add step", "rule": "Change rule", "lesson": "Audit lesson"}
STEP_STATES = ("next", "now", "done", "failed")
# The plan's phases (the owner's words, 2026-11-04: "In my mind having these phases: 1. Explore 2. Build 3. Verify
# 4. Remove 5. Optimize. Then in any phase can rollback to previous phases at any step"; "Every plan starts in Explore";
# "I will be the one who trigger the move in every phase, I give order and decisions, you note it down as a plain
# version to change the phase, and I want the version is included the phase").
PHASES = ("explore", "build", "verify", "remove", "optimize")
# The plan format number (the owner's words, 2026-11-07: "all plans will have to update to latest format when I resume
# the plan"). 0: text only. 1: the six parts. Raise it when the plan format changes; plans below it are rebuilt from
# their session when the owner resumes them (runs.py _upgrade_first).
PLAN_FORMAT = 1


def format_of(plan: dict) -> int:
    """A plan's format number; plans made before the number existed: 1 with the six parts, else 0."""
    return int(plan.get("format", 1 if plan.get("kind") == "parts" else 0))


def check_example(e) -> str | None:
    """Why an option's example is not enough, or None when it is. image: before and after files; code: a diff and at
    least one benchmark row that says whether it was measured; text: the draft."""
    if not isinstance(e, dict):
        return "no example"
    t = e.get("type")
    if t == "image":
        return None if e.get("before") and e.get("after") else "an image example needs before and after files"
    if t == "code":
        bench = e.get("bench") or []
        if not e.get("diff"):
            return "a code example needs the diff"
        if not bench or any(not isinstance(r, dict) or "measured" not in r for r in bench):
            return "a code example needs benchmark rows, each with measured true or false"
        return None
    if t == "text":
        return None if (e.get("draft") or "").strip() else "a text example needs the draft"
    if t == "visual":
        return None if clean_svg(e.get("svg")) else "a visual example needs an inline <svg> drawing"
    return "an example's type is visual, image, code or text"


# A drawn option (the owner's words, 2026-11-07: "consider anything can draw out then it is better to have the idea or
# choice draw out instead of text out"). The page shows it as an image, where no script runs; scripts, event handlers,
# foreign objects and outside links are still cut here.
def clean_svg(svg) -> str:
    s = str(svg or "").strip()
    if not s.lower().startswith("<svg") or len(s) > 30000:
        return ""
    s = re.sub(r"(?is)<(script|foreignObject)\b.*?</\1\s*>", "", s)
    s = re.sub(r"(?is)<(script|foreignObject)\b[^>]*/>", "", s)
    s = re.sub(r"(?i)\son\w+\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)", "", s)
    s = re.sub(r"(?i)((?:xlink:)?href\s*=\s*[\"'])(?!#)[^\"']*", r"\1#", s)
    return s


def clean_example(e: dict) -> dict:
    out = {"type": e["type"]}
    if e.get("type") == "visual":
        out["svg"] = clean_svg(e.get("svg"))
    for k, n in (("before", 300), ("after", 300), ("diff", 12000), ("draft", 6000), ("note", 400)):
        if e.get(k):
            out[k] = redact(str(e[k]), n)
    if e.get("bench"):
        out["bench"] = [{"name": redact(str(r.get("name", "")), 120), "before": redact(str(r.get("before", "")), 60),
                         "after": redact(str(r.get("after", "")), 60), "measured": bool(r.get("measured")),
                         "source": redact(str(r.get("source", "")), 200)} for r in e["bench"][:12]]
    return out


def _lines(v) -> str:
    if isinstance(v, str):
        return v
    out = []
    for x in v or []:
        if isinstance(x, dict):
            out.append("- " + " · ".join(f"{k}: {x[k]}" for k in x if x[k] not in ("", None)))
        else:
            out.append(f"- {x}")
    return "\n".join(out)


def parts_markdown(parts: dict) -> str:
    """The six parts as one markdown text, for the list and graph views and the push."""
    names = {"goal": "1. Goal", "summary": "2. Summary", "rules": "3. Rules", "lessons": "4. Lessons",
             "leftover": "5. Leftover", "steps": "6. Steps"}
    def shown(k):  # a new step (work the record does not hold) is marked in the text, so the graph's diff shows it
        if k != "steps":
            return parts.get(k)
        return [{**{x: y for x, y in st.items() if x != "new"}, "title": ("[new] " if st.get("new") else "") + str(st.get("title", ""))}
                if isinstance(st, dict) else st for st in parts.get(k) or []]
    out = "\n\n".join(f"## {names[k]}\n\n{_lines(shown(k))}" for k in PARTS)
    return out + (f"\n\n## Cite\n\n{parts['cite']}" if parts.get("cite") else "")


# The harness (the owner's words, 2026-11-04: "for the harness in here I need the list as a section in the plan so I can
# review and see the diff everytime the plan change what harness will be change, and at last I'll need to approve every
# single harness item"; harness = "Both": the tools and context each step needs, and each step's check). The list rides
# on every plan version, so versions diff it; the owner's ticks live in planHarness/<plan id> (the owner's choice:
# "Small approvals record"), written by the page.
HARNESS_KINDS = ("tool", "check")


def clean_harness(items) -> list[dict]:
    out, seen = [], set()
    for i, h in enumerate(items or [], 1):
        if not isinstance(h, dict) or not str(h.get("item", "")).strip():
            continue
        hid = str(h.get("id") or f"h{i}")[:20]
        if hid in seen:
            raise ValueError(f"two harness items have the id {hid}")
        seen.add(hid)
        kind = str(h.get("kind", "check")).lower()
        out.append({"id": hid, "item": redact(str(h["item"]), 400), "kind": kind if kind in HARNESS_KINDS else "check"})
    return out[:100]


def item_hash(h: dict) -> str:
    """FNV-1a, 32 bits, over the item's kind and text: the same as the page's harness.ts itemHash."""
    x = 0x811C9DC5
    for c in f"{h.get('kind', '')}:{h.get('item', '')}":
        x = ((x ^ ord(c)) * 0x01000193) & 0xFFFFFFFF
    return f"{x:08x}"


def harness_split(harness: list[dict], ticks: dict | None) -> dict:
    """Which items go into Build (the owner's words, 2026-11-04: "unticked harness items mean not approve that item to
    go through build so Move to Build button still be able to click but the unticked item won't be used or added into
    build phase"): an item is approved when its tick is on and its hash matches the item as it is now."""
    items = (ticks or {}).get("items") or {}
    ok = [h["id"] for h in harness if (items.get(h["id"]) or {}).get("ok") and items[h["id"]].get("hash") == item_hash(h)]
    return {"approved": ok, "notApproved": [h["id"] for h in harness if h["id"] not in ok]}


def clean_parts(parts: dict) -> dict:
    """The six parts, each kept; steps get ids. Raises ValueError when one is missing."""
    missing = [k for k in PARTS if k not in (parts or {})]
    if missing:
        raise ValueError("a plan needs all six parts; missing: " + ", ".join(missing))
    out = {k: redact(_lines(parts[k]), 12000) for k in ("goal", "summary")}
    # the cite (the owner's words, 2026-11-05: "move what the plan read (current inside the goal section) out into the
    # cite section like generated section"): the owner's quotes the plan reads; part 1 says what the plan is for
    if str(parts.get("cite") or "").strip():
        out["cite"] = redact(_lines(parts["cite"]), 12000)
    out["rules"] = [{"rule": redact(str(r.get("rule", "")), 400), "source": redact(str(r.get("source", "")), 200)}
                    for r in parts["rules"] or [] if isinstance(r, dict)]
    out["lessons"] = [{"lesson": redact(str(r.get("lesson", "")), 400),
                       "taughtBy": redact(str(r.get("taught_by", r.get("taughtBy", ""))), 400),
                       "appliedIn": redact(str(r.get("applied_in", r.get("appliedIn", ""))), 400)}
                      for r in parts["lessons"] or [] if isinstance(r, dict)]
    out["leftover"] = [redact(str(x), 400) for x in parts["leftover"] or []]
    out["steps"] = [{"id": str(st.get("id") or f"s{i}")[:20], "title": redact(str(st.get("title", "")), 200),
                     "does": redact(str(st.get("does", "")), 1000), "check": redact(str(st.get("check", "")), 600),
                     **({"new": True} if st.get("new") else {})}
                    for i, st in enumerate(parts["steps"] or [], 1) if isinstance(st, dict)]
    return out


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Inbox:
    """Inbox operations on any store with get, update, put_many and where (Firestore, or a fake in tests)."""

    def __init__(self, store, machine: str, roots: list[tuple[str, str]], session_id: str, cwd: str, push=None):
        self.store, self.machine, self.roots = store, machine, roots
        self.session_id, self.cwd = session_id or "unknown", cwd
        # a push.Pusher: tells the owner's phone about each question, suggestion, result and plan version (the owner's
        # choice, 2026-11-01, "do #1 and #2"); approvals push from inbox_approve with the call in the body
        self.push = push
        self.beats = 0  # the heartbeat is made once; after that it is only updated, so a deleted one stays deleted

    def open_plan(self) -> dict | None:
        """This session's plan: the newest, open or closed. Closed is only a label the owner sets on the page; it never
        stops work on the plan (the owner's words, 2026-11-09: "make the close plan is just a status, phase can be move
        back and forth by me so no blocking my action"; choice "Join the newest plan, any status"). A plan moved to the
        latest format (upgradedTo) is left out: its work goes on in the new plan."""
        if self.session_id == "unknown":
            return None
        plans = [p for p in self.store.where("plans", "sessionId", self.session_id) if not p.get("upgradedTo")]
        return max(plans, key=lambda p: p.get("createdAt", ""), default=None)

    def plan_start(self, title: str, text: str = "", note: str = "", parts: dict | None = None, source: str = "",
                   harness: list | None = None) -> str:
        """parts: the six parts of v1. source: the id of the dashboard command that read a session for this plan.
        A new plan starts in the latest format, the six parts (the owner's words, 2026-11-07: "make sure that any new
        plan will goes witb the latest version of plan"): a plan with text only is refused."""
        if parts is None:
            raise ValueError("A new plan starts in the latest format: give the six parts (goal, summary, rules, "
                             "lessons, leftover, steps). A plan with text only is no longer opened.")
        plan_id = uuid.uuid4().hex[:20]
        doc = {
            "id": plan_id, "title": redact(title, 200), "sessionId": self.session_id, "machine": self.machine,
            "cwd": self.cwd, "workType": work_type_of(self.cwd, self.roots), "status": "open", "current": 0,
            "createdAt": now_iso(), "updatedAt": now_iso(), "phase": PHASES[0], "format": PLAN_FORMAT,
        }
        if parts is not None:
            parts = clean_parts(parts)
            doc["kind"] = "parts"
        if source:
            c = self.store.get(f"commands/{source}") or {}
            if c.get("action") == "plan":
                doc.update(kind="parts", source={"sessionId": c.get("sourceSessionId", ""), "commandId": source,
                                                 "pagesDir": c.get("pagesDir", ""), "pages": c.get("pages") or []})
                self.store.update(f"commands/{source}", {"planId": plan_id})
        self.store.put_many({f"plans/{plan_id}": doc})
        if parts is not None or text.strip():
            self.plan_version(plan_id, text, note, parts=parts, harness=harness)
        return plan_id

    def running_command(self) -> dict | None:
        """The dashboard run working in this session now, if any."""
        if self.session_id == "unknown":
            return None
        rows = [c for c in self.store.where("commands", "sessionId", self.session_id)
                if c.get("status") == "running" and c.get("action") in ("message", "start", "plan")]
        return max(rows, key=lambda c: c.get("startedAt", ""), default=None)

    def plan_version(self, plan_id: str, text: str, note: str = "", parent: int | None = None,
                     answers: list[str] | None = None, parts: dict | None = None, change: str = "",
                     phase: str = "", order: str = "", harness: list | None = None) -> int:
        """Saves the next version of a plan and returns its number. Questions asked from now on are its round.

        parent: the version this one grows from (default: the current one; an older one makes a branch).
        answers: the inbox ids of the answers that made it (default: the answered questions asked on the parent).
        Each answer is kept as it was then, so a branch made before a reopen still shows the old answer.
        phase: a move to another phase, only on the owner's order: order is the owner's words (a dashboard message's
        own text is used when there is one). With no text and no parts, the version copies its parent's (a plain version).
        Every version carries the plan's phase. harness: the whole harness list; left out, the parent's list is kept.
        """
        plan = self.store.get(f"plans/{plan_id}")
        if not plan:
            raise ValueError(f"no plan {plan_id}")
        run = self.running_command()
        if run and run.get("kind") == "qa" and not run.get("switchedTo"):
            raise ValueError("This is a Q&A message: it never changes the plan. If the answer needs a change, ask the "
                             "owner with plan_switch first.")
        if run and run.get("kind") in KINDS and not change:
            change = run.get("switchedTo") or run["kind"]
        was = plan.get("phase") or PHASES[0]
        phase = (phase or "").strip().lower() or was
        if phase not in PHASES:
            raise ValueError(f"no phase {phase!r}; the phases are {', '.join(PHASES)}")
        order = (order or (run or {}).get("ownerText") or "").strip()
        if phase != was and not order:
            raise ValueError("Only the owner moves a phase. Move it when the owner orders it, and give the owner's "
                             "words as order.")
        current = int(plan.get("current", 0))
        parent = current if parent is None else parent
        if not 0 <= parent <= current:
            raise ValueError(f"plan {plan_id} has no version {parent}")
        if parts is None and not text.strip() and phase != was:  # a plain version: the parent's data, a new phase
            base = self.store.get(f"planVersions/{plan_id}_v{parent}") or {}
            parts, text = base.get("parts"), base.get("text", "")
        if harness is None:  # kept from the version it grows from, so a plain or a data version keeps the list
            harness = (self.store.get(f"planVersions/{plan_id}_v{parent}") or {}).get("harness") if current else None
        harness = clean_harness(harness)
        checks = None
        if parts is not None:
            parts = clean_parts(parts)
            # step s8: the parts of a plan read from a session are checked against its record; bad #n and quotes marked
            parts, checks = check_parts(parts, (plan.get("source") or {}).get("pagesDir", ""))
            text = text if text.strip() else parts_markdown(parts)
        asked = {i["id"]: i for i in self.store.where("inbox", "planId", plan_id)}
        if answers is None:
            answers = [k for k, i in asked.items() if int(i.get("round", 0)) == parent and i.get("answer")]
        made_by = [{"id": k, "title": asked[k].get("title", ""), "choice": (asked[k].get("answer") or {}).get("choice", ""),
                    "text": (asked[k].get("answer") or {}).get("text", "")} for k in answers if k in asked]
        # a plan's numbers only grow, so a branch from an old version still gets the next number
        n = int(plan.get("last", current)) + 1
        version = {
            "id": f"{plan_id}_v{n}", "planId": plan_id, "n": n, "parent": parent, "madeBy": made_by,
            "text": redact(text, 30000), "note": redact(note, 400), "createdAt": now_iso(), "phase": phase,
        }
        if phase != was:
            version["phaseMove"] = {"from": was, "to": phase, "order": redact(order, 2000)}
            if phase == "build" and harness:
                version["phaseMove"]["harness"] = harness_split(harness, self.store.get(f"planHarness/{plan_id}"))
        if checks and checks["refs"] + checks["quotes"]:
            version["checks"] = checks
        if parts is not None:
            version["parts"] = parts
        if harness:
            version["harness"] = harness
        if change in KINDS:
            version["change"] = {"kind": change, "message": redact((run or {}).get("ownerText") or (run or {}).get("prompt", ""), 2000)}
        self.store.put_many({f"planVersions/{plan_id}_v{n}": version})
        self.store.update(f"plans/{plan_id}", {"current": n, "last": n, "chosen": n, "updatedAt": now_iso(), "phase": phase})
        if self.push is not None:
            self.push.notify(f"Plan v{n}: {plan.get('title', '')}", note or "New version.", f"/?plan={plan_id}", f"plan-{plan_id}")
        return n

    def step_update(self, plan_id: str, step_id: str, state: str, reply: str) -> int:
        """A step version: the step's state and the session's reply on it. Never a plan version (the owner's words:
        "not moving step"). Questions asked while a step is "now" join that step. Returns the step version number."""
        if state not in STEP_STATES:
            raise ValueError("state is one of " + ", ".join(STEP_STATES))
        plan = self.store.get(f"plans/{plan_id}")
        if not plan:
            raise ValueError(f"no plan {plan_id}")
        v = self.store.get(f"planVersions/{plan_id}_v{plan.get('current', 0)}") or {}
        steps = {st["id"]: st for st in (v.get("parts") or {}).get("steps") or []}
        if step_id not in steps:
            raise ValueError(f"plan v{plan.get('current', 0)} has no step {step_id}; its steps: " + ", ".join(steps))
        path = f"planSteps/{plan_id}_{step_id}"
        versions = list((self.store.get(path) or {}).get("versions") or [])
        n = len(versions) + 1
        versions.append({"n": n, "state": state, "reply": redact(reply, 8000), "at": now_iso(),
                         "planVersion": int(plan.get("current", 0))})
        self.store.put_many({path: {"id": f"{plan_id}_{step_id}", "planId": plan_id, "stepId": step_id, "state": state,
                                    "versions": versions, "updatedAt": now_iso()}})
        active = step_id if state == "now" else (None if plan.get("activeStep") == step_id else plan.get("activeStep"))
        self.store.update(f"plans/{plan_id}", {"activeStep": active, "updatedAt": now_iso()})
        if self.push is not None and state in ("done", "failed"):
            self.push.notify(f"Step {state}: {steps[step_id]['title']}", (reply.splitlines() or [""])[0][:160],
                             f"/?plan={plan_id}", f"plan-{plan_id}-{step_id}")
        return n

    def ask_switch(self, to: str, change: str, why: str) -> str:
        """A Q&A run asks the owner to switch to a kind that changes the plan. Returns the question's id."""
        if to not in KINDS or to == "qa":
            raise ValueError("switch to one of: " + ", ".join(k for k in KINDS if k != "qa"))
        run = self.running_command() or {}
        opts = [{"label": f"Switch to {KINDS[to]}", "detail": "the session makes this change as a new plan version",
                 "differs": "the plan changes: a new version", "example": {"type": "text", "draft": change}},
                {"label": "Keep Q&A", "detail": "nothing changes", "differs": "the plan stays as it is",
                 "example": {"type": "text", "draft": "No change to the plan."}}]
        return self.post("question", f"Switch to {KINDS[to]}?", why, opts, 0,
                         extra={"switch": {"to": to, "commandId": run.get("id", "")}})

    def confirm_switch(self, item_id: str) -> bool:
        """After the owner answered a switch question: unlocks plan_version for the run when the owner chose the switch."""
        item = self.store.get(f"inbox/{item_id}") or {}
        sw = item.get("switch") or {}
        ok = ((item.get("answer") or {}).get("choice") or "").startswith("Switch to")
        if ok and sw.get("commandId"):
            self.store.update(f"commands/{sw['commandId']}", {"switchedTo": sw.get("to")})
        return ok

    def post(self, kind: str, title: str, text: str, options: list[dict] | None = None,
             recommended: int | None = None, files: list[str] | None = None, extra: dict | None = None) -> str:
        item_id = uuid.uuid4().hex[:20]
        extra = dict(extra or {})
        if kind == "question" and "planId" not in extra:
            plan = self.open_plan()
            if plan:
                extra.update(planId=plan["id"], round=int(plan.get("current", 0)))
                if plan.get("activeStep"):
                    extra["stepId"] = plan["activeStep"]
        if kind == "question" and extra.get("planId"):
            bad = [f'"{o.get("label", "")}": {why}' for o in options or [] if (why := check_example(o.get("example")))]
            if not options or bad:
                raise ValueError("Every option of a plan question needs an example (the owner's rule). "
                                 + ("; ".join(bad) if bad else "Give options, each with an example."))
        # each option drawn, or at least its difference (the owner's words, 2026-11-07: "I want the question to have the
        # visualization ... or at least give me the different between each answer"); the question box has neither
        if kind == "question" and extra.get("via") != "hook" and options:
            plain = [o.get("label", "") for o in options
                     if not str(o.get("differs") or "").strip() and (o.get("example") or {}).get("type") not in ("visual", "image")]
            if plain:
                raise ValueError("Every option needs a drawing (example type visual) or a differs line: what is "
                                 "different about it, in a few words. Missing on: " + ", ".join(plain))
        opts = [{"label": redact(o.get("label", ""), 120), "detail": redact(o.get("detail", ""), 400),
                 **({"differs": redact(str(o["differs"]), 160)} if o.get("differs") else {}),
                 **({"example": clean_example(o["example"])} if o.get("example") else {})} for o in options or []]
        if recommended is not None and not 0 <= recommended < len(opts):
            recommended = None
        self.store.put_many({f"inbox/{item_id}": {
            "id": item_id,
            "kind": kind,
            "sessionId": self.session_id,
            "machine": self.machine,
            "cwd": self.cwd,
            "workType": work_type_of(self.cwd, self.roots),
            "title": redact(title, 200),
            "text": redact(text, 4000),
            "options": opts,
            "recommended": recommended,
            "files": [redact(f, 300) for f in files or []],
            "status": "open",
            "createdAt": now_iso(),
            "answer": None,
            **extra,
        }})
        if extra.get("planId"):
            self.store.update(f"plans/{extra['planId']}", {"updatedAt": now_iso()})
        if self.push is not None and kind in PUSH_TITLE:
            first = next((line for line in text.splitlines() if line.strip()), "")
            body = ("Answer within 10 minutes, or the session asks there. " if extra.get("via") == "hook" else "") + first
            self.push.notify(f"{PUSH_TITLE[kind]}: {title}", body[:200] or title, f"/?item={item_id}", item_id)
        return item_id

    def post_batch(self, questions: list[dict], via: str = "") -> list[str]:
        """Questions asked together are one batch (the owner's words, 2026-11-07: "group the questions in the same batch,
        instead of current flow is 3 questions from the same batch/session/message became 3 items in inbox"): one inbox
        entry on the page, answered together. Each question keeps its own record, so rounds and answers stay per
        question. questions: [{"title", "text", "options", "recommended", "extra"}]."""
        batch = uuid.uuid4().hex[:12]
        return [self.post("question", q.get("title") or q.get("text", "")[:80], q.get("text", ""), q.get("options"),
                          q.get("recommended"), extra={**(q.get("extra") or {}), **({"via": via} if via else {}),
                                                       "batchId": batch, "batchIndex": k, "batchSize": len(questions)})
                for k, q in enumerate(questions)]

    def ask_back(self, item_id: str) -> dict | None:
        """The owner's newest question back on an item that the session has not replied to yet (the ping-pong)."""
        return open_ask((self.store.get(f"inbox/{item_id}") or {}).get("thread") or [])

    def reply(self, item_id: str, text: str) -> bool:
        """The session's short reply to the owner's question back; it never answers the question for the owner. Only
        its length is stored: the page reads the words from this session's log on the PC (texts.py, the owner's
        choice, 2026-11-08: "From the PC too")."""
        item = self.store.get(f"inbox/{item_id}")
        if not item:
            return False
        thread = list(item.get("thread") or []) + [{"who": "session", "kind": "reply", "chars": len(text), "at": now_iso()}]
        return self.store.update(f"inbox/{item_id}", {"thread": thread})

    def beat(self) -> None:
        if self.session_id == "unknown" or self.beats < 0:
            return
        path = f"liveSessions/{self.session_id}"
        if self.beats == 0:
            self.store.put_many({path: {"sessionId": self.session_id, "machine": self.machine, "cwd": self.cwd,
                                        "beatAt": now_iso()}})
        elif not self.store.update(path, {"beatAt": now_iso()}):
            self.beats = -1  # the owner deleted it: no more beats from this session
            return
        self.beats += 1

    def take_answer(self, item_id: str) -> str | None:
        """The owner's answer as text for the session, marking the item delivered; None while it is still open."""
        item = self.store.get(f"inbox/{item_id}")
        if not item or item.get("status") != "answered":
            return None
        try:  # the decision's pictures as they are at the answer (snapshot.py); never blocks the answer
            from .snapshot import take

            take(self.store, item)
        except OSError:
            pass
        self.store.update(f"inbox/{item_id}", {"status": "delivered", "deliveredAt": now_iso(), "deliveredVia": "live"})
        return answer_text(item)

    def other_replies(self, skip: str = "") -> list[str]:
        """Answers to this session's other items, so a live session picks them up on any inbox call."""
        out = []
        for item in self.store.where("inbox", "sessionId", self.session_id):
            if item.get("id") != skip and item.get("status") == "answered":
                text = self.take_answer(item["id"])
                if text:
                    out.append(text)
        return out


def approval_reply(item: dict | None, tool_input: dict) -> str:
    """The JSON a --permission-prompt-tool returns: allow with the input unchanged, or deny with the owner's note."""
    import json

    a = (item or {}).get("answer") or {}
    if a.get("choice") == "Allow":
        return json.dumps({"behavior": "allow", "updatedInput": tool_input})
    if item is None:
        return json.dumps({"behavior": "deny", "message": "No answer from the owner in time; the call was not run."})
    return json.dumps({"behavior": "deny", "message": "The owner denied this call." + (f" Note: {a['text']}" if a.get("text") else "")})


def answer_text(item: dict) -> str:
    a = item.get("answer") or {}
    kind = {"question": "your question", "suggestion": "your suggestion", "result": "your result"}.get(item.get("kind"), "")
    parts = [f'The owner answered {kind} "{item.get("title", "")}" on the dashboard.']
    if item.get("reopened") and item.get("planId"):
        was = (item.get("history") or [{}])[-1]
        parts = [f'The owner reopened "{item.get("title", "")}" in plan {item["planId"]} and changed the answer'
                 f' (it was: {was.get("choice") or was.get("text") or "no choice"}). Branch the plan: post a new version'
                 f' with plan_version(parent={int(item.get("round", 0))}) built on this answer.']
    if a.get("choice"):
        parts.append(f"Choice: {a['choice']}.")
    if a.get("text"):
        parts.append(f"Note: {a['text']}")
    if not a.get("choice") and not a.get("text"):
        parts.append("No note.")
    return " ".join(parts)


def open_ask(thread: list[dict]) -> dict | None:
    """The owner's newest question back in a thread with no session reply after it."""
    for e in reversed(thread):
        if e.get("who") == "session":
            return None
        if e.get("who") == "owner" and e.get("kind") == "ask":
            return e
    return None


def ask_back_text(item: dict, ask: dict) -> str:
    """The message a session gets when the owner asked back after its inbox_ask stopped waiting (the owner's choice,
    2026-11-08: "A, bridge delivers"). It is not an answer: the session replies in the thread, then waits again."""
    return (f'The owner asks back on your question "{item.get("title", "")}" (id {item.get("id", "")}) on the dashboard: '
            f'"{ask.get("text", "")}". This is not an answer. Reply in a few words with inbox_reply(item_id="{item.get("id", "")}", '
            f'text=...) (draw it with an svg when it can be drawn), then call inbox_wait(item_id="{item.get("id", "")}") '
            f"for the answers.")


def is_live(store, session_id: str) -> bool:
    beat = store.get(f"liveSessions/{session_id}")
    if not beat or not beat.get("beatAt"):
        return False
    age = datetime.now(timezone.utc) - datetime.fromisoformat(beat["beatAt"])
    return age.total_seconds() < LIVE_SECONDS


def server():
    """The MCP server each Claude Code session starts (stdio). Registered with `claude mcp add --scope user`."""
    import asyncio

    from mcp.server.mcpserver import Context, MCPServer

    from .auth import Session
    from .config import Config
    from .firestore import Firestore

    cfg = Config.load()
    from .push import pusher

    store = Firestore(Session(cfg))
    push = pusher(store, cfg.owner_email)
    inbox = Inbox(store, cfg.machine, cfg.roots, os.environ.get("CLAUDE_CODE_SESSION_ID", ""), os.getcwd(), push)

    def beat_forever():
        while True:
            try:
                inbox.beat()
            except BaseException:
                pass
            time.sleep(BEAT_SECONDS)

    threading.Thread(target=beat_forever, daemon=True).start()

    mcp = MCPServer(
        "agent-inbox",
        instructions=(
            "The owner's dashboard inbox. Post a decision the owner must make with inbox_ask (give options and mark "
            "the one you recommend), a result to review with inbox_result, and an idea with inbox_suggest. For planning "
            "with rounds of questions, open a plan with plan_start, post each new version with plan_version. Only the "
            "owner closes or reopens a plan, on the page; closed is a label and never stops work on it. Every question "
            "you ask joins the round of your plan's current version. While a plan is yours, every option of every question carries an example (before and after pictures, a "
            "code diff with a benchmark, or a draft). A plan with parts makes a new version only when its data "
            "changes; report work on a step with step_update, which never makes a plan version. A plan has a phase: "
            "explore, build, verify, remove, optimize. Every plan starts in explore, where no step runs. Only the "
            "owner moves the phase, forward or back: record each move with plan_version(phase=..., order=the owner's "
            "words), a plain version. In explore, list the harness with plan_version(harness=[...]): the tools and "
            "context each step needs and each step's check; the owner approves every item on the page."
        ),
    )

    async def wait_for(item_id: str, minutes: float, ctx: Context) -> str:
        """Waits for the answer to item_id, or to every question of its batch. Returns early when the owner asks back."""
        minutes = max(1.0, min(minutes, MAX_WAIT_MINUTES))
        end = time.time() + minutes * 60
        step = 0
        first = await asyncio.to_thread(inbox.store.get, f"inbox/{item_id}") or {}
        ids = [item_id]
        if first.get("batchId"):
            ids = [i["id"] for i in sorted(await asyncio.to_thread(inbox.store.where, "inbox", "batchId", first["batchId"]),
                                           key=lambda i: i.get("batchIndex", 0))] or ids
        while time.time() < end:
            for i in ids:
                ask = await asyncio.to_thread(inbox.ask_back, i)
                if ask:
                    title = next((x.get("title", "") for x in [await asyncio.to_thread(inbox.store.get, f"inbox/{i}") or {}]), "")
                    return (f'The owner asks back on "{title}" (id {i}): "{ask.get("text", "")}". This is not an answer. '
                            f"Reply in a few words with inbox_reply(item_id=\"{i}\", text=...) (draw it with an svg when "
                            f"it can be drawn), then call inbox_wait(item_id=\"{item_id}\").")
            items = [await asyncio.to_thread(inbox.store.get, f"inbox/{i}") or {} for i in ids]
            if all(x.get("status") == "answered" for x in items):
                texts = [t for i in ids if (t := await asyncio.to_thread(inbox.take_answer, i))]
                extra = await asyncio.to_thread(inbox.other_replies, item_id)
                return "\n".join([*texts, *extra])
            step += 1
            try:
                await ctx.report_progress(step, None, "waiting for the owner's answer")
            except Exception:
                pass
            await asyncio.sleep(POLL_SECONDS)
        return (
            f"No answer yet after {minutes:.0f} minutes. The question stays open in the inbox (id {item_id}). "
            "Call inbox_wait with this id to keep waiting, or go on with other work. If this session closes, the "
            "answer will be delivered by resuming it."
        )

    @mcp.tool()
    async def inbox_ask(question: str, ctx: Context, title: str = "", options: list[dict] | None = None,
                        recommended: int | None = None, context: str = "", wait_minutes: float = MAX_WAIT_MINUTES,
                        more_questions: list[dict] | None = None) -> str:
        """Ask the owner on the dashboard and wait for the answer. Draw before you write: the owner reads pictures
        faster than words.

        options: a list of {"label": short choice, "detail": one line, "differs": what is different about this
        option, a few words on the same point for every option, "example": {...}}. Each option needs a drawing
        (example type visual) or a differs line. recommended: the index of the option you recommend. context: the
        facts the owner needs to decide. wait_minutes: up to 25; then call inbox_wait.
        more_questions: other questions asked together, each {"question", "title", "options", "recommended"}: the
        owner sees and answers them as one batch, and you get all the answers at once.
        The owner may ask back before answering: you then get their question; reply with inbox_reply and wait again.

        example (required on every option while a plan is open), one of:
        {"type": "visual", "svg": an inline <svg> drawing of the option, small, labelled, no script};
        {"type": "image", "before": file path, "after": file path, "note": what to look at} (same view, with markers);
        {"type": "code", "diff": unified diff, "bench": [{"name", "before", "after", "measured": true|false,
         "source": the run that measured it}]} (say measured false for an estimate);
        {"type": "text", "draft": the draft text}.
        """
        try:
            if more_questions:
                batch = [{"title": title or question[:80], "text": (context + "\n\n" + question).strip(),
                          "options": options, "recommended": recommended}]
                batch += [{"title": q.get("title") or str(q.get("question", ""))[:80], "text": str(q.get("question", "")),
                           "options": q.get("options"), "recommended": q.get("recommended")} for q in more_questions]
                item_id = (await asyncio.to_thread(inbox.post_batch, batch))[0]
            else:
                item_id = await asyncio.to_thread(inbox.post, "question", title or question[:80],
                                                  (context + "\n\n" + question).strip(), options, recommended)
        except ValueError as e:
            return f"Not asked: {e}"
        return await wait_for(item_id, wait_minutes, ctx)

    @mcp.tool()
    async def inbox_reply(item_id: str, text: str) -> str:
        """Reply to the owner's question back on an inbox question: a few words (an svg drawing in the text is fine
        when it explains better). It never answers the question for the owner. Then call inbox_wait."""
        ok = await asyncio.to_thread(inbox.reply, item_id, text)
        return "Replied. Call inbox_wait to wait for the answer." if ok else f"No question {item_id}."

    @mcp.tool()
    async def inbox_wait(item_id: str, ctx: Context, wait_minutes: float = MAX_WAIT_MINUTES) -> str:
        """Keep waiting for the owner's answer to an earlier inbox_ask."""
        return await wait_for(item_id, wait_minutes, ctx)

    # Text only: Claude Code refuses a permission answer that also carries structured content ("Expected a single text
    # block param"), which the SDK adds to any tool returning str unless told not to.
    @mcp.tool(structured_output=False)
    async def inbox_approve(tool_name: str, input: dict, tool_use_id: str = "") -> str:
        """Permission prompt for runs started from the dashboard: the owner allows or denies the call in the inbox."""
        import json

        item_id = await asyncio.to_thread(
            inbox.post, "approval", f"Allow {tool_name}?", json.dumps(input, indent=1, ensure_ascii=False)[:3500],
            [{"label": "Allow", "detail": "run this call"}, {"label": "Deny", "detail": "the session is told it was denied"}],
        )
        what = input.get("command") or input.get("description") or input.get("file_path") or json.dumps(input, ensure_ascii=False)
        await asyncio.to_thread(push.notify, f"Approval needed: {tool_name}", str(what)[:160], f"/?item={item_id}", item_id)
        end = time.time() + MAX_WAIT_MINUTES * 60
        while time.time() < end:
            item = await asyncio.to_thread(inbox.store.get, f"inbox/{item_id}")
            if item and item.get("status") == "answered":
                await asyncio.to_thread(inbox.store.update, f"inbox/{item_id}",
                                        {"status": "delivered", "deliveredAt": now_iso(), "deliveredVia": "live"})
                return approval_reply(item, input)
            await asyncio.sleep(POLL_SECONDS)
        await asyncio.to_thread(inbox.store.update, f"inbox/{item_id}", {"status": "closed", "error": "No answer in time; denied."})
        return approval_reply(None, input)

    @mcp.tool()
    async def plan_start(title: str, text: str = "", note: str = "", parts: dict | None = None, source: str = "",
                         harness: list | None = None) -> str:
        """Open a plan on the dashboard, always in the latest format: parts is required (a plan with text only is
        refused). text: an extra markdown note for version 1, if you have one. Questions you ask with inbox_ask
        (or your question box) while the plan is open join it, in the round of its current version.

        parts: the six parts of a plan from a session, in this order: {"goal": markdown (quote the owner), "summary":
        markdown (cite log entries as #n), "rules": [{"rule", "source"}], "lessons": [{"lesson", "taught_by",
        "applied_in"}], "leftover": [text], "steps": [{"id", "title", "does", "check", "new": true for work the record does not hold}]}. source: the command id the
        dashboard gave you when it asked for a plan from a session."""
        try:
            plan_id = await asyncio.to_thread(inbox.plan_start, title, text, note, parts, source, harness)
        except ValueError as e:
            return f"Not opened: {e}"
        plan = await asyncio.to_thread(inbox.store.get, f"plans/{plan_id}")
        return f"Opened plan {plan_id} at version {plan.get('current', 0)}."

    @mcp.tool()
    async def plan_version(note: str, text: str = "", plan_id: str = "", parent: int = -1, parts: dict | None = None,
                           phase: str = "", order: str = "", harness: list | None = None) -> str:
        """Post the next version of the plan (the whole text, markdown, or for a plan with parts the whole six parts).
        Only when the plan's data changes; a step moving is step_update. note: one line on what changed and which
        answers or message caused it. plan_id: this session's plan when empty. parent: the version it grows
        from; leave it out for the current one, or give an older one when the owner reopened an answer (a branch).
        phase: explore, build, verify, remove or optimize. Only the owner moves a phase, forward or back: when the owner
        orders a move, call this with phase and order (the owner's words), and leave text and parts out for a plain
        version that keeps the data. harness: the whole harness list, each {"id": "h1", "item", "kind": "tool" or
        "check"}: the tools and context each step needs, and each step's check; the owner approves every item on the
        page. Left out, the list stays as it was."""
        plan_id = plan_id or ((await asyncio.to_thread(inbox.open_plan)) or {}).get("id", "")
        if not plan_id:
            return "No plan in this session. Open one with plan_start."
        try:
            n = await asyncio.to_thread(inbox.plan_version, plan_id, text, note, None if parent < 0 else parent, None, parts,
                                      "", phase, order, harness)
        except ValueError as e:
            return str(e)
        out = f"Saved version {n} of plan {plan_id}. Questions asked from now on are round {n}."
        split = ((await asyncio.to_thread(inbox.store.get, f"planVersions/{plan_id}_v{n}")) or {}).get("phaseMove", {}).get("harness")
        if split:
            out += (" Build uses only the approved harness items: " + (", ".join(split["approved"]) or "none")
                    + ". Not approved, left out of Build: " + (", ".join(split["notApproved"]) or "none") + ".")
        return out

    @mcp.tool()
    async def step_update(step_id: str, state: str, reply: str, plan_id: str = "") -> str:
        """Report on one step of the plan: state next, now, done or failed, and your reply (what was done, the
        numbers, what is open). A step version; never a plan version. Questions asked while a step is now join it."""
        plan_id = plan_id or ((await asyncio.to_thread(inbox.open_plan)) or {}).get("id", "")
        if not plan_id:
            return "No plan in this session."
        try:
            n = await asyncio.to_thread(inbox.step_update, plan_id, step_id, state, reply)
        except ValueError as e:
            return str(e)
        return f"Saved step version {n} of {step_id} ({state})."

    @mcp.tool()
    async def plan_switch(to: str, change: str, why: str, ctx: Context) -> str:
        """In a Q&A message, when the answer needs the plan changed: ask the owner to switch the message to another
        kind (goal, step, rule or lesson). change: the exact change you would make (the owner sees it as the draft).
        Waits for the answer; only after the owner confirms may you post plan_version."""
        try:
            item_id = await asyncio.to_thread(inbox.ask_switch, to, change, why)
        except ValueError as e:
            return str(e)
        text = await wait_for(item_id, MAX_WAIT_MINUTES, ctx)
        ok = await asyncio.to_thread(inbox.confirm_switch, item_id)
        return text + ("\nThe owner confirmed the switch: make the change now with plan_version." if ok else
                       "\nNo switch: answer only, change nothing.")

    @mcp.tool()
    async def inbox_suggest(title: str, suggestion: str) -> str:
        """Post a suggestion for the owner to accept or decline. Does not wait."""
        item_id = await asyncio.to_thread(inbox.post, "suggestion", title, suggestion)
        replies = await asyncio.to_thread(inbox.other_replies, item_id)
        return "\n".join([f"Posted suggestion {item_id}.", *replies])

    @mcp.tool()
    async def inbox_result(title: str, summary: str, files: list[str] | None = None) -> str:
        """Post a result for the owner to review: what was done, the numbers, the files to look at. Does not wait."""
        item_id = await asyncio.to_thread(inbox.post, "result", title, summary, None, None, files)
        replies = await asyncio.to_thread(inbox.other_replies, item_id)
        return "\n".join([f"Posted result {item_id} for review.", *replies])

    # The archiver (archiver.py; the owner's choice, 2026-11-06: "the bridge checks for free and wakes the archiver only
    # when needed, with the archiver in Auto"). Only the archiver session calls these two.
    from .archiver import Hand
    from .config import data_dir

    hand = Hand(data_dir() / "runs" / "archiver", inbox.session_id)

    @mcp.tool()
    async def archiver_wait() -> str:
        """For the archiver session only. Waits (no tokens) until the bridge asks you to archive or unarchive a
        session, or ARCHIVER_WAIT seconds pass; then returns the ask as JSON, or "nothing". Call it again after each
        answer, forever."""
        ask = await asyncio.to_thread(hand.take, ARCHIVER_WAIT)
        return json.dumps(ask) if ask else "nothing"

    @mcp.tool()
    async def archiver_report(cid: str, action: str, ok: bool, note: str = "", app_session: str = "") -> str:
        """For the archiver session only. Report one ask: cid and action from the ask, ok true when the session was
        archived (or unarchived), else ok false and note why (busy, pinned, open on screen, no match, refused).
        app_session: the app's session id you acted on (local_...)."""
        await asyncio.to_thread(hand.report, cid, action, ok, note, app_session)
        return "Reported. Call archiver_wait again."

    mcp.run("stdio")


if __name__ == "__main__":
    server()
