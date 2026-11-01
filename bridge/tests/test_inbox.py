import json
import subprocess
from datetime import datetime, timedelta, timezone

from agent_bridge.deliver import deliver, resume_command
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


class Runner:
    def __init__(self, code=0, out='{"result": "ok, continuing"}'):
        self.calls, self.code, self.out = [], code, out

    def __call__(self, cmd, **kw):
        self.calls.append((cmd, kw))
        return subprocess.CompletedProcess(cmd, self.code, self.out, "boom" if self.code else "")


def test_open_session_is_never_resumed():
    store = FakeStore()
    qid = make(store).post("question", "q", "q")
    owner_answers(store, qid, "A")
    beat(store, "s1", 1)
    run = Runner()
    assert deliver(store, "PC", "claude", run) == [] and run.calls == []


def test_closed_session_is_resumed_with_the_answer():
    store = FakeStore()
    qid = make(store).post("question", "q", "q")
    owner_answers(store, qid, "A", "note")
    beat(store, "s1", 10)
    run = Runner()
    log = deliver(store, "PC", "claude", run)
    cmd, kw = run.calls[0]
    assert cmd[:2] == ["claude", "-p"] and cmd[3:5] == ["--resume", "s1"] and "Choice: A." in cmd[2]
    assert "ANTHROPIC_API_KEY" not in kw["env"]
    item = store.get(f"inbox/{qid}")
    assert item["status"] == "delivered" and item["deliveredVia"] == "resume" and item["followUp"] == "ok, continuing"
    assert log == [f"{qid}: delivered by resume"]


def test_failed_resume_stays_answered_and_waits_before_retry():
    store = FakeStore()
    qid = make(store).post("question", "q", "q")
    owner_answers(store, qid, "A")
    run = Runner(code=1, out="")
    deliver(store, "PC", "claude", run)
    assert store.get(f"inbox/{qid}")["status"] == "answered" and store.get(f"inbox/{qid}")["error"] == "boom"
    deliver(store, "PC", "claude", run)
    assert len(run.calls) == 1  # no second try within 10 minutes


def test_other_machine_and_missing_claude():
    store = FakeStore()
    q1 = Inbox(store, "LINUX", [], "s9", "/x").post("question", "q", "q")
    owner_answers(store, q1, "A")
    q2 = make(store, "s2").post("question", "q", "q")
    owner_answers(store, q2, "A")
    run = Runner()
    assert deliver(store, "PC", None, run) == [f"{q2}: no claude CLI"] and run.calls == []
    assert store.get(f"inbox/{q1}")["status"] == "answered"


def test_reviewed_result_without_a_note_closes():
    store = FakeStore()
    rid = make(store).post("result", "done", "numbers")
    owner_answers(store, rid)
    deliver(store, "PC", "claude", Runner())
    assert store.get(f"inbox/{rid}")["status"] == "closed"


def test_resume_command_shape():
    assert resume_command("claude", "abc", "hi") == ["claude", "-p", "hi", "--resume", "abc", "--output-format", "json"]


def test_resume_error_shows_claudes_message():
    store = FakeStore()
    qid = make(store).post("question", "q", "q")
    owner_answers(store, qid, "A")
    run = Runner(code=1, out='{"type": "result", "is_error": true, "result": "Not logged in · Please run /login"}')
    deliver(store, "PC", "claude", run)
    assert store.get(f"inbox/{qid}")["error"] == "Not logged in · Please run /login"


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
