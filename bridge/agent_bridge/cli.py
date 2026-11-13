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
import threading
import time

from .auth import Session, sign_in
from .config import Config, data_dir
from .firestore import Firestore
from .deliver import deliver, find_claude
from .runs import Runs
from .sync import run

COMMAND_SECONDS = 5  # how often watch acts on the commands the listener holds and checks its runs


_LOCK = None


def one_bridge(folder) -> bool:
    """Holds watch.lock for the life of this process; False when another bridge holds it (step i10: the task
    watchdog must never start a second bridge). The lock goes with the process, so a killed bridge frees it."""
    global _LOCK
    f = open(folder / "watch.lock", "a+")
    try:
        if os.name == "nt":
            import msvcrt

            f.seek(0)
            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        f.close()
        return False
    _LOCK = f
    return True


def patient(what: str, fn, sleep=time.sleep, wait: float = 60.0):
    """A Firestore call at start that is refused (429 quota exceeded, 503) waits and tries again instead of ending the
    bridge (the owner's words, 2026-11-13: "fix the start so a 429 waits and retries instead of exiting"). Any other
    refusal (403: not the owner) still ends it."""
    while True:
        try:
            return fn()
        except SystemExit as e:
            text = str(e)
            if "Firestore refused (429)" not in text and "Firestore refused (503)" not in text:
                raise
            print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {what}: {text.splitlines()[0]} trying again in {wait:.0f} s", flush=True)
            sleep(wait)


def _data_api(store):
    from .dataapi import DataApi

    return DataApi(store)


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
    sub.add_parser("import-firestore", help="copy Firestore into the local database once; from then the bridge uses the local file")
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

    if a.cmd == "import-firestore":
        # the owner's words, 2026-11-13: "switch firestore into local DB in the place bridge is hosted"
        from .localdb import LocalStore
        from .mirror import import_firestore
        from .store import db_path

        fs = Firestore(Session(cfg))
        fs.check_owner()
        tmp = db_path().with_suffix(".importing")
        for f in (tmp, tmp.with_name(tmp.name + "-wal"), tmp.with_name(tmp.name + "-shm")):
            f.unlink(missing_ok=True)
        counts = import_firestore(fs, LocalStore(tmp))
        if db_path().exists():
            raise SystemExit(f"{db_path()} already exists: the import is in {tmp}; move it by hand if you mean to replace the database")
        os.replace(tmp, db_path())
        print(f"imported {sum(counts.values())} documents of {len(counts)} collections into {db_path()}. Restart the bridge to use it.")
        return

    if a.cmd == "watch" and not one_bridge(data_dir()):
        # the task watchdog fires every minute; a bridge started by hand already runs: this one stops quietly
        print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} another bridge is running on this PC: not starting", flush=True)
        return
    store = None
    from .store import is_firestore, is_local, open_store

    if not getattr(a, "dry_run", False):
        store = open_store(cfg)
        patient("owner check", store.check_owner)
        print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} database: "
              f"{'the local file' if is_local(store) else 'Firestore' if is_firestore(store) else 'the host bridge at ' + cfg.db_host_url}", flush=True)
    mirror = None
    claude = find_claude(cfg.claude_bin)
    runs = gone = publisher = health = None
    if store is not None and a.cmd == "watch":
        from .push import pusher

        runs = Runs(store, cfg.machine, cfg.roots, claude, data_dir() / "runs", logs=cfg.logs,
                    push=pusher(store, cfg.owner_email))
        from .budget import Budget
        from .usage import claude_usage, default_creds_path

        # step i5: a plan from a session pauses before a page that does not fit in the 5-hour window
        runs.budget = Budget(data_dir() / "budget.json", lambda: claude_usage(default_creds_path()), data_dir() / "runs" / "plans")
        for line in patient("runs left running", runs.forget_lost):
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

            from .config import REPO
            from .health import Health

            health = Health(REPO, data_dir(), cfg.machine, runs)
            # step i6: local search and the daily digest on this PC's Ollama; the index refreshes every 10 min and
            # yesterday's digest is written once, in a thread so a slow model never holds the bridge
            from .localsearch import LocalSearch

            local = LocalSearch(cfg.logs, data_dir() / "search")

            def _local_loop():
                while True:
                    try:
                        for line in local.daily():
                            print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {line}", flush=True)
                    except Exception as e:  # Ollama off or busy: try again next round
                        print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} local search: {e}", flush=True)
                    time.sleep(600)

            threading.Thread(target=_local_loop, daemon=True).start()
            files = Files([*cfg.roots, ("plans", str(plans))], firebase_verifier(cfg.project_id, cfg.owner_email))
            if runs is not None:  # step i4: a folder added on the page is served at once
                runs.on_roots.append(lambda roots: [files.add_root(r) for _, r in roots])
            serve(files,
                  list(cfg.site_origins), cfg.files_port, Texts(cfg.logs, data_dir() / "runs", local), health=health,
                  data=_data_api(store) if is_local(store) else None)
            store.put_many({"meta/files": {"url": cfg.files_url}})
            print(f"file viewer on 127.0.0.1:{cfg.files_port} for {cfg.files_url}", flush=True)
        from .status import Publisher, Status, serve as serve_status

        status = Status(store, cfg.machine, cfg.status_hosts, runs)
        serve_status(status, cfg.status_port)
        publisher = Publisher(store, cfg.machine)
        print(f"avatar status on 127.0.0.1:{cfg.status_port}/status", flush=True)
        feed = gone = None
        if not is_firestore(store):
            # the local database (or its host): the feeds ask it, no Firestore listen; Firestore gets the backup writes
            from .listen import STATUSES, LocalAccountFeeds
            from .localdb import LocalDeletedFeed, command_feed, doc_feed

            feed, gone = command_feed(store, STATUSES), LocalDeletedFeed(store)
            status.feeds = LocalAccountFeeds(store)
            if runs is not None:
                runs.prefs_feed = doc_feed(store, "meta/runs")
            if is_local(store):
                from .mirror import Mirror

                mirror = Mirror(store, Firestore(Session(cfg)))
        else:
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
    next_mirror = 0.0
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
                if health is not None:
                    health.synced()
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
            if mirror is not None and time.time() >= next_mirror:
                next_mirror = time.time() + 60  # the backup: every change, batched each minute (the owner's pick 3a)
                try:
                    line = mirror.step()
                    if line:
                        print(f"{stamp()} {line}", flush=True)
                except (Exception, SystemExit) as e:  # a refused backup never stops the bridge: next minute again
                    print(f"{stamp()} backup waits: {str(e).splitlines()[0][:120]}", flush=True)
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
