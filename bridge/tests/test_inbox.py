import json
import subprocess
from datetime import datetime, timedelta, timezone

from agent_bridge.deliver import deliver
from agent_bridge.inbox import Inbox, answer_text


class FakeStore:
    """The four store calls the inbox uses, in memory."""

    def __init__(self):
        self.docs: dict[str, dict] = {}

    def put_many(self, docs):
        for p, d in docs.items():
            self.docs[p] = json.loads(json.dumps(d))
        return len(docs)

    def get(self, path):
        return self.docs.get(path)

    def update(self, path, fields):
        self.docs.setdefault(path, {}).update(fields)

    def delete(self, path):
        self.docs.pop(path, None)

    def where(self, collection, field, value):
        return [d for p, d in self.docs.items() if p.startswith(collection + "/") and d.get(field) == value]


def owner_answers(store, item_id, choice="", text=""):
    store.update(f"inbox/{item_id}", {"status": "answered", "answer": {"choice": choice, "text": text, "at": "x"}})


def make(store, sid="s1"):
    return Inbox(store, "PC", [("labs", "K:/labs")], sid, "K:/labs/x")


def test_question_round_trip_live():
    store = FakeStore()
    ib = make(store)
    qid = ib.post("question", "Which way?", "Pick one", [{"label": "A", "detail": "fast"}, {"label": "B"}], 0)
    item = store.get(f"inbox/{qid}")
    assert item["status"] == "open" and item["workType"] == "labs" and item["recommended"] == 0
    assert ib.take_answer(qid) is None
    owner_answers(store, qid, "A", "go")
    text = ib.take_answer(qid)
    assert "Choice: A." in text and "Note: go" in text
    assert store.get(f"inbox/{qid}")["status"] == "delivered" and store.get(f"inbox/{qid}")["deliveredVia"] == "live"
    assert ib.take_answer(qid) is None  # delivered once


def test_bad_recommended_index_is_dropped_and_secrets_removed():
    store = FakeStore()
    qid = make(store).post("question", "t", "key AIza" + "x" * 35, [{"label": "A"}], 5)
    item = store.get(f"inbox/{qid}")
    assert item["recommended"] is None and "AIza" not in item["text"]


def test_other_replies_reach_a_live_session():
    store = FakeStore()
    ib = make(store)
    sid = ib.post("suggestion", "Idea", "do X")
    owner_answers(store, sid, "Accept", "")
    assert ib.other_replies() == [answer_text(store.get(f"inbox/{sid}"))]
    assert ib.other_replies() == []


def beat(store, sid, minutes_ago):
    at = (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).isoformat(timespec="seconds")
    store.put_many({f"liveSessions/{sid}": {"sessionId": sid, "beatAt": at}})


def handed(store, qid):
    item = store.get(f"inbox/{qid}")
    return item, store.get(f"commands/{item['commandId']}")


def test_open_session_is_never_handed_over():
    store = FakeStore()
    qid = make(store).post("question", "q", "q")
    owner_answers(store, qid, "A")
    beat(store, "s1", 1)  # its inbox_ask still waits and takes the answer itself
    assert deliver(store, "PC", "claude") == [] and store.get(f"inbox/{qid}")["status"] == "answered"


def test_late_answer_goes_as_a_message_to_the_same_session():
    store = FakeStore()
    qid = make(store).post("question", "q", "q")
    owner_answers(store, qid, "A", "note")
    beat(store, "s1", 10)
    log = deliver(store, "PC", "claude")
    item, c = handed(store, qid)
    assert item["status"] == "delivering" and log == [f"{qid}: handed to run {c['id']}"]
    assert c["action"] == "message" and c["sessionId"] == "s1" and c["status"] == "new" and c["inboxId"] == qid
    assert "Choice: A." in c["prompt"] and c["machine"] == "PC"
    assert deliver(store, "PC", "claude") == []  # handed once


def test_failed_try_goes_again_after_10_minutes():
    store = FakeStore()
    qid = make(store).post("question", "q", "q")
    owner_answers(store, qid, "A")
    deliver(store, "PC", "claude")
    store.update(f"inbox/{qid}", {"status": "answered", "error": "boom"})  # runs.py wrote the failure back
    assert deliver(store, "PC", "claude") == []  # lastTryAt is fresh


