"""Which database this process uses (the owner's words, 2026-11-13: "switch firestore into local DB in the place bridge
is hosted ... firestore can keep as backup"; pick 4a: other machines call this PC's bridge).

- DB_HOST_URL set: another machine: the bridge that hosts the database, over its data API (RemoteStore).
- else the local file exists (made by `agent-bridge import-firestore`) and DB is not "firestore": the local database.
- else Firestore, as before: nothing changes until the import ran.
"""

from __future__ import annotations

from .auth import Session
from .config import data_dir
from .firestore import Firestore
from .localdb import LocalStore, RemoteStore

DB_FILE = "data.sqlite"


def db_path():
    return data_dir() / DB_FILE


def open_store(cfg):
    if getattr(cfg, "db_host_url", ""):
        return RemoteStore(cfg.db_host_url, Session(cfg))
    if getattr(cfg, "db", "") != "firestore" and db_path().is_file():
        return LocalStore(db_path())
    return Firestore(Session(cfg))


def is_local(store) -> bool:
    return isinstance(store, LocalStore)


def is_firestore(store) -> bool:
    return isinstance(store, Firestore)
