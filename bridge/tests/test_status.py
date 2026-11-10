import http.client
import json
from datetime import datetime, timezone

import pytest

from agent_bridge.status import DATA_SECONDS, Status, heartbeat, serve

NOW = datetime(2026, 11, 10, 12, 0, 0, tzinfo=timezone.utc).timestamp()


def iso(sec_ago):
    return datetime.fromtimestamp(NOW - sec_ago, timezone.utc).isoformat(timespec="seconds")


class Store:
    """The read calls status.py makes, in memory, counting queries."""

    def __init__(self, docs):
        self.docs, self.calls = docs, 0

    def _col(self, c):
        return [d for p, d in self.docs.items() if p.startswith(c + "/")]

    def get(self, path):
        self.calls += 1
        return self.docs.get(path)

    def where(self, c, f, v):
        self.calls += 1
        return [d for d in self._col(c) if d.get(f) == v]

    def update(self, path, fields):
        if path not in self.docs:
            return False
        self.docs[path].update(fields)
        return True

    def query(self, c, field="", op="EQUAL", value=None, order="", limit=0):
        self.calls += 1
        rows = self._col(c)
        if op == "IN":
            rows = [d for d in rows if d.get(field) in value]
        elif op == "GREATER_THAN_OR_EQUAL":
            rows = [d for d in rows if (d.get(field) or "") >= value]
        if order:
            rows.sort(key=lambda d: d.get(order) or "", reverse=True)
        return rows[:limit] if limit else rows


def world():
    return {
        "commands/a": {"status": "running"}, "commands/b": {"status": "done"}, "commands/c": {"status": "waiting"},
        "liveSessions/s1": {"beatAt": iso(30)}, "liveSessions/s2": {"beatAt": iso(600)},
        "inbox/q1": {"status": "open"}, "inbox/q2": {"status": "delivered"},
        "machines/PC": {"name": "PC", "seenAt": iso(10)}, "machines/linux": {"name": "linux", "seenAt": iso(900)},
        "plans/old": {"id": "old", "title": "Old", "status": "closed", "updatedAt": iso(5), "current": 1},
        "plans/av": {"id": "av", "title": "Avatar", "status": "open", "phase": "build", "updatedAt": iso(60), "current": 5},
        "planVersions/av_v5": {"parts": {"steps": [{"id": "p1"}, {"id": "p2"}, {"id": "p3"}, {"id": "p4"}]}},
        "planSteps/av_p1": {"planId": "av", "stepId": "p1", "state": "done"},
        "planSteps/av_p2": {"planId": "av", "stepId": "p2", "state": "now"},
    }


def make(docs=None, probe=lambda h, p: p == 22, runs=None):
    now = [NOW]
    st = Status(Store(docs if docs is not None else world()), "PC", [("linux", "10.0.0.2")], runs,
                clock=lambda: now[0], probe=probe)
    return st, now


def test_counts_plan_bridges_and_hosts():
    a = make()[0].answer()
    assert a["status"] == "in progress" and a["runs"] == 2
    assert a["sessions"] == 1 and a["inbox"] == 1
    assert a["bridges"] == [{"name": "PC", "online": True, "seenAgoS": 0, "self": True},
                            {"name": "linux", "online": False, "seenAgoS": 900}]
    assert a["hosts"] == [{"name": "linux", "host": "10.0.0.2", "ssh": True, "ollama": False}]
    p = a["plan"]
    assert (p["title"], p["phase"], p["stepsDone"], p["stepsAll"]) == ("Avatar", "build", 1, 4)
    assert [s["state"] for s in p["steps"]] == ["done", "now", "next", "next"]


def test_done_when_nothing_goes():
    docs = world()
    docs["commands/a"]["status"] = docs["commands/c"]["status"] = "done"
    assert make(docs)[0].answer()["status"] == "done"


def test_own_running_process_counts_before_firestore_knows():
    class P:
        def poll(self):
            return None

    class Runs:
        procs = {"x": P()}

    docs = {k: v for k, v in world().items() if not k.startswith("commands/")}
    assert make(docs, runs=Runs())[0].answer()["status"] == "in progress"


def test_firestore_read_once_a_minute():
    st, now = make()
    st.answer()
    n = st.store.calls
    now[0] += DATA_SECONDS - 1
    st.answer()
    assert st.store.calls == n
    now[0] += 1
    st.answer()
    assert st.store.calls == 2 * n


def test_firestore_failure_keeps_last_counts():
    st, now = make()
    assert st.answer()["inbox"] == 1

    def boom(*a, **k):
        raise SystemExit("Firestore refused (503)")

    st.store.query = boom
    now[0] += DATA_SECONDS
    a = st.answer()
    assert a["inbox"] == 1 and "503" in a["error"]


def test_heartbeat_needs_the_machine_doc():
    s = Store({"machines/PC": {"name": "PC"}})
    assert heartbeat(s, "PC") and "seenAt" in s.docs["machines/PC"]
    assert not heartbeat(s, "other")


@pytest.fixture
def srv():
    st, _ = make()
    server = serve(st, 0)
    yield server.server_address[1]
    server.shutdown()


def call(port, method="GET", path="/status", host=None):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    c.request(method, path, headers={"Host": host or f"127.0.0.1:{port}"})
    r = c.getresponse()
    return r.status, dict(r.getheaders()), r.read()


def test_http_answers_locally_read_only(srv):
    code, headers, body = call(srv)
    assert code == 200 and json.loads(body)["status"] == "in progress"
    assert "Access-Control-Allow-Origin" not in headers and headers["Cache-Control"] == "no-store"
    assert call(srv, host=f"localhost:{srv}")[0] == 200
    assert call(srv, host="evil.example.com")[0] == 403  # DNS rebinding
    assert call(srv, path="/other")[0] == 404
    assert call(srv, method="POST")[0] == 405
