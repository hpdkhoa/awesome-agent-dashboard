"""The command listener: no queries while it holds an answer, reopen before the token expires or after a drop,
and a lagging snapshot never starts the same command twice."""

from agent_bridge.listen import REOPEN_SECONDS, CommandFeed
from test_runs import cmd, setup


class FakeDoc:
    def __init__(self, data):
        self.id, self._d = data["id"], data

    def to_dict(self):
        return dict(self._d)


class FakeWatch:
    def __init__(self):
        self._closed = False

    def unsubscribe(self):
        self._closed = True


class FakeClient:
    """Answers each listen at once with the rows it holds, like Firestore's first snapshot."""

    def __init__(self, rows):
        self.rows, self.listens, self.watches = rows, 0, []

    def collection(self, name):
        assert name == "commands"
        return self

    def where(self, filter):
        assert filter.field_path == "status" and filter.op_string == "in"
        return self

    def on_snapshot(self, cb):
        self.listens += 1
        cb([FakeDoc(r) for r in self.rows], [], None)
        w = FakeWatch()
        self.watches.append(w)
        return w


def test_holds_the_commands_without_asking_again():
    client = FakeClient([{"id": "c1", "status": "new"}])
    t = [0.0]
    feed = CommandFeed(client, clock=lambda: t[0])
    assert feed.current() == [{"id": "c1", "status": "new"}]
    for _ in range(100):
        t[0] += 5
        feed.current()
    assert client.listens == 1


def test_reopens_before_the_token_expires_and_after_a_drop():
    client = FakeClient([])
    t = [0.0]
    feed = CommandFeed(client, clock=lambda: t[0])
    feed.current()
    t[0] = REOPEN_SECONDS + 1
    feed.current()
    assert client.listens == 2 and client.watches[0]._closed
    client.watches[-1]._closed = True  # the stream dropped
    feed.current()
    assert client.listens == 3


def test_a_lagging_snapshot_never_starts_a_command_twice(tmp_path, monkeypatch):
    store, runs, work = setup(tmp_path, monkeypatch)
    cmd(store, "c1", action="start", folder=str(work), prompt="hi")
    stale = [dict(store.get("commands/c1"))]  # the listener still shows "new" after our own write
    runs.step(stale)
    assert store.get("commands/c1")["status"] == "running"
    runs.step(stale)
    assert len(runs.procs) == 1


def test_step_with_the_listener_answer_makes_no_query(tmp_path, monkeypatch):
    store, runs, work = setup(tmp_path, monkeypatch)
    asked = []
    monkeypatch.setattr(store, "where", lambda *a: asked.append(a) or [])
    runs.step([])
    assert asked == []
    runs.step(None)
    assert len(asked) == 2
