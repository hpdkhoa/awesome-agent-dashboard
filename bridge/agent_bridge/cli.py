"""agent-bridge signin | sync | watch. Read-only on Claude Code: it reads the logs and never runs claude."""

from __future__ import annotations

import argparse
import os
import sys
import time

from .auth import Session, sign_in
from .config import Config, data_dir
from .firestore import Firestore
from .sync import run


def main(argv: list[str] | None = None) -> None:
    if sys.stdout is None:
        # Started without a console (pythonw, a scheduled task): write to a log file next to the bridge's state.
        sys.stdout = sys.stderr = open(data_dir() / "bridge.log", "a", encoding="utf-8", buffering=1)
    p = argparse.ArgumentParser(prog="agent-bridge")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("signin", help="sign in once with your Google account")
    s.add_argument("--port", type=int, default=0, help="fixed port, for an ssh tunnel from another machine")
    s.add_argument("--no-browser", action="store_true", help="print the link instead of opening a browser")
    for name in ("sync", "watch"):
        c = sub.add_parser(name, help="send sessions and spend once" if name == "sync" else "sync every --every seconds")
        c.add_argument("--days", type=float, default=30, help="only sessions touched in the last N days")
        c.add_argument("--dry-run", action="store_true", help="read and count, write nothing")
        if name == "watch":
            c.add_argument("--every", type=float, default=60)
    a = p.parse_args(argv)

    if os.environ.get("ANTHROPIC_API_KEY"):
        # Terms T7: the bridge must never make Claude Code bill an API account by mistake.
        raise SystemExit("ANTHROPIC_API_KEY is set. Unset it: the bridge works only with your Claude plan sign-in.")

    cfg = Config.load()
    if a.cmd == "signin":
        where = sign_in(cfg, port=a.port, open_browser=not a.no_browser)
        Firestore(Session(cfg)).check_owner()
        print(f"Signed in as the owner. Token stored in {where}.")
        return

    store = None
    if not a.dry_run:
        store = Firestore(Session(cfg))
        store.check_owner()
    while True:
        try:
            r = run(cfg, a.days, store, dry_run=a.dry_run)
            print(
                f"{time.strftime('%Y-%m-%d %H:%M:%S')} sessions {r['sessions']}, tokens {r['tokens']:,}, "
                f"list-price estimate ${r['costUsd']:,}, documents {'to write' if a.dry_run else 'written'} "
                f"{r['toWrite'] if a.dry_run else r['written']}",
                flush=True,
            )
        except (Exception, SystemExit) as e:
            if a.cmd == "sync":
                raise
            # watch keeps going through a network drop or a refused write, and tries again next round
            print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} sync failed, retrying in {a.every:.0f}s: {e}", flush=True)
        if a.cmd == "sync":
            return
        time.sleep(a.every)
