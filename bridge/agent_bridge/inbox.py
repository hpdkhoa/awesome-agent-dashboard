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
"""


import os
import threading
import time
import uuid
from datetime import datetime, timezone

from .aggregate import work_type_of
from .redact import redact

BEAT_SECONDS = 60
LIVE_SECONDS = 180  # a session whose heartbeat is older than this is treated as closed
POLL_SECONDS = 5
MAX_WAIT_MINUTES = 25  # under Claude Code's 30-minute idle limit for a local MCP server
PUSH_TITLE = {"question": "Question", "suggestion": "Suggestion", "result": "Result to review"}


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

    def open_plan(self) -> dict | None:
        """This session's open plan, the newest if there are several."""
        if self.session_id == "unknown":
            return None
        plans = [p for p in self.store.where("plans", "sessionId", self.session_id) if p.get("status") == "open"]
        return max(plans, key=lambda p: p.get("createdAt", ""), default=None)

    def plan_start(self, title: str, text: str = "", note: str = "") -> str:
        plan_id = uuid.uuid4().hex[:20]
        self.store.put_many({f"plans/{plan_id}": {
            "id": plan_id, "title": redact(title, 200), "sessionId": self.session_id, "machine": self.machine,
            "cwd": self.cwd, "workType": work_type_of(self.cwd, self.roots), "status": "open", "current": 0,
            "createdAt": now_iso(), "updatedAt": now_iso(),
        }})
        if text.strip():
            self.plan_version(plan_id, text, note)
        return plan_id

    def plan_version(self, plan_id: str, text: str, note: str = "", parent: int | None = None,
                     answers: list[str] | None = None) -> int:
        """Saves the next version of a plan and returns its number. Questions asked from now on are its round.

        parent: the version this one grows from (default: the current one; an older one makes a branch).
        answers: the inbox ids of the answers that made it (default: the answered questions asked on the parent).
        Each answer is kept as it was then, so a branch made before a reopen still shows the old answer.
        """
        plan = self.store.get(f"plans/{plan_id}")
        if not plan:
            raise ValueError(f"no plan {plan_id}")
        current = int(plan.get("current", 0))
        parent = current if parent is None else parent
        if not 0 <= parent <= current:
            raise ValueError(f"plan {plan_id} has no version {parent}")
        asked = {i["id"]: i for i in self.store.where("inbox", "planId", plan_id)}
        if answers is None:
            answers = [k for k, i in asked.items() if int(i.get("round", 0)) == parent and i.get("answer")]
        made_by = [{"id": k, "title": asked[k].get("title", ""), "choice": (asked[k].get("answer") or {}).get("choice", ""),
                    "text": (asked[k].get("answer") or {}).get("text", "")} for k in answers if k in asked]
        # a plan's numbers only grow, so a branch from an old version still gets the next number
        n = int(plan.get("last", current)) + 1
        self.store.put_many({f"planVersions/{plan_id}_v{n}": {
            "id": f"{plan_id}_v{n}", "planId": plan_id, "n": n, "parent": parent, "madeBy": made_by,
            "text": redact(text, 30000), "note": redact(note, 400), "createdAt": now_iso(),
        }})
        self.store.update(f"plans/{plan_id}", {"current": n, "last": n, "chosen": n, "updatedAt": now_iso()})
        if self.push is not None:
            self.push.notify(f"Plan v{n}: {plan.get('title', '')}", note or "New version.", f"/?plan={plan_id}", f"plan-{plan_id}")
        return n

    def plan_close(self, plan_id: str, note: str = "") -> None:
        self.store.update(f"plans/{plan_id}", {"status": "done", "closeNote": redact(note, 400), "updatedAt": now_iso()})

    def post(self, kind: str, title: str, text: str, options: list[dict] | None = None,
             recommended: int | None = None, files: list[str] | None = None, extra: dict | None = None) -> str:
        item_id = uuid.uuid4().hex[:20]
        extra = dict(extra or {})
        if kind == "question" and "planId" not in extra:
            plan = self.open_plan()
            if plan:
                extra.update(planId=plan["id"], round=int(plan.get("current", 0)))
        opts = [{"label": redact(o.get("label", ""), 120), "detail": redact(o.get("detail", ""), 400)} for o in options or []]
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

    def beat(self) -> None:
        if self.session_id != "unknown":
            self.store.put_many({f"liveSessions/{self.session_id}": {
                "sessionId": self.session_id, "machine": self.machine, "cwd": self.cwd, "beatAt": now_iso()}})

    def take_answer(self, item_id: str) -> str | None:
        """The owner's answer as text for the session, marking the item delivered; None while it is still open."""
        item = self.store.get(f"inbox/{item_id}")
        if not item or item.get("status") != "answered":
            return None
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
            "with rounds of questions, open a plan with plan_start, post each new version with plan_version, and close "
            "it with plan_close: every question you ask while it is open joins the round of its current version."
        ),
    )

    async def wait_for(item_id: str, minutes: float, ctx: Context) -> str:
        minutes = max(1.0, min(minutes, MAX_WAIT_MINUTES))
        end = time.time() + minutes * 60
        step = 0
        while time.time() < end:
            text = await asyncio.to_thread(inbox.take_answer, item_id)
            if text:
                extra = await asyncio.to_thread(inbox.other_replies, item_id)
                return "\n".join([text, *extra])
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
                        recommended: int | None = None, context: str = "", wait_minutes: float = MAX_WAIT_MINUTES) -> str:
        """Ask the owner a question on the dashboard and wait for the answer.

        options: a list of {"label": short choice, "detail": one line}. recommended: the index of the option you
        recommend. context: the facts the owner needs to decide. wait_minutes: up to 25; then call inbox_wait.
        """
        item_id = await asyncio.to_thread(inbox.post, "question", title or question[:80],
                                          (context + "\n\n" + question).strip(), options, recommended)
        return await wait_for(item_id, wait_minutes, ctx)

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
    async def plan_start(title: str, text: str = "", note: str = "") -> str:
        """Open a plan on the dashboard. text: version 1 (markdown), if you have one. Questions you ask with inbox_ask
        (or your question box) while the plan is open join it, in the round of its current version."""
        plan_id = await asyncio.to_thread(inbox.plan_start, title, text, note)
        plan = await asyncio.to_thread(inbox.store.get, f"plans/{plan_id}")
        return f"Opened plan {plan_id} at version {plan.get('current', 0)}."

    @mcp.tool()
    async def plan_version(text: str, note: str, plan_id: str = "", parent: int = -1) -> str:
        """Post the next version of the plan (the whole text, markdown). note: one line on what changed and which
        answers caused it. plan_id: this session's open plan when empty. parent: the version it grows from; leave it
        out for the current one, or give an older one when the owner reopened an answer (a branch)."""
        plan_id = plan_id or ((await asyncio.to_thread(inbox.open_plan)) or {}).get("id", "")
        if not plan_id:
            return "No open plan in this session. Open one with plan_start."
        try:
            n = await asyncio.to_thread(inbox.plan_version, plan_id, text, note, None if parent < 0 else parent)
        except ValueError as e:
            return str(e)
        return f"Saved version {n} of plan {plan_id}. Questions asked from now on are round {n}."

    @mcp.tool()
    async def plan_close(note: str = "", plan_id: str = "") -> str:
        """Close the plan when the owner approved it or it ended. plan_id: this session's open plan when empty."""
        plan_id = plan_id or ((await asyncio.to_thread(inbox.open_plan)) or {}).get("id", "")
        if not plan_id:
            return "No open plan in this session."
        await asyncio.to_thread(inbox.plan_close, plan_id, note)
        return f"Closed plan {plan_id}."

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

    mcp.run("stdio")


if __name__ == "__main__":
    server()
