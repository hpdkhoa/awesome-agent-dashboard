import http.client
import json
import threading
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
        "machines/PC": {"name": "PC", "seenAt": iso(10)}, "machines/linux": {"name": "linux", "seenAt": iso(1500)},
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
    own = {"status": "done", "runs": 0, "hosts": [{"name": "linux", "host": "10.0.0.2", "ssh": True, "ollama": False}]}
    assert a["bridges"] == [{"name": "PC", "online": True, "seenAgoS": 0, "self": True, "state": own},
                            {"name": "linux", "online": False, "seenAgoS": 1500, "state": None}]
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


def test_background_answer_never_waits_for_firestore():
    """The owner's pick (2026-11-11, p9): "Yes, background refresh". After the first round, a stale answer gives the
    last numbers at once and wakes the thread; the thread reads, the next answer has the new numbers."""
    import time as _t

    st, now = make()
    st.start()
    assert st.answer()["inbox"] == 1  # the first answer waits for one round
    n = st.store.calls
    gate = threading.Event()
    real = st.store.query

    def slow(*a, **k):
        gate.wait(5)
        return real(*a, **k)

    st.store.query = slow
    st.store.docs["inbox/q2"] = {"status": "open"}
    now[0] += DATA_SECONDS
    t0 = _t.perf_counter()
    a = st.answer()
    assert _t.perf_counter() - t0 < 0.5 and a["inbox"] == 1  # old numbers, no wait
    gate.set()
    for _ in range(50):
        if st.data_at == now[0]:
            break
        _t.sleep(0.05)
    assert st.store.calls > n and st.answer()["inbox"] == 2


def test_background_reads_nothing_when_nobody_asks():
    from agent_bridge.status import ASKED_SECONDS

    st, now = make()
    st.answer()
    n = st.store.calls
    now[0] += ASKED_SECONDS + 1  # stale, but nobody asked since
    st.tick(now[0])
    assert st.store.calls == n
    st.asked_at = now[0]  # asked again: the next turn reads
    st.tick(now[0])
    assert st.store.calls > n


# p10 (the owner's picks, 2026-11-11: "C: bridges publish, avatar listens", Firestore "Optimized")

class Feeds:
    """listen.AccountFeeds as the listens would hold it."""

    def __init__(self, data=None):
        self.data = data
        self.commands = type("C", (), {"current": lambda _s: [{"machine": "PC", "status": "running"}]})()

    def read(self, now):
        return None if self.data is None else dict(self.data)


def test_counts_come_from_the_listens_without_reads():
    d = {"going": 3, "sessions": 2, "inbox": 4, "plan": None,
         "machines": [{"name": "linux", "seenAt": iso(400), "avatar": {"status": "done", "runs": 0, "hosts": []}}]}
    st, now = make()
    st.feeds = Feeds(d)
    a = st.answer()
    assert st.store.calls == 0  # no Firestore query: the listens hold the counts
    assert (a["runs"], a["sessions"], a["inbox"]) == (3, 2, 4)
    linux = [b for b in a["bridges"] if b["name"] == "linux"][0]
    assert linux["online"] and linux["state"]["status"] == "done"  # 400 s: inside the 420 s keepalive bar
    assert a["bridges"][0]["state"]["runs"] == 1  # this machine's own command, from the commands listen


def test_listens_still_opening_ask_firestore_once():
    st, now = make()
    st.feeds = Feeds(None)
    assert st.answer()["inbox"] == 1 and st.store.calls > 0


def test_publisher_writes_on_change_and_keepalive_only():
    from agent_bridge.status import KEEPALIVE_SECONDS, Publisher

    s = Store({"machines/PC": {"name": "PC"}})
    now = [NOW]
    pub = Publisher(s, "PC", clock=lambda: now[0])
    st = {"status": "done", "runs": 0, "hosts": []}
    assert pub.publish(st) and s.docs["machines/PC"]["avatar"] == st
    now[0] += 60
    assert not pub.publish(st)  # same state, a minute later: no write
    assert pub.publish({**st, "status": "in progress", "runs": 1})  # changed: write
    now[0] += KEEPALIVE_SECONDS
    assert pub.publish({**st, "status": "in progress", "runs": 1})  # same, but 5 min: the keepalive
    assert pub.publish({**st, "status": "in progress", "runs": 1}, force=True)  # sync replaced the record
    assert pub.writes == 4
    assert not Publisher(s, "gone").publish(st)  # a deleted machine record stays deleted


