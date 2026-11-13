"""The desktop avatar's status: GET /status on 127.0.0.1 only (plan b73e97ad, the owner's choice 2026-11-10: "Local
bridge /status"; the avatar shows OFFLINE when this does not answer).

Its own port (STATUS_PORT, 8794), never the file viewer's: the owner's Cloudflare Tunnel routes the file viewer's port
to the internet, and this answer has no sign-in. Read only: no command, no write, no path from the request is used.
A Host header other than 127.0.0.1 or localhost is refused (a web page cannot reach it by DNS rebinding), and there is
no CORS header (a web page cannot read it); the avatar asks from its Rust side.

What it answers (the owner's picks: "Core 3 + PC load", note "add the steps progress and the Linux box connection";
Linux box "SSH + Ollama reachable", note "include with option (c)"):

- status: "in progress" while a run is going (this bridge's own runs, or commands new/running/waiting/stopping on any
  machine), else "done". OFFLINE is the avatar's own reading of no answer.
- bridges: each machine's bridge, online when its heartbeat (machines/<name>.seenAt, written by watch every sync
  round) is under 180 s old.
- hosts: each STATUS_HOSTS entry (linux=192.168.1.222): ssh port 22 and Ollama port 11434 open from this PC.
- sessions: sessions open now (liveSessions heartbeat under 180 s); runs: runs going.
- inbox: questions waiting for the owner (inbox status open).
- plan: the newest open plan, its phase, and its steps done of all.
CPU, RAM and GPU are read by the avatar itself.

Firestore is read at most once a minute and only while the avatar asks (20 reads a round, measured 2026-11-11 in plan
b73e97ad p9), so an avatar left on all day costs about 28,800 reads; the counts carry their own time (dataAt).

Background refresh (the owner's pick, 2026-11-11, p9: "Yes, background refresh"): once served, a background thread does
the Firestore round and the port checks, and /status answers the last numbers at once. A request only wakes the thread
when the numbers are stale; the thread reads nothing when nobody asked in the last ASKED_SECONDS. The very first answer
after the bridge starts still waits for one round, so it never shows empty counts.
"""

from __future__ import annotations

import json
import socket
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LIVE_SECONDS = 180  # the same bar as a session's heartbeat (inbox.LIVE_SECONDS)
DATA_SECONDS = 60  # Firestore at most once a minute
HOST_SECONDS = 30  # port checks at most every 30 s
PORT_TIMEOUT = 1.0
ASKED_SECONDS = 120
# p10 (the owner's picks, 2026-11-11: "C: bridges publish, avatar listens"; Firestore "Optimized": written only on a
# change, plus a 5 min still-alive write): each bridge writes its own state into machines/<name> on a change and at least
# every KEEPALIVE_SECONDS; a bridge counts as online while that is under MACHINE_LIVE_SECONDS old (keepalive + 2 rounds).
# 5 minutes again (2026-11-13): the avatar counts a bridge online while its record is under 420 s old (avatar
# ui/app.js MACHINE_LIVE_S), so the 15-minute keepalive of 2026-11-12 showed every other bridge offline. That cut was
# for the page's Firestore reads; the page reads the local database now, so the record costs writes only.
KEEPALIVE_SECONDS = 300
MACHINE_LIVE_SECONDS = 420  # keepalive + 2 rounds; the background thread refreshes only while /status was asked this recently
GOING = ["new", "running", "waiting", "stopping"]  # chain.GOING
HOST_PORTS = (("ssh", 22), ("ollama", 11434))


def _iso(t: float) -> str:
    return datetime.fromtimestamp(t, timezone.utc).isoformat(timespec="seconds")


def _age(iso: str | None, now: float) -> float | None:
    try:
        return now - datetime.fromisoformat(iso).timestamp() if iso else None
    except ValueError:
        return None


def port_open(host: str, port: int, timeout: float = PORT_TIMEOUT) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


