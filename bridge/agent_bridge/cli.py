"""agent-bridge signin | sync | watch | inbox.

sync and watch read Claude Code's logs. watch also delivers the owner's answers to closed sessions by resuming them
(deliver.py) and starts and stops the runs the owner asks for on the page (runs.py). inbox is the MCP server each
session starts.
"""

from __future__ import annotations

import argparse
import os
import sys
import time

from .auth import Session, sign_in
from .config import Config, data_dir
from .firestore import Firestore
from .deliver import deliver, find_claude
from .runs import Runs
from .sync import run

COMMAND_SECONDS = 5  # how often watch acts on the commands the listener holds and checks its runs


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
    sub.add_parser("inbox", help="the inbox MCP server (started by Claude Code, not by hand)")
    a = p.parse_args(argv)

    if a.cmd == "inbox":
        from .inbox import server

        server()
        return

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
    claude = find_claude(cfg.claude_bin)
    runs = None
    if store is not None and a.cmd == "watch":
        runs = Runs(store, cfg.machine, cfg.roots, claude, data_dir() / "runs", logs=cfg.logs)
        runs.forget_lost()
        feed = None
        try:
            from .listen import CommandFeed, firestore_client

            feed = CommandFeed(firestore_client(store.s))
        except ImportError:
            print("google-cloud-firestore is not installed: asking for commands every 5 s instead of listening", flush=True)
    stamp = lambda: time.strftime("%Y-%m-%d %H:%M:%S")
    next_sync = 0.0
    while True:
        try:
            if time.time() >= next_sync:
                next_sync = time.time() + a.every
                r = run(cfg, a.days, store, dry_run=a.dry_run)
                print(
                    f"{stamp()} sessions {r['sessions']}, tokens {r['tokens']:,}, "
                    f"list-price estimate ${r['costUsd']:,}, documents {'to write' if a.dry_run else 'written'} "
                    f"{r['toWrite'] if a.dry_run else r['written']}",
                    flush=True,
                )
                if store is not None:
                    for line in deliver(store, cfg.machine, claude):
                        print(f"{stamp()} inbox {line}", flush=True)
            if runs is not None:
                for line in runs.step(feed.current() if feed is not None else None):
                    print(f"{stamp()} run {line}", flush=True)
        except (Exception, SystemExit) as e:
            if a.cmd == "sync":
                raise
            # watch keeps going through a network drop or a refused write, and tries again next round
            print(f"{stamp()} failed, retrying: {e}", flush=True)
        if a.cmd == "sync":
            return
        time.sleep(COMMAND_SECONDS)
