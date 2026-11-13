"""The bridge's own code on the local database: a question asked, answered through the data API, taken; a deliver
round; the status counts. The same classes as on Firestore, nothing faked but the session."""
from agent_bridge.dataapi import DataApi
from agent_bridge.deliver import deliver
from agent_bridge.inbox import Inbox
from agent_bridge.listen import LocalAccountFeeds
from agent_bridge.localdb import LocalStore


def test_question_answer_and_delivery_on_the_local_database(tmp_path):
    store = LocalStore(tmp_path / "data.sqlite")
    ib = Inbox(store, "PC", [("labs", "K:/labs")], "s1", "K:/labs/x")
    qid = ib.post("question", "Which way?", "Pick one", [{"label": "A", "differs": "d"}, {"label": "B", "differs": "d"}], 0)
    from datetime import datetime, timezone
    iso = lambda t: datetime.fromtimestamp(t, timezone.utc).isoformat(timespec="seconds")
    store.put_many({"liveSessions/a": {"beatAt": iso(990)}, "liveSessions/b": {"beatAt": iso(950)}, "liveSessions/old": {"beatAt": iso(100)}})
    feeds = LocalAccountFeeds(store)
    d = feeds.read(1000.0)
    assert (d["going"], d["sessions"], d["inbox"]) == (0, 2, 1)  # two beat in the last 180 s, one went quiet
    api = DataApi(store)  # the page answers through the bridge
    found = api.answer({"op": "find", "coll": "inbox", "filters": [["status", "in", ["open", "answered", "delivering"]]], "limit": 10})
    assert [r["id"] for r in found["docs"]] == [qid]
    assert api.answer({"op": "update", "path": f"inbox/{qid}", "fields": {"status": "answered", "answer": {"choice": "A", "text": "go", "at": "x"}}}) == {"ok": True}
    text = ib.take_answer(qid)  # the waiting session takes it live
    assert "Choice: A." in text and store.get(f"inbox/{qid}")["status"] == "delivered"
    q2 = ib.post("question", "Later?", "Pick", [{"label": "A", "differs": "d"}, {"label": "B", "differs": "d"}], 0)
    api.answer({"op": "update", "path": f"inbox/{q2}", "fields": {"status": "answered", "answer": {"choice": "B", "text": "", "at": "x"}}})
    lines = deliver(store, "PC", "claude")  # the session is gone: the bridge hands the answer to a message run
    assert any("handed to run" in x for x in lines)
    cmds = store.where("commands", "action", "message")
    assert len(cmds) == 1 and cmds[0]["inboxId"] == q2 and store.get(f"inbox/{q2}")["status"] == "delivering"
    assert feeds.read(1000.0)["inbox"] == 0