class Status:
    def __init__(self, store, machine: str, hosts=(), runs=None, clock=time.time, probe=port_open, feeds=None):
        self.store, self.machine, self.hosts, self.runs = store, machine, list(hosts), runs
        self.feeds = feeds  # listen.AccountFeeds: the counts from listens (p10); None = ask Firestore (the old way)
        self.clock, self.probe = clock, probe
        self.lock = threading.Lock()
        self.data: dict = {}
        self.data_at = 0.0
        self.error = ""
        self.host_state: list[dict] = []
        self.host_at = 0.0
        self.asked_at = 0.0
        self.kick = threading.Event()
        self.busy = threading.Lock()
        self.worker: threading.Thread | None = None  # set by start(); without it answer() refreshes inline (tests)

    def own_runs(self) -> int:
        procs = getattr(self.runs, "procs", None) or {}
        return sum(1 for p in list(procs.values()) if p.poll() is None)

    @staticmethod
    def _bridges(machines: list[dict], now: float) -> list[dict]:
        """Each machine's bridge: online while its record is under MACHINE_LIVE_SECONDS old, with the state it
        published (status, runs, hosts; p10)."""
        out = []
        for m in machines:
            age = _age(m.get("seenAt"), now)
            out.append({"name": m.get("name", ""), "online": age is not None and age < MACHINE_LIVE_SECONDS,
                        "seenAgoS": None if age is None else int(age), "state": m.get("avatar")})
        return out

    def _listened(self, now: float) -> dict | None:
        """The counts from the listens, or None while they open (or without them)."""
        if self.feeds is None:
            return None
        try:
            d = self.feeds.read(now)
        except Exception as e:  # a broken listen: ask Firestore the old way, say why
            self.error = str(e)[:200]
            return None
        if d is None:
            return None
        machines = d.pop("machines")
        return {**d, "bridges": self._bridges(machines, now)}

    def own_state(self) -> dict:
        """What this bridge publishes (p10): in progress while it runs a claude or a command for this machine goes."""
        mine = 0
        if self.feeds is not None:
            rows = self.feeds.commands.current() or []
            mine = sum(1 for c in rows if c.get("machine") == self.machine)
        runs = max(self.own_runs(), mine)
        with self.lock:
            hosts = list(self.host_state)
        return {"status": "in progress" if runs else "done", "runs": runs, "hosts": hosts}

    def publish_state(self) -> dict:
        """p11: what goes into machines/<this machine>: this bridge's own state, plus the account's counts (commands
        going, sessions open, inbox questions, the plan and its steps) from the listens, so an avatar with no bridge
        of its own (the owner's Mac) listens to the machines records only (the owner's pick "C: bridges publish,
        avatar listens": one record per bridge, nothing else). No time in it, so it changes only when a value does."""
        st = self.own_state()
        d = self._listened(self.clock())
        if d is not None:
            st["account"] = {"going": d["going"], "sessions": d["sessions"], "inbox": d["inbox"], "plan": d["plan"]}
        return st

    def _read(self, now: float) -> dict:
        s = self.store
        going = s.query("commands", "status", "IN", GOING)
        cutoff = _iso(now - LIVE_SECONDS)
        live = s.query("liveSessions", "beatAt", "GREATER_THAN_OR_EQUAL", cutoff)
        waiting = s.where("inbox", "status", "open")
        bridges = self._bridges(s.query("machines"), now)
        plan = next((p for p in s.query("plans", order="updatedAt", limit=5) if p.get("status", "open") == "open"), None)
        plan_out = None
        if plan:
            v = s.get(f"planVersions/{plan['id']}_v{plan.get('current', 0)}") or {}
            steps = [st.get("id") for st in ((v.get("parts") or {}).get("steps") or [])]
            states = {d.get("stepId"): d.get("state") for d in s.where("planSteps", "planId", plan["id"])}
            plan_out = {"id": plan["id"], "title": plan.get("title", ""), "phase": plan.get("phase", ""),
                        "stepsDone": sum(1 for i in steps if states.get(i) == "done"), "stepsAll": len(steps),
                        "steps": [{"id": i, "state": states.get(i) or "next"} for i in steps]}
        return {"going": len(going), "sessions": len(live), "inbox": len(waiting), "bridges": bridges,
                "plan": plan_out}

    def _hosts(self) -> list[dict]:
        return [{"name": n, "host": h, **{k: self.probe(h, port) for k, port in HOST_PORTS}} for n, h in self.hosts]

    def stale(self, now: float) -> bool:
        return now - self.data_at >= DATA_SECONDS or bool(self.hosts) and now - self.host_at >= HOST_SECONDS

    def refresh(self, now: float) -> None:
        """The slow part: the Firestore round (at most once a minute) and the port checks (at most every 30 s). Runs
        outside the lock, so an answer never waits for it; only the swap of the new numbers takes the lock. One round
        at a time (busy), so two first answers never read twice."""
        with self.busy:
            self._refresh(now)

    def _refresh(self, now: float) -> None:
        if now - self.data_at >= DATA_SECONDS:
            try:
                data, error = self._read(now), ""
            except (Exception, SystemExit) as e:  # keep the last counts, say they are old
                data, error = None, str(e)[:200]
            with self.lock:
                if data is not None:
                    self.data = data
                self.error, self.data_at = error, now
        if self.hosts and now - self.host_at >= HOST_SECONDS:
            hs = self._hosts()
            with self.lock:
                self.host_state, self.host_at = hs, now

    def _run(self) -> None:
        while True:
            self.kick.wait(HOST_SECONDS)
            self.kick.clear()
            try:
                self.tick(self.clock())
            except Exception:  # never let the thread die; the next round tries again
                pass

    def tick(self, now: float) -> None:
        """One turn of the thread. The port checks run always (no Firestore; the bridge publishes them, p10). Firestore
        is asked only when the listens are not there and someone asked in the last ASKED_SECONDS."""
        if self.hosts and now - self.host_at >= HOST_SECONDS:
            hs = self._hosts()
            with self.lock:
                self.host_state, self.host_at = hs, now
        if now - self.asked_at < ASKED_SECONDS and self.stale(now) and self._listened(now) is None:
            self.refresh(now)

    def start(self) -> None:
        if self.worker is None:
            self.worker = threading.Thread(target=self._run, daemon=True, name="status-refresh")
            self.worker.start()

    def answer(self) -> dict:
        now = self.clock()
        self.asked_at = now
        listened = self._listened(now)
        if listened is not None:  # p10: the listens hold the counts as of the last change; no Firestore read here
            with self.lock:
                self.data, self.data_at, self.error = listened, now, ""
            if self.worker is None and self.hosts and now - self.host_at >= HOST_SECONDS:
                self.host_state, self.host_at = self._hosts(), now
        elif self.worker is None or not self.data_at:
            self.refresh(now)  # tests, and the first answer after the bridge starts
        elif self.stale(now):
            self.kick.set()  # the thread refreshes; this answer gives the last numbers at once
        with self.lock:
            d = dict(self.data)
        own = self.own_runs()
        going = max(own, d.get("going", 0))
        bridges = [b for b in d.get("bridges", []) if b["name"] != self.machine]
        bridges.insert(0, {"name": self.machine, "online": True, "seenAgoS": 0, "self": True, "state": self.own_state()})
        return {"status": "in progress" if going else "done", "at": _iso(now), "dataAt": _iso(self.data_at),
                "error": self.error or None, "runs": going, "sessions": d.get("sessions", 0),
                "inbox": d.get("inbox", 0), "bridges": bridges, "hosts": self.host_state, "plan": d.get("plan")}


