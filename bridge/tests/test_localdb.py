import json

import pytest

from agent_bridge.dataapi import DataApi
from agent_bridge.files import Files, serve
from agent_bridge.localdb import LocalDeletedFeed, LocalStore, RemoteStore, command_feed
from agent_bridge.mirror import Mirror
from test_files import call, verify
from test_inbox import FakeStore


def store_at(tmp_path):
    return LocalStore(tmp_path / "data.sqlite")


def test_the_firestore_calls_work_on_the_local_file(tmp_path):
    s = store_at(tmp_path)
    assert s.get("commands/a") is None and s.update("commands/a", {"x": 1}) is False  # a missing document is not made
    s.put_many({"commands/a": {"id": "a", "status": "new", "createdAt": "2"}, "commands/b": {"id": "b", "status": "done", "createdAt": "1"},
                "commands/c": {"id": "c", "status": "waiting"}})
    assert s.update("commands/a", {"status": "running", "pid": 5}) and s.get("commands/a") == {"id": "a", "status": "running", "createdAt": "2", "pid": 5}
    assert [d["id"] for d in s.where("commands", "status", "done")] == ["b"]
    assert {d["id"] for d in s.query("commands", "status", "IN", ["running", "waiting"])} == {"a", "c"}
    assert [d["id"] for d in s.query("commands", order="createdAt")] == ["a", "b"]  # newest first; c has no createdAt: left out
    assert [d["id"] for d in s.query("commands", "createdAt", "GREATER_THAN_OR_EQUAL", "2")] == ["a"]
    assert [d["id"] for d in s.find("commands", None, "createdAt", True, 1)] == ["a"]
    assert [d["id"] for d in s.find("commands", None, "createdAt", True, 10, after=["2", "a"])] == ["b"]  # the page after a cursor
    s.merge("planHarness/p", {"items": {"h1": {"ok": True}}})
    s.merge("planHarness/p", {"items": {"h2": {"ok": False}}})
    assert s.get("planHarness/p") == {"items": {"h1": {"ok": True}, "h2": {"ok": False}}}  # maps merge deep
    s.delete("commands/b")
    assert s.get("commands/b") is None and s.count("commands") == 2
    again = store_at(tmp_path)  # another process opens the same file
    assert again.get("commands/a")["pid"] == 5


def test_changes_feed_and_local_feeds(tmp_path):
    s = store_at(tmp_path)
    feed, gone = command_feed(s, ["new", "waiting"]), LocalDeletedFeed(s)
    assert feed.current() == [] and gone.paths() == set()
    s.put_many({"commands/a": {"status": "new"}, "meta/deleted": {"paths": {"sessions/x": "d"}}})
    assert feed.current() == [{"status": "new", "id": "a"}] and gone.paths() == {"sessions/x"}
    seq = s.seq()
    s.update("commands/a", {"status": "running"})
    s.delete("meta/deleted")
    last, changed = s.changes(seq)
    assert last == seq + 2 and {(c["path"], c["op"]) for c in changed} == {("commands/a", "set"), ("meta/deleted", "delete")}
    assert feed.current() == []


def test_mirror_writes_changes_to_firestore_and_never_reads(tmp_path):
    s, fs = store_at(tmp_path), FakeStore()
    fs.get = fs.where = lambda *a, **k: (_ for _ in ()).throw(AssertionError("the backup must not read Firestore"))
    m = Mirror(s, fs)
    assert m.step() is None
    s.put_many({"plans/p": {"id": "p", "title": "t"}, "liveSessions/s": {"beatAt": "x"}, "commands/c": {"id": "c"}})
    s.update("plans/p", {"title": "t2"})
    s.delete("commands/c")
    assert m.step() == "backup: 1 written, 1 deleted on Firestore"
    assert fs.docs == {"plans/p": {"id": "p", "title": "t2"}}  # the last content once; heartbeats never
    assert m.step() is None

    class Refusing(FakeStore):
        def put_many(self, docs):
            raise SystemExit("Firestore refused (429): quota")

    m2 = Mirror(s, Refusing())
    s.put_many({"plans/q": {"id": "q"}})
    with pytest.raises(SystemExit):
        m2.step()
    assert Mirror(s, fs).step() == "backup: 1 written, 0 deleted on Firestore"  # a refused round goes again


def test_data_api_and_remote_store(tmp_path):
    s = store_at(tmp_path)
    api = DataApi(s, sleep=lambda x: None)
    assert api.answer({"op": "set", "path": "inbox/q1", "data": {"id": "q1", "status": "open", "createdAt": "1"}}) == {"ok": True}
    assert api.answer({"op": "update", "path": "inbox/q1", "fields": {"status": "answered"}}) == {"ok": True}
    assert api.answer({"op": "update", "path": "inbox/nope", "fields": {"x": 1}}) == {"ok": False}
    found = api.answer({"op": "find", "coll": "inbox", "filters": [["status", "in", ["answered"]]], "order": "createdAt", "limit": 10})
    assert found == {"docs": [{"id": "q1", "data": {"id": "q1", "status": "answered", "createdAt": "1"}}]}
    seq = api.answer({"op": "seq"})["seq"]
    api.answer({"op": "batch", "writes": [{"op": "set", "path": "inbox/q2", "data": {"id": "q2"}}, {"op": "delete", "path": "inbox/q1"}]})
    ch = api.answer({"op": "changes", "since": seq, "wait": 0})
    assert ch["seq"] == seq + 2 and len(ch["changes"]) == 2
    assert api.answer({"op": "changes", "since": ch["seq"], "wait": 0})["changes"] == []
    assert api.answer({"op": "many", "calls": [{"op": "count", "coll": "inbox"}, {"op": "get", "path": "inbox/q2"}]}) == {
        "results": [{"count": 1}, {"doc": {"id": "q2"}}]}
    for bad in ({"op": "get", "path": "a/b/c"}, {"op": "find", "coll": ""}, {"op": "x"}):
        with pytest.raises(ValueError):
            api.answer(bad)
    # over HTTP, owner only; another machine's bridge uses the same calls through RemoteStore
    srv = serve(Files([("work", str(tmp_path))], verify), ["https://agent.example.com"], 0, data=api)
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    try:
        assert call(base, "/data", {"op": "count", "coll": "inbox"}, token="guest")[0] == 401
        status, _, body = call(base, "/data", {"op": "count", "coll": "inbox"})
        assert status == 200 and json.loads(body) == {"count": 1}
        assert call(base, "/data", {"op": "x"})[0] == 400

        class Sess:
            def token(self):
                return "owner"

        r = RemoteStore(base, Sess())
        r.check_owner()
        r.put_many({"commands/r1": {"id": "r1", "status": "new"}})
        assert r.update("commands/r1", {"status": "running"}) and not r.update("commands/none", {"a": 1})
        assert r.get("commands/r1") == {"id": "r1", "status": "running"} and r.where("commands", "status", "running") == [{"id": "r1", "status": "running"}]
        assert command_feed(r, ["running"]).current() == [{"id": "r1", "status": "running"}]
        r.delete("commands/r1")
        assert r.get("commands/r1") is None and s.get("commands/r1") is None
    finally:
        srv.shutdown()
