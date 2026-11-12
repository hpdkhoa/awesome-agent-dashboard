"""Listens to the page's commands (start, message, stop) instead of asking Firestore every 5 seconds.

Firestore's REST API cannot listen, so this one part uses Firestore's gRPC client. It signs in with the same owner
Firebase ID token as the rest of the bridge, so the same rules apply. A listen costs one read per changed command,
not two queries every 5 seconds (about 34,600 reads a day). The listener is opened again every 50 minutes, before the
ID token it opened with expires, and at once if it drops. Until its first answer arrives, `current()` returns None and
the caller asks once the old way.
"""

from __future__ import annotations

import json
import threading
import time

REOPEN_SECONDS = 50 * 60  # ID tokens last an hour; reopen with a fresh one before that
STATUSES = ["new", "waiting"]  # the commands a bridge still has to act on


def firestore_client(session):
    """A gRPC Firestore client that sends the owner's Firebase ID token with every call."""
    from google.auth.credentials import Credentials
    from google.cloud import firestore

    class FirebaseIdToken(Credentials):
        def refresh(self, request):
            self.token = session.token()

        @property
        def expired(self):
            return False

        @property
        def valid(self):
            return True

        def before_request(self, request, method, url, headers):
            headers["authorization"] = f"Bearer {session.token()}"

    return firestore.Client(project=session.cfg.project_id, credentials=FirebaseIdToken())


class Feed:
    """One listen, reopened every 50 minutes and after a drop. Subclasses say what to listen to."""

    name = "feed"

    def __init__(self, client, clock=time.monotonic):
        self.client, self.clock = client, clock
        self.lock = threading.Lock()
        self.docs: dict[str, dict] | None = None
        self.watch = None
        self.opened = 0.0
        self.opens = 0

    def _on_snapshot(self, docs, changes, read_time) -> None:
        from . import firestore as fs

        if fs.counter is not None:  # each changed document delivered is one read
            size = 0
            for ch in changes or []:
                try:
                    size += len(json.dumps(ch.document.to_dict() or {}, default=str))
                except Exception:
                    pass
            fs.counter.add("reads", max(1, len(changes or [])), "listen:" + self.name, size)
        rows = {d.id: {**(d.to_dict() or {}), "id": d.id} for d in docs}
        with self.lock:
            self.docs = rows

    def _query(self):
        raise NotImplementedError

    def _open(self) -> None:
        if self.watch is not None:
            try:
                self.watch.unsubscribe()
            except Exception:
                pass
        with self.lock:
            self.docs = None
        self.watch = self._query().on_snapshot(self._on_snapshot)
        self.opened = self.clock()
        self.opens += 1

    def _dropped(self) -> bool:
        return self.watch is None or bool(getattr(self.watch, "_closed", False))

    def current(self) -> list[dict] | None:
        """The documents as of the last change; None while (re)opening."""
        if self._dropped() or self.clock() - self.opened > REOPEN_SECONDS:
            self._open()
        with self.lock:
            return None if self.docs is None else list(self.docs.values())

    def close(self) -> None:
        if self.watch is not None:
            self.watch.unsubscribe()
            self.watch = None


class CommandFeed(Feed):
    """The commands still to act on."""

    name = "commands(new,waiting)"

    def _query(self):
        from google.cloud.firestore_v1.base_query import FieldFilter

        return self.client.collection("commands").where(filter=FieldFilter("status", "in", STATUSES))


class DeletedFeed(Feed):
    """meta/deleted: the paths the owner deleted on the Storage tab, which sync must not write again."""

    name = "meta/deleted"

    def _query(self):
        return self.client.collection("meta").document("deleted")

    def paths(self) -> set[str] | None:
        rows = self.current()
        if rows is None:
            return None
        return {p for r in rows for p in (r.get("paths") or {})}

# The avatar's account counts (plan b73e97ad p10; the owner's picks, 2026-11-11: "C: bridges publish, avatar listens",
# Firestore "Optimized": "counts come from listeners"). Before, /status asked 7 queries a round (20 reads, measured in
# p9). A listen costs one read per changed document, and its first answer one read per matching document.

GOING = ["new", "running", "waiting", "stopping"]  # chain.GOING
LIVE_SECONDS = 180  # inbox.LIVE_SECONDS
INBOX = ["open", "answered", "delivering"]  # deliver.py's statuses; the avatar counts "open"