def test_other_machine_and_missing_claude():
    store = FakeStore()
    q1 = Inbox(store, "LINUX", [], "s9", "/x").post("question", "q", "q")
    owner_answers(store, q1, "A")
    q2 = make(store, "s2").post("question", "q", "q")
    owner_answers(store, q2, "A")
    assert deliver(store, "PC", None) == [f"{q2}: no claude CLI"]
    assert store.get(f"inbox/{q1}")["status"] == "answered"


def test_reviewed_result_without_a_note_closes():
    store = FakeStore()
    rid = make(store).post("result", "r", "r")
    owner_answers(store, rid)
    deliver(store, "PC", "claude")
    assert store.get(f"inbox/{rid}")["status"] == "closed"


def test_cancelled_message_closes_the_answer():
    store = FakeStore()
    qid = make(store).post("question", "q", "q")
    owner_answers(store, qid, "A")
    deliver(store, "PC", "claude")
    item, c = handed(store, qid)
    store.update(f"commands/{c['id']}", {"status": "cancelled"})  # Cancel on the Runs tab
    assert deliver(store, "PC", "claude") == [f"{qid}: cancelled"] and store.get(f"inbox/{qid}")["status"] == "closed"


def test_plan_rounds_follow_its_versions():
    store = FakeStore()
    ib = make(store)
    pid = ib.plan_start("Plans tab")
    q0 = ib.post("question", "Scope?", "which", [{"label": "A"}])
    assert ib.plan_version(pid, "# v1", "first draft") == 1
    q1 = ib.post("question", "Graph?", "which", [{"label": "B"}])
    assert ib.plan_version(pid, "# v2", "Q1 picked B") == 2
    assert store.docs[f"inbox/{q0}"]["planId"] == pid and store.docs[f"inbox/{q0}"]["round"] == 0
    assert store.docs[f"inbox/{q1}"]["round"] == 1
    assert store.docs[f"planVersions/{pid}_v2"]["note"] == "Q1 picked B"
    assert store.docs[f"plans/{pid}"]["current"] == 2
    ib.plan_close(pid, "approved")
    assert "planId" not in store.docs[f"inbox/{ib.post('question', 'later', 'x')}"]


def test_only_this_sessions_open_plan_takes_questions():
    store = FakeStore()
    make(store, "other").plan_start("not mine")
    ib = make(store)
    assert "planId" not in store.docs[f"inbox/{ib.post('question', 'q', 'x')}"]
    pid = ib.plan_start("mine", "# v1")
    assert store.docs[f"inbox/{ib.post('question', 'q', 'x')}"]["planId"] == pid
    assert store.docs[f"plans/{pid}"]["current"] == 1
    assert store.docs[f"inbox/{ib.post('suggestion', 's', 'x')}"].get("planId") is None


def test_reopened_answer_branches_and_old_branch_keeps_its_answer():
    store = FakeStore()
    ib = make(store)
    pid = ib.plan_start("p", "# v1")
    q = ib.post("question", "List or graph?", "x", [{"label": "List"}, {"label": "Graph"}])
    owner_answers(store, q, "List")
    assert ib.plan_version(pid, "# v2 list", "Q: List") == 2
    assert store.docs[f"planVersions/{pid}_v2"]["parent"] == 1
    assert store.docs[f"planVersions/{pid}_v2"]["madeBy"][0]["choice"] == "List"
    assert ib.plan_version(pid, "# v3", "more") == 3
    # the owner reopens the question on the page: the old answer goes to history
    store.update(f"inbox/{q}", {"status": "answered", "reopened": True, "history": [{"choice": "List"}],
                                "answer": {"choice": "Graph", "text": "", "at": "y"}})
    text = answer_text(store.docs[f"inbox/{q}"])
    assert "reopened" in text and "parent=1" in text and "it was: List" in text
    assert ib.plan_version(pid, "# v4 graph", "Q reopened: Graph", parent=1) == 4
    v4 = store.docs[f"planVersions/{pid}_v4"]
    assert v4["parent"] == 1 and v4["madeBy"][0]["choice"] == "Graph"
    assert store.docs[f"planVersions/{pid}_v2"]["madeBy"][0]["choice"] == "List"
    assert store.docs[f"plans/{pid}"]["chosen"] == 4
