import json
import subprocess
from datetime import datetime, timedelta, timezone

from agent_bridge.deliver import deliver
from agent_bridge.inbox import Inbox, answer_text

PARTS = {"goal": "g", "summary": "s", "rules": [], "lessons": [], "leftover": [],
         "steps": [{"id": "s1", "title": "t", "does": "d", "check": "c"}]}


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
        """Like Firestore with currentDocument.exists: a missing document is not made."""
        if path not in self.docs:
            return False
        self.docs[path].update(fields)
        return True

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
    qid = ib.post("question", "Which way?", "Pick one", [{"label": "A", "differs": "d", "detail": "fast"}, {"label": "B", "differs": "d"}], 0)
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
    qid = make(store).post("question", "t", "key AIza" + "x" * 35, [{"label": "A", "differs": "d"}], 5)
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
    pid = ib.plan_start("Plans tab", parts=PARTS)
    q0 = ib.post("question", "Scope?", "which", [{"label": "A", "differs": "d", "example": {"type": "text", "draft": "x"}}])
    assert ib.plan_version(pid, "", "first draft", parts=PARTS) == 2
    q1 = ib.post("question", "Graph?", "which", [{"label": "B", "differs": "d", "example": {"type": "text", "draft": "x"}}])
    assert ib.plan_version(pid, "", "Q1 picked B", parts=PARTS) == 3
    assert store.docs[f"inbox/{q0}"]["planId"] == pid and store.docs[f"inbox/{q0}"]["round"] == 1
    assert store.docs[f"inbox/{q1}"]["round"] == 2
    assert store.docs[f"planVersions/{pid}_v3"]["note"] == "Q1 picked B"
    assert store.docs[f"plans/{pid}"]["current"] == 3
    # closed is only a label the owner sets on the page: the plan keeps its questions and phase moves
    store.update(f"plans/{pid}", {"status": "closed"})
    q2 = ib.post("question", "later", "x", [{"label": "C", "differs": "d", "example": {"type": "text", "draft": "x"}}])
    assert store.docs[f"inbox/{q2}"]["planId"] == pid and store.docs[f"inbox/{q2}"]["round"] == 3
    assert ib.plan_version(pid, "", "to build", phase="build", order="Move the plan to phase Build.") == 4
    assert store.docs[f"plans/{pid}"]["phase"] == "build" and store.docs[f"plans/{pid}"]["status"] == "closed"
    # a plan moved to the latest format hands its questions to the new plan
    store.update(f"plans/{pid}", {"upgradedTo": "newer"})
    assert "planId" not in store.docs[f"inbox/{ib.post('question', 'after', 'x')}"]


def test_only_this_sessions_open_plan_takes_questions():
    store = FakeStore()
    make(store, "other").plan_start("not mine", parts=PARTS)
    ib = make(store)
    assert "planId" not in store.docs[f"inbox/{ib.post('question', 'q', 'x')}"]
    pid = ib.plan_start("mine", parts=PARTS)
    assert store.docs[f"inbox/{ib.post('question', 'q', 'x', [{'label': 'A', 'differs': 'd', 'example': {'type': 'text', 'draft': 'x'}}])}"]["planId"] == pid
    assert store.docs[f"plans/{pid}"]["current"] == 1
    assert store.docs[f"inbox/{ib.post('suggestion', 's', 'x')}"].get("planId") is None


def test_reopened_answer_branches_and_old_branch_keeps_its_answer():
    store = FakeStore()
    ib = make(store)
    pid = ib.plan_start("p", parts=PARTS)
    q = ib.post("question", "List or graph?", "x", [{"label": "List", "differs": "d", "example": {"type": "text", "draft": "x"}}, {"label": "Graph", "differs": "d", "example": {"type": "text", "draft": "x"}}])
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


def test_a_deleted_heartbeat_stays_deleted():
    store = FakeStore()
    inbox = make(store)
    inbox.beat()
    inbox.beat()
    assert store.get("liveSessions/s1")["sessionId"] == "s1"
    store.delete("liveSessions/s1")
    inbox.beat()
    inbox.beat()
    assert store.get("liveSessions/s1") is None


def test_a_batch_is_one_entry_with_its_questions_in_order_and_options_need_a_drawing_or_a_difference():
    import pytest
    store = FakeStore()
    ib = make(store)
    with pytest.raises(ValueError, match="drawing"):
        ib.post("question", "q", "x", [{"label": "A"}])
    svg = '<svg onload="x()"><script>bad()</script><rect/></svg>'
    ids = ib.post_batch([{"title": "one", "text": "1?", "options": [{"label": "A", "differs": "fast"}]},
                         {"title": "two", "text": "2?", "options": [{"label": "B", "example": {"type": "visual", "svg": svg}}]}])
    a, b = store.docs[f"inbox/{ids[0]}"], store.docs[f"inbox/{ids[1]}"]
    assert a["batchId"] == b["batchId"] and (a["batchIndex"], b["batchIndex"], a["batchSize"]) == (0, 1, 2)
    assert a["options"][0]["differs"] == "fast" and b["options"][0]["example"]["svg"] == "<svg><rect/></svg>"