class QueryFeed(Feed):
    """A listen on any query: make(client) builds it, again at every reopen."""

    def __init__(self, client, make, clock=time.monotonic, name="query"):
        super().__init__(client, clock)
        self.make, self.name = make, name

    def _query(self):
        return self.make(self.client)


class AccountFeeds:
    """The listens behind the avatar's counts: commands going, sessions beating, inbox questions open, machines, the
    newest plans, and the newest open plan's current version and step states. read() gives what status.Status._read
    gave from its queries, or None while a listen is still opening (the caller then asks the old way once)."""

    def __init__(self, client, wall=time.time, live_count=None):
        from google.cloud.firestore_v1.base_query import FieldFilter

        self.client, self.wall = client, wall
        self.F = F = FieldFilter
        self.commands = QueryFeed(client, lambda c: c.collection("commands").where(filter=F("status", "in", GOING)), name="commands(going)")
        # no listen on liveSessions (the owner's words, 2026-11-12: "stop listening to beats on the bridge": every beat
        # read back cost 4,946 reads a day); the sessions open on this machine come from the process scan, 0 reads
        self.live = None
        self.live_count = live_count or _open_sessions
        # the inbox items still to ask, answer or deliver: the avatar counts the open ones, deliver.py acts on all
        # three (p14 F4: one listen instead of 3 queries a minute)
        self.inbox = QueryFeed(client, lambda c: c.collection("inbox").where(filter=F("status", "in", INBOX)),
                               name="inbox(open,answered,delivering)")
        self.machines = QueryFeed(client, lambda c: c.collection("machines"), name="machines")
        self.plans = QueryFeed(client, lambda c: c.collection("plans").order_by(
            "updatedAt", direction="DESCENDING").limit(5), name="plans(5)")
        self.plan_key: tuple | None = None
        self.version: QueryFeed | None = None
        self.steps: QueryFeed | None = None

    def _plan(self, plan: dict) -> tuple[list | None, list | None]:
        key = (plan["id"], plan.get("current", 0))
        if key != self.plan_key:
            for f in (self.version, self.steps):
                if f is not None:
                    f.close()
            pid, cur = key
            self.version = QueryFeed(self.client, lambda c: c.collection("planVersions").document(f"{pid}_v{cur}"), name="planVersions")
            self.steps = QueryFeed(self.client, lambda c: c.collection("planSteps").where(
                filter=self.F("planId", "==", pid)), name="planSteps")
            self.plan_key = key
        return self.version.current(), self.steps.current()

    def read(self, now: float) -> dict | None:
        rows = [f.current() for f in (self.commands, self.inbox, self.machines, self.plans)]
        if any(r is None for r in rows):
            return None
        going, waiting, machines, plans = rows
        live = self.live.current() if self.live is not None else None
        if live is None:
            live = [{"beatAt": _iso(now)} for _ in range(self.live_count())]
        cutoff = _iso(now - LIVE_SECONDS)
        plans = sorted(plans, key=lambda p: p.get("updatedAt") or "", reverse=True)
        plan = next((p for p in plans if p.get("status", "open") == "open"), None)
        plan_out = None
        if plan:
            v, st = self._plan(plan)
            if v is None or st is None:
                return None
            steps = [s.get("id") for s in (((v[0] if v else {}).get("parts") or {}).get("steps") or [])]
            states = {d.get("stepId"): d.get("state") for d in st}
            plan_out = {"id": plan["id"], "title": plan.get("title", ""), "phase": plan.get("phase", ""),
                        "stepsDone": sum(1 for i in steps if states.get(i) == "done"), "stepsAll": len(steps),
                        "steps": [{"id": i, "state": states.get(i) or "next"} for i in steps]}
        return {"going": len(going), "sessions": sum(1 for s in live if (s.get("beatAt") or "") >= cutoff),
                "inbox": sum(1 for i in waiting if i.get("status") == "open"), "machines": machines, "plan": plan_out}

    def close(self) -> None:
        for f in (self.commands, self.live, self.inbox, self.machines, self.plans, self.version, self.steps):
            if f is not None:
                f.close()


def _open_sessions() -> int:
    """Sessions open in the app or a terminal on this machine, from the process scan (runs.claude_processes)."""
    from .runs import claude_processes

    seen = claude_processes()
    return 0 if seen is None else sum(1 for sid, _ in seen if sid)


def _iso(t: float) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp(t, timezone.utc).isoformat(timespec="seconds")
