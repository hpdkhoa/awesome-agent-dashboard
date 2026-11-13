"""This bridge's entry in the registry of boxes (the owner's words, 2026-11-13: "use firestore as control plane, the
bridge and data on dashboard will select directly from each bridge"; "make it in the way I can plug and play another
box in this dashboard, same with unplug").

Firestore holds one small document per box, bridges/<machine>: name, url (the box's own tunnel address, FILES_URL), db
("local" once the box keeps its data in its own file), seenAt. The page reads the registry and talks to each box
directly. `plugged` is the owner's (set on the page): this bridge writes it once, true, when it first registers, and
never again. Writes only: on start, and every KEEPALIVE_SECONDS.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone

KEEPALIVE_SECONDS = 900


class Registry:
    def __init__(self, firestore, machine: str, url: str, db: str, clock=time.time):
        self.fs, self.machine, self.url, self.db, self.clock = firestore, machine, url, db, clock
        self.at = 0.0

    def step(self, force: bool = False) -> str | None:
        now = self.clock()
        if not self.url or (not force and now - self.at < KEEPALIVE_SECONDS):
            return None
        fields = {"name": self.machine, "url": self.url, "db": self.db,
                  "seenAt": datetime.fromtimestamp(now, timezone.utc).isoformat(timespec="seconds")}
        first = False
        if not self.fs.update(f"bridges/{self.machine}", fields):  # not registered yet: plugged in, once
            self.fs.put_many({f"bridges/{self.machine}": {**fields, "plugged": True}})
            first = True
        was, self.at = self.at, now
        return f"registered as box {self.machine} at {self.url}" if first else (f"box {self.machine} in the registry" if was == 0 else None)