def handler(status: Status, port: int):
    allowed = {f"127.0.0.1:{port}", f"localhost:{port}"}

    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def _json(self, code: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.headers.get("Host", "") not in allowed:
                return self._json(403, {"error": "local only"})
            if self.path.split("?", 1)[0] != "/status":
                return self._json(404, {"error": "not found"})
            self._json(200, status.answer())

        def _refuse(self):
            self._json(405, {"error": "read only"})

        do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = _refuse

    return H


def serve(status: Status, port: int) -> ThreadingHTTPServer:
    status.start()
    srv = ThreadingHTTPServer(("127.0.0.1", port), handler(status, port))
    srv.daemon_threads = True
    if not port:  # a test's free port: the Host check needs the real one
        srv.RequestHandlerClass = handler(status, srv.server_address[1])
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


class Publisher:
    """Writes this bridge's state into machines/<machine> (plan b73e97ad p10; the owner's picks "C: bridges publish,
    avatar listens" and Firestore "Optimized"): only when the state changed, at least every KEEPALIVE_SECONDS so other
    avatars see it online, and at once after sync replaced the record (force). One update: the fields seenAt, avatar."""

    def __init__(self, store, machine: str, clock=time.time, also=None):
        self.store, self.machine, self.clock = store, machine, clock
        # also: Firestore, when `store` is the local database: an avatar on another machine listens to the machines
        # records there, so this one goes at once, not with the minute's backup
        self.also = also
        self.last: str | None = None
        self.at = 0.0
        self.writes = 0

    def publish(self, state: dict, force: bool = False) -> bool:
        now = self.clock()
        key = json.dumps(state, sort_keys=True)
        if not force and key == self.last and now - self.at < KEEPALIVE_SECONDS:
            return False
        fields = {"seenAt": _iso(now), "avatar": state}
        if self.store.update(f"machines/{self.machine}", fields):
            if self.also is not None:
                try:
                    if not self.also.update(f"machines/{self.machine}", fields):
                        self.also.put_many({f"machines/{self.machine}": {"name": self.machine, **fields}})
                except (Exception, SystemExit):
                    pass  # the minute's backup carries it
            self.last, self.at = key, now
            self.writes += 1
            return True
        return False


def heartbeat(store, machine: str) -> bool:
    """machines/<this machine>.seenAt, once a sync round, so other bridges' avatars see this one online."""
    return store.update(f"machines/{machine}", {"seenAt": datetime.now(timezone.utc).isoformat(timespec="seconds")})
