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

Firestore is read at most once a minute and only while the avatar asks (about 14 reads a round), so an avatar left on
all day costs about 20,000 reads; the counts carry their own time (dataAt).
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
    def __init__(self, store, machine: str, hosts=(), runs=None, clock=time.time, probe=port_open):
        self.store, self.machine, self.hosts, self.runs = store, machine, list(hosts), runs
        self.clock, self.probe = clock, probe
        self.lock = threading.Lock()
        self.data: dict = {}
        self.data_at = 0.0
        self.error = ""
        self.host_state: list[dict] = []
        self.host_at = 0.0

    def own_runs(self) -> int:
        procs = getattr(self.runs, "procs", None) or {}
        return sum(1 for p in list(procs.values()) if p.poll() is None)

    def _read(self, now: float) -> dict:
        s = self.store
        going = s.query("commands", "status", "IN", GOING)
        cutoff = _iso(now - LIVE_SECONDS)
        live = s.query("liveSessions", "beatAt", "GREATER_THAN_OR_EQUAL", cutoff)
        waiting = s.where("inbox", "status", "open")
        bridges = []
        for m in s.query("machines"):
            age = _age(m.get("seenAt"), now)
            bridges.append({"name": m.get("name", ""), "online": age is not None and age < LIVE_SECONDS,
                            "seenAgoS": None if age is None else int(age)})
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

    def answer(self) -> dict:
        now = self.clock()
        with self.lock:
            if now - self.data_at >= DATA_SECONDS:
                try:
                    self.data, self.error = self._read(now), ""
                except (Exception, SystemExit) as e:  # keep the last counts, say they are old
                    self.error = str(e)[:200]
                self.data_at = now
            if self.hosts and now - self.host_at >= HOST_SECONDS:
                self.host_state, self.host_at = self._hosts(), now
            d = dict(self.data)
        own = self.own_runs()
        going = max(own, d.get("going", 0))
        bridges = [b for b in d.get("bridges", []) if b["name"] != self.machine]
        bridges.insert(0, {"name": self.machine, "online": True, "seenAgoS": 0, "self": True})
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
    srv = ThreadingHTTPServer(("127.0.0.1", port), handler(status, port))
    srv.daemon_threads = True
    if not port:  # a test's free port: the Host check needs the real one
        srv.RequestHandlerClass = handler(status, srv.server_address[1])
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def heartbeat(store, machine: str) -> bool:
    """machines/<this machine>.seenAt, once a sync round, so other bridges' avatars see this one online."""
    return store.update(f"machines/{machine}", {"seenAt": datetime.now(timezone.utc).isoformat(timespec="seconds")})