def test_ask_back_is_seen_until_the_session_replies():
    store = FakeStore()
    ib = make(store)
    i = ib.post("question", "q", "x", [{"label": "A", "differs": "d"}])
    assert ib.ask_back(i) is None
    store.update(f"inbox/{i}", {"thread": [{"who": "owner", "kind": "answer", "choice": "A"},
                                           {"who": "owner", "kind": "ask", "text": "on a phone?"}]})
    assert ib.ask_back(i)["text"] == "on a phone?"
    assert ib.reply(i, "it stacks") and ib.ask_back(i) is None
    last = store.docs[f"inbox/{i}"]["thread"][-1]
    assert last["who"] == "session" and last["chars"] == len("it stacks") and "text" not in last  # words stay on the PC
    assert store.docs[f"inbox/{i}"]["status"] == "open"


def test_the_question_box_posts_one_batch():
    from agent_bridge.ask import post_questions
    store = FakeStore()
    ids = post_questions(make(store), [{"question": "a?", "options": [{"label": "x"}]}, {"question": "b?", "options": [{"label": "y"}]}])
    docs = [store.docs[f"inbox/{i}"] for i in ids]
    assert len({d["batchId"] for d in docs}) == 1 and all(d["via"] == "hook" for d in docs)


def test_a_new_plan_must_have_the_six_parts():
    ib = make(FakeStore())
    try:
        ib.plan_start("text only", "# v1")
    except ValueError as e:
        assert "latest format" in str(e)
    else:
        raise AssertionError("a text-only plan was opened")


def test_a_new_plan_carries_the_format_number():
    from agent_bridge.inbox import PLAN_FORMAT, format_of
    store = FakeStore()
    pid = make(store).plan_start("p", parts=PARTS)
    assert store.docs[f"plans/{pid}"]["format"] == PLAN_FORMAT == 1
    assert format_of({"kind": "parts"}) == 1 and format_of({}) == 0


def test_ask_back_delivered_by_the_bridge_when_the_session_stopped_waiting():
    store = FakeStore()
    ib = make(store)
    qid = ib.post("question", "Numbers", "Which?", [{"label": "A", "differs": "d"}, {"label": "B", "differs": "d"}], 0)
    assert deliver(store, "PC", "claude") == []  # no ask back yet
    store.update(f"inbox/{qid}", {"thread": [{"who": "owner", "kind": "ask", "text": "what is this?", "at": "t1"}]})
    store.put_many({"liveSessions/s1": {"sessionId": "s1", "beatAt": datetime.now(timezone.utc).isoformat()}})
    assert deliver(store, "PC", "claude") == []  # the session still polls: it sees the ask itself
    store.put_many({"liveSessions/s1": {"sessionId": "s1", "beatAt": (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()}})
    lines = deliver(store, "PC", "claude")
    assert len(lines) == 1 and "ask back handed to run" in lines[0]
    item = store.get(f"inbox/{qid}")
    cmds = store.where("commands", "action", "message")
    assert len(cmds) == 1 and cmds[0]["askBackId"] == qid and "inboxId" not in cmds[0]
    assert cmds[0]["sessionId"] == "s1" and "what is this?" in cmds[0]["prompt"] and f'inbox_reply(item_id="{qid}"' in cmds[0]["prompt"]
    assert item["status"] == "open" and item["askBackSentAt"] == "t1" and item["askBackCommandId"] == cmds[0]["id"]
    assert deliver(store, "PC", "claude") == []  # one run per ask back
    assert ib.reply(qid, "the table in the plan")
    store.update(f"inbox/{qid}", {"thread": store.get(f"inbox/{qid}")["thread"] + [{"who": "owner", "kind": "ask", "text": "which table?", "at": "t2"}]})
    lines = deliver(store, "PC", "claude")
    assert len(lines) == 1 and len(store.where("commands", "action", "message")) == 2  # a new ask back goes again


def test_deliver_takes_the_listened_rows_and_asks_firestore_nothing():
    # p14 F4: rows from the bridge's inbox listen replace the 3 queries a round
    store = FakeStore()
    qid = make(store).post("question", "q", "q")
    owner_answers(store, qid, "A")
    beat(store, "s1", 10)
    rows = [{**store.get(f"inbox/{qid}"), "id": qid}]
    asked = []
    store.where = lambda *a: asked.append(a) or []
    log = deliver(store, "PC", "claude", rows)
    assert asked == [] and len(log) == 1 and store.get(f"inbox/{qid}")["status"] == "delivering"
    assert deliver(store, "PC", "claude", []) == [] and asked == []
