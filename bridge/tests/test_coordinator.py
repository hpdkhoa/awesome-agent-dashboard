"""F7, question routing (plan bf73af63; the step's check: "a non-owner kind never reaches the owner's inbox"; the owner,
2026-11-19: "Lift the hold, build F7", "Plan session answers")."""
import json
import sys

import pytest

from agent_bridge import coordinator as co
from agent_bridge.inbox import Inbox
from agent_bridge.runs import Runs
from test_evidence import wait
from test_inbox import FakeStore

OPTS = [{"label": "Delete it", "detail": "frees 1.2 GB"}, {"label": "Keep it", "detail": "rebuild needs it"}]

# A stand-in for claude: checks the coordinator run is a never-saved fork of the plan's session with no edits and no
# inbox, then answers with one JSON line.
FAKE = r'''
import json, sys
a = sys.argv
_i = sys.argv.index("-p") + 1  # the prompt: after -p (a page-notes run), else on stdin (every run since 2026-11-25)
prompt = sys.argv[_i] if _i < len(sys.argv) and not sys.argv[_i].startswith("--") else sys.stdin.buffer.read().decode("utf-8")
assert a[a.index("--resume") + 1] == "plan-session" and "--fork-session" in a and "--no-session-persistence" in a
assert "mcp__agent-inbox" in a[a.index("--disallowedTools") + 1] and "--permission-prompt-tool" not in a
assert "never reaches the owner's inbox" in prompt
line = "no json" if "silent" in prompt else json.dumps({"choice": "Delete it", "text": "disk 2% free; node_modules rebuilds"})
print(json.dumps({"type": "result", "result": "Read the plan.\n" + line}))
'''


class Push:
    def __init__(self):
        self.sent = []

    def notify(self, title, body, url, tag):
        self.sent.append(title)


def make(tmp_path):
    fake = tmp_path / "fake_claude.py"
    fake.write_text(FAKE)
    work = tmp_path / "work"
    work.mkdir()
    store = FakeStore()
    store.put_many({"plans/p1": {"id": "p1", "title": "T", "machine": "PC", "sessionId": "plan-session", "cwd": str(work),
                                 "current": 1, "phase": "build", "activeStep": "F7", "createdAt": "2026-11-19"}})

    def popen(cmd, **kw):
        import subprocess
        return subprocess.Popen([sys.executable, str(fake), *cmd[1:]], **kw)

    push = Push()
    runs = Runs(store, "PC", [("w", str(work))], "claude", tmp_path / "out", popen=popen, logs=tmp_path / "logs",
                procs=lambda: [], push=push)
    inbox = Inbox(store, "PC", [("w", str(work))], "plan-session", str(work), push)
    return store, runs, inbox, push


def test_a_coordinator_question_never_reaches_the_owners_inbox_and_the_plan_session_answers(tmp_path):
    store, runs, inbox, push = make(tmp_path)
    party, ids = co.ask(inbox, "Delete node_modules?", "Delete node_modules", OPTS, 0, "disk low", None, "coordinator")
    assert party == "coordinator" and not store.where("inbox", "kind", "question") and push.sent == []
    q = store.get(f"coordinator/{ids[0]}")
    assert q["route"] == "coordinator" and q["planId"] == "p1" and q["stepId"] == "F7" and q["status"] == "open"
    c = wait(runs, store, q["commandId"])
    assert c["status"] == "done" and c["forkOf"] == "plan-session" and "sessionId" not in c
    assert store.get(f"coordinator/{ids[0]}")["answer"]["choice"] == "Delete it"
    text = co.take(store, ids[0])
    assert text.startswith("The coordinator (the plan's session) answered") and "Choice: Delete it." in text
    assert store.get(f"coordinator/{ids[0]}")["status"] == "delivered" and co.take(store, ids[0]) is None
    assert push.sent == [] and store.where("inbox", "kind", "question") == []  # still nothing for the owner


def test_owner_topics_go_to_the_inbox_with_their_topic(tmp_path):
    store, _, inbox, _ = make(tmp_path)
    for topic in co.OWNER_TOPICS:
        party, ids = co.ask(inbox, f"{topic}?", "", [{**o, "differs": "x", "example": {"type": "text", "draft": "d"}} for o in OPTS],
                            None, "", None, topic)
        item = store.get(f"inbox/{ids[0]}")
        assert party == "owner" and item["route"] == "owner" and item["topic"] == topic
    assert store.where("coordinator", "route", "coordinator") == []


def test_a_question_without_a_route_or_a_mixed_batch_is_refused(tmp_path):
    store, _, inbox, _ = make(tmp_path)
    with pytest.raises(ValueError, match="names its route"):
        co.ask(inbox, "q", options=OPTS)
    with pytest.raises(ValueError, match="names its route"):
        co.ask(inbox, "q", options=OPTS, route="gpu")
    with pytest.raises(ValueError, match="One batch goes to one party"):
        co.ask(inbox, "q", options=OPTS, route="scope", more_questions=[{"question": "q2", "route": "coordinator"}])
    assert store.where("inbox", "kind", "question") == [] and store.where("coordinator", "route", "coordinator") == []


def test_a_coordinator_batch_and_other_inbox_items_stamped_owner(tmp_path):
    store, _, inbox, _ = make(tmp_path)
    party, ids = co.ask(inbox, "q1", "", OPTS, None, "", [{"question": "q2", "route": "coordinator"}], "coordinator")
    assert party == "coordinator" and len(ids) == 2 and len(store.where("commands", "action", "coordinator")) == 2
    rid = inbox.post("result", "r", "done")
    assert store.get(f"inbox/{rid}")["route"] == "owner" and store.get(f"inbox/{rid}")["topic"] == "result"
    with pytest.raises(ValueError, match="Only owner items"):
        inbox.post("suggestion", "q", "q", extra={"route": "coordinator"})


def test_no_plan_no_coordinator_and_a_run_with_no_answer_tells_the_asker(tmp_path):
    store, runs, inbox, push = make(tmp_path)
    lone = Inbox(store, "PC", [], "other-session", str(tmp_path))
    with pytest.raises(ValueError, match="needs a plan"):
        co.ask(lone, "q", options=OPTS, route="coordinator")
    _, ids = co.ask(inbox, "silent q", "", OPTS, None, "", None, "coordinator")
    wait(runs, store, store.get(f"coordinator/{ids[0]}")["commandId"])
    text = co.take(store, ids[0])
    assert text.startswith("The coordinator could not answer") and push.sent == []


def test_parse_answer_keeps_only_a_real_option_label():
    assert co.parse_answer('x\n{"choice": "Nope", "text": "t"}', OPTS) == {"choice": "", "text": "t"}
    assert co.parse_answer(json.dumps({"choice": "Keep it"}), OPTS)["choice"] == "Keep it"
    assert co.parse_answer("no json", OPTS) is None