def test_account_feeds_read_counts_and_plan():
    from agent_bridge import listen

    class F:
        def __init__(self, rows):
            self.rows = rows

        def current(self):
            return self.rows

        def close(self):
            pass

    af = listen.AccountFeeds.__new__(listen.AccountFeeds)
    af.wall = lambda: NOW
    af.commands, af.inbox = F([{"status": "running"}]), F([{"status": "open"}, {"status": "open"}])
    af.live = None  # no listen on beats (2026-11-12): open sessions come from the process scan
    af.live_count = lambda: 1
    af.machines = F([{"name": "PC"}])
    af.plans = F([{"id": "old", "status": "closed", "updatedAt": iso(5)},
                  {"id": "av", "title": "Avatar", "phase": "build", "updatedAt": iso(60), "current": 5}])
    af.plan_key = ("av", 5)
    af.version = F([{"parts": {"steps": [{"id": "p1"}, {"id": "p2"}]}}])
    af.steps = F([{"stepId": "p1", "state": "done"}])
    d = af.read(NOW)
    assert (d["going"], d["sessions"], d["inbox"]) == (1, 1, 2)
    assert (d["plan"]["id"], d["plan"]["stepsDone"], d["plan"]["stepsAll"]) == ("av", 1, 2)
    af.inbox = F(None)  # a listen reopening
    assert af.read(NOW) is None


def test_publish_state_carries_the_account_counts():
    """p11: an avatar with no bridge of its own reads everything from the machines records."""
    st, now = make()
    assert "account" not in st.publish_state()  # no listens yet: own state only
    st.feeds = Feeds({"going": 1, "sessions": 2, "inbox": 3, "plan": {"id": "av"}, "machines": []})
    p = st.publish_state()
    assert p["account"] == {"going": 1, "sessions": 2, "inbox": 3, "plan": {"id": "av"}} and p["runs"] == 1
    assert "at" not in p and "seenAt" not in p  # no clock in it: it changes only when a value does


def test_the_counter_keeps_reads_writes_and_bytes_per_source(tmp_path):
    # p14 F4/F5 (owner pick 2026-11-12: "Count reads by collection and cut the ones that repeat")
    from agent_bridge.usage import Counter
    c = Counter(tmp_path / "u.json")
    c.add("reads", 3, "listen:liveSessions", 120)
    c.add("reads", 1, "listen:liveSessions", 40)
    c.add("writes", 1, "rest:machines", 900)
    c.add("reads", 2)
    d = c.today()
    assert d["reads"] == 6 and d["writes"] == 1
    assert d["by"]["listen:liveSessions"] == {"reads": 4, "bytes": 160}
    assert d["by"]["rest:machines"] == {"writes": 1, "bytes": 900}


def test_rest_calls_name_their_collection():
    from agent_bridge.firestore import _collection
    assert _collection("https://x/documents/machines/PC?updateMask.fieldPaths=a", {"fields": {}}) == "machines"
    assert _collection("https://x/documents:runQuery", {"structuredQuery": {"from": [{"collectionId": "commands"}]}}) == "commands"
    assert _collection("https://x/documents:commit", {"writes": [{"update": {"name": "projects/p/databases/(default)/documents/sessions/a"}},
                                                               {"delete": "projects/p/databases/(default)/documents/runs/b"}]}) == "runs+sessions"


def test_rest_calls_keep_one_connection_and_reopen_a_dropped_one(monkeypatch):
    # p14 F5: one kept-open HTTPS connection per thread instead of a new TLS handshake per call
    import http.client
    from agent_bridge import firestore as fsm

    made, sent = [], []

    class Conn:
        def __init__(self, host, timeout=60):
            made.append(host)
            self.fail = len(made) == 1 and len(sent) == 1

        def request(self, method, path, body=None, headers=None):
            sent.append((method, path))
            if getattr(self, "drop", False):
                raise http.client.RemoteDisconnected("closed")

        def getresponse(self):
            class R:
                status = 200
                def read(self): return b'{"fields": {}}'
            return R()

        def close(self): pass

    monkeypatch.setattr(fsm.http.client, "HTTPSConnection", Conn)

    class S:
        cfg = type("C", (), {"project_id": "p"})
        def token(self): return "t"

    store = fsm.Firestore(S())
    store.get("meta/a"); store.get("meta/b")
    assert len(made) == 1 and sent == [("GET", "/v1/projects/p/databases/(default)/documents/meta/a"),
                                       ("GET", "/v1/projects/p/databases/(default)/documents/meta/b")]
    store._local.conn.drop = True  # the server closed the idle connection
    assert store.get("meta/c") == {} and len(made) == 2
