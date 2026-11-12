"""agent-bridge signin | sync | watch | inbox | ask-hook.

sync and watch read Claude Code's logs. watch also delivers the owner's answers to closed sessions by resuming them
(deliver.py), starts and stops the runs the owner asks for on the page (runs.py), and serves the file viewer
(files.py). inbox is the MCP server each
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
    sub.add_parser("ask-hook", help="the question hook: Claude Code's question box goes to the inbox first")
    sub.add_parser("push-setup", help="make this machine's push key once and publish its public half for the page")
    sub.add_parser("push-test", help="send a test notification to every subscribed phone")
    a = p.parse_args(argv)

    if a.cmd == "inbox":
        from .inbox import server

        server()
        return
    if a.cmd == "ask-hook":
        from .ask import main as ask_main

        ask_main()
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

    if a.cmd in ("push-setup", "push-test"):
        from .push import pusher, setup

        store = Firestore(Session(cfg))
        store.check_owner()
        if a.cmd == "push-setup":
            print(f"Push key ready. Public key: {setup(store)}")
        else:
            n = pusher(store, cfg.owner_email).notify("Test from the agent dashboard", "Notifications work.", "/", "test")
            print(f"Sent to {n} device(s).")
        return

    store = None
    if not getattr(a, "dry_run", False):
        store = Firestore(Session(cfg))
        store.check_owner()
    claude = find_claude(cfg.claude_bin)
    runs = gone = publisher = None
    if store is not None and a.cmd == "watch":
        from .push import pusher

        runs = Runs(store, cfg.machine, cfg.roots, claude, data_dir() / "runs", logs=cfg.logs,
                    push=pusher(store, cfg.owner_email))
        for line in runs.forget_lost():
            print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} run {line}", flush=True)
        try:  # plan questions answered before snapshots existed (snapshot.py), once per start
            from .snapshot import backfill

            for line in backfill(store, cfg.machine):
                print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} snapshot {line}", flush=True)
        except Exception as e:
            print(f"snapshot backfill failed: {e}", flush=True)
        if cfg.files_url:
            from .files import Files, firebase_verifier, serve

            # the pages and notes a plan from a session was built from open in the viewer too
            plans = data_dir() / "runs" / "plans"
            plans.mkdir(parents=True, exist_ok=True)
            from .texts import Texts

            serve(Files([*cfg.roots, ("plans", str(plans))], firebase_verifier(cfg.project_id, cfg.owner_email)),
                  list(cfg.site_origins), cfg.files_port, Texts(cfg.logs, data_dir() / "runs"))
            store.put_many({"meta/files": {"url": cfg.files_url}})
            print(f"file viewer on 127.0.0.1:{cfg.files_port} for {cfg.files_url}", flush=True)
        from .status import Publisher, Status, serve as serve_status

        status = Status(store, cfg.machine, cfg.status_hosts, runs)
        serve_status(status, cfg.status_port)
        publisher = Publisher(store, cfg.machine)
        print(f"avatar status on 127.0.0.1:{cfg.status_port}/status", flush=True)
        feed = gone = None
        try:
            from .listen import AccountFeeds, CommandFeed, DeletedFeed, firestore_client

            client = firestore_client(store.s)
            feed, gone = CommandFeed(client), DeletedFeed(client)
            status.feeds = AccountFeeds(client)  # p10: the avatar's counts from listens, not a 20-read round
            if runs is not None:  # p16: the owner's run settings (meta/runs) from a listen, not a read each turn
                from .listen import QueryFeed

                runs.prefs_feed = QueryFeed(client, lambda c: c.collection("meta").document("runs"), name="meta/runs")
        except ImportError:
            print("google-cloud-firestore is not installed: asking for commands every 5 s instead of listening", flush=True)
    stamp = lambda: time.strftime("%Y-%m-%d %H:%M:%S")
    next_sync = 0.0
    while True:
        try:
            if time.time() >= next_sync:
                next_sync = time.time() + getattr(a, "every", 0)  # sync has no --every: it runs once
                r = run(cfg, a.days, store, dry_run=a.dry_run, deleted=gone.paths if gone is not None else lambda: None)
                print(
                    f"{stamp()} sessions {r['sessions']}, tokens {r['tokens']:,}, "
                    f"list-price estimate ${r['costUsd']:,}, documents {'to write' if a.dry_run else 'written'} "
                    f"{r['toWrite'] if a.dry_run else r['written']}",
                    flush=True,
                )
                if store is not None and a.cmd == "watch":
                    # p10: this bridge's state into machines/<this machine>, on a change or every 5 min; at once when
                    # the sync above replaced that record (which drops the published fields)
                    publisher.publish(status.publish_state(), force=r.get("machineWritten", False))
                if store is not None:
                    inbox = status.feeds.inbox.current() if a.cmd == "watch" and status.feeds is not None else None
                    for line in deliver(store, cfg.machine, claude, inbox):
                        print(f"{stamp()} inbox {line}", flush=True)
            if runs is not None:
                for line in runs.step(feed.current() if feed is not None else None):
                    print(f"{stamp()} run {line}", flush=True)
            if publisher is not None:
                # p11: every 5 s turn; writes only when a value changed (an avatar sees it within ~5 s), else nothing
                publisher.publish(status.publish_state())
        except (Exception, SystemExit) as e:
            if a.cmd == "sync":
                raise
            # watch keeps going through a network drop or a refused write, and tries again next round
            print(f"{stamp()} failed, retrying: {e}", flush=True)
        if a.cmd == "sync":
            return
        time.sleep(COMMAND_SECONDS)
