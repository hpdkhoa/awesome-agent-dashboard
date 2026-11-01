"""Listens to the page's commands (start, message, stop) instead of asking Firestore every 5 seconds.

Firestore's REST API cannot listen, so this one part uses Firestore's gRPC client. It signs in with the same owner
Firebase ID token as the rest of the bridge, so the same rules apply. A listen costs one read per changed command,
not two queries every 5 seconds (about 34,600 reads a day). The listener is opened again every 50 minutes, before the
ID token it opened with expires, and at once if it drops. Until its first answer arrives, `current()` returns None and
the caller asks once the old way.
"""

from __future__ import annotations

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

    def __init__(self, client, clock=time.monotonic):
        self.client, self.clock = client, clock
        self.lock = threading.Lock()
        self.docs: dict[str, dict] | None = None
        self.watch = None
        self.opened = 0.0
        self.opens = 0

    def _on_snapshot(self, docs, changes, read_time) -> None:
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

    def _query(self):
        from google.cloud.firestore_v1.base_query import FieldFilter

        return self.client.collection("commands").where(filter=FieldFilter("status", "in", STATUSES))


class DeletedFeed(Feed):
    """meta/deleted: the paths the owner deleted on the Storage tab, which sync must not write again."""

    def _query(self):
        return self.client.collection("meta").document("deleted")

    def paths(self) -> set[str] | None:
        rows = self.current()
        if rows is None:
            return None
        return {p for r in rows for p in (r.get("paths") or {})}