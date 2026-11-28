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


def test_redraw_changes_one_question_in_place_and_keeps_the_batch_and_its_answers():
    store = FakeStore()
    ib = make(store)
    old = '<svg><rect/></svg>'
    ids = ib.post_batch([{"title": "one", "text": "1?", "options": [{"label": "A", "example": {"type": "visual", "svg": old}},
                                                                   {"label": "B", "differs": "slow"}]},
                         {"title": "two", "text": "2?", "options": [{"label": "C", "differs": "d"}]}])
    store.update(f"inbox/{ids[0]}", {"draft": {"choice": "B", "text": "", "at": "t0"},
                                     "thread": [{"who": "owner", "kind": "ask", "text": "redraw a please", "at": "t1"}]})
    store.update(f"inbox/{ids[1]}", {"draft": {"choice": "C", "text": "", "at": "t0"}})
    before_two = dict(store.docs[f"inbox/{ids[1]}"])
    assert ib.redraw(ids[0], "bigger labels", option=0, svg='<svg onload="x()"><circle/></svg>') == ""
    a = store.docs[f"inbox/{ids[0]}"]
    assert a["options"][0]["example"]["svg"] == "<svg><circle/></svg>" and a["options"][1]["differs"] == "slow"
    assert a["draft"]["choice"] == "B" and a["redrawn"] and a["revisions"][0]["options"][0]["example"]["svg"] == old
    assert a["thread"][-1]["kind"] == "redraw" and "drawing (a)" in a["thread"][-1]["text"] and ib.ask_back(ids[0]) is None
    assert store.docs[f"inbox/{ids[1]}"] == before_two  # the other question and its saved answer are untouched
    assert len(store.where("inbox", "batchId", a["batchId"])) == 2  # no new batch


def test_redraw_can_reshape_the_question_and_clears_only_a_pick_that_is_gone():
    store = FakeStore()
    ib = make(store)
    i = ib.post("question", "q", "old?", [{"label": "A", "differs": "x"}, {"label": "B", "differs": "y"}], 1)
    store.update(f"inbox/{i}", {"draft": {"choice": "B", "text": "", "at": "t"}})
    assert "differs" in ib.redraw(i, "", options=[{"label": "A2"}])
    assert ib.redraw(i, "", question="sharper?", options=[{"label": "A2", "differs": "x2"}]) == ""
    d = store.docs[f"inbox/{i}"]
    assert d["text"] == "sharper?" and [o["label"] for o in d["options"]] == ["A2"] and d["recommended"] is None
    assert d["draft"] is None and "saved pick cleared" in d["thread"][-1]["text"]
    assert "index" in ib.redraw(i, "", option=5, svg="<svg/>")
    assert "Only the session" in make(store, "s2").redraw(i, "", question="x")
    store.update(f"inbox/{i}", {"status": "answered"})
    assert "already answered" in ib.redraw(i, "", question="x")


def test_a_delivered_answer_keeps_its_plan_and_step_without_becoming_a_run_step():
    # the owner's choice, 2026-11-15: "v7 data + code fix": answer runs show in the plan's Results
    store = FakeStore()
    opts = [{"label": "Close s2", "differs": "d", "example": {"type": "text", "draft": "x"}}]
    qid = make(store).post("question", "q", "q", opts, extra={"planId": "p1", "stepId": "s2"})
    owner_answers(store, qid, "Close s2")
    beat(store, "s1", 10)
    deliver(store, "PC", "claude")
    c = store.where("commands", "action", "message")[0]
    assert c["planId"] == "p1" and c["answerStep"] == "s2" and "stepId" not in c
    q2 = make(store).post("question", "q", "q")
    owner_answers(store, q2, "A")
    deliver(store, "PC", "claude")
    c2 = [x for x in store.where("commands", "action", "message") if x["inboxId"] == q2][0]
    assert "planId" not in c2 and "answerStep" not in c2


# The board (the owner's pick, 2026-11-16, "Product board, new fields"): what for, idea, product features with steps.
BOARD = {"what_for": "Run boxes from the avatar", "idea": ["SEND node"], "product": [{"feature": "Send", "steps": ["s1"]}]}


def test_board_is_kept_checked_and_never_dropped():
    import pytest
    from agent_bridge.inbox import parts_markdown
    store = FakeStore()
    ib = make(store)
    pid = ib.plan_start("Board", parts=PARTS)
    with pytest.raises(ValueError, match="s9"):
        ib.plan_version(pid, "", "bad step", parts={**PARTS, "board": {**BOARD, "product": [{"feature": "x", "steps": ["s9"]}]}})
    two = {**PARTS, "steps": PARTS["steps"] + [{"id": "s2", "title": "t2", "does": "d", "check": "c"}]}
    with pytest.raises(ValueError, match="leaves steps out: s2"):
        ib.plan_version(pid, "", "s2 under no feature", parts={**two, "board": BOARD})
    with pytest.raises(ValueError, match="what_for"):
        ib.plan_version(pid, "", "no what for", parts={**PARTS, "board": {"product": BOARD["product"]}})
    n = ib.plan_version(pid, "", "board added", parts={**PARTS, "board": BOARD})
    saved = store.docs[f"planVersions/{pid}_v{n}"]
    assert saved["parts"]["board"] == {"whatFor": "Run boxes from the avatar", "idea": ["SEND node"],
                                       "product": [{"feature": "Send", "steps": ["s1"]}]}
    assert "## Board" in parts_markdown(saved["parts"]) and "Feature: Send (steps s1)" in parts_markdown(saved["parts"])
    with pytest.raises(ValueError, match="board"):
        ib.plan_version(pid, "", "dropped", parts=PARTS)
    assert store.docs[f"plans/{pid}"]["current"] == n
    # the stored camelCase board goes through again (a plain version or a resend of the read-back parts)
    assert ib.plan_version(pid, "", "resend", parts=saved["parts"]) == n + 1


def test_board_sources_are_checked_kept_and_shown(tmp_path):
    """Plan 44fc4979 s3 (the owner's picks, 2026-11-19: "Source chip per line", "Source field per line", "Red chip now,
    refuse after s6"): each id must exist; a line with none is kept; a plain version keeps the sources."""
    import pytest
    from agent_bridge.inbox import parts_markdown
    store = FakeStore()
    store.put_many({"records/dec:470": {"id": "dec:470", "text": "agreed"}})
    log = tmp_path / "LOG.md"
    log.write_text("a\nb\nc\n", encoding="utf-8")
    ib = make(store)
    pid = ib.plan_start("Src", parts=PARTS)
    good = {**BOARD, "what_for": {"text": "Run boxes", "src": ["goal", "dec:470"]},
            "idea": [{"text": "SEND node", "src": ["s1", f"{log}:2", f'{log}#"b"']}, "no source here"]}
    for bad, why in [("dec:999", "no such record"), (f"{log}:9", "has 3 lines"), (str(tmp_path / "x.md"), "no such file"),
                     ("s9", "naming no step"), ("whatever", "not understood"),
                     (f'{log}#"zzz"', "does not hold these words")]:
        with pytest.raises(ValueError, match=why):
            ib.plan_version(pid, "", "bad src", parts={**PARTS, "board": {**good, "what_for": {"text": "W", "src": [bad]}}})
    n = ib.plan_version(pid, "", "sources", parts={**PARTS, "board": good})
    b = store.docs[f"planVersions/{pid}_v{n}"]["parts"]["board"]
    assert b["whatFor"] == "Run boxes" and b["idea"] == ["SEND node", "no source here"]
    assert b["src"] == {"whatFor": ["goal", "dec:470"], "idea": [["s1", f"{log}:2", f'{log}#"b"'], []]}
    md = parts_markdown(store.docs[f"planVersions/{pid}_v{n}"]["parts"])
    assert "[src: goal, dec:470]" in md and "no source here [src: none]" in md
    # a resend of the read-back parts (a plain version) keeps the sources
    m = ib.plan_version(pid, "", "resend", parts=store.docs[f"planVersions/{pid}_v{n}"]["parts"])
    assert store.docs[f"planVersions/{pid}_v{m}"]["parts"]["board"]["src"] == b["src"]
    # a board with no sources at all stays as it was (old plans until s6)
    k = ib.plan_version(pid, "", "old shape", parts={**PARTS, "board": BOARD})
    assert "src" not in store.docs[f"planVersions/{pid}_v{k}"]["parts"]["board"]


def test_plan_get_reads_the_current_parts_harness_and_step_states():
    """G2 (the owner, 2026-11-18: "all 5 gap, fix one by one"): a fresh session reads the plan from the store."""
    import pytest
    from agent_bridge.inbox import item_hash
    store = FakeStore()
    ib = make(store)
    pid = ib.plan_start("P", parts=PARTS)
    h = [{"id": "h1", "kind": "tool", "item": "pytest"}, {"id": "h2", "kind": "check", "item": "ok"}]
    ib.plan_version(pid, "", "harness", parts=PARTS, harness=h)
    store.put_many({f"planHarness/{pid}": {"items": {"h1": {"ok": True, "hash": item_hash(h[0])}}}})
    got = ib.plan_get(pid)
    assert got["version"] == 2 and [{k: v for k, v in s.items() if k not in ("v", "vSince")} for s in got["parts"]["steps"]] == PARTS["steps"] and got["stepStates"] == {"s1": "next"}
    assert [x["approved"] for x in got["harness"]] == [True, False]
    assert ib.plan_get(pid, "rules") == {"plan": pid, "title": "P", "phase": "explore", "version": 2, "rules": []}
    assert [x["id"] for x in ib.plan_get(pid, "harness")["harness"]] == ["h1", "h2"]
    with pytest.raises(ValueError):
        ib.plan_get(pid, "nope")
    with pytest.raises(ValueError):
        ib.plan_get("missing")


# Inbox send fix (the owner's picks, 2026-11-21, plan 44fc4979): "Refuse the re-ask", "Ask me if they differ",
# "All in one turn", "fix now no need new plan or step".
OPT = [{"label": "A", "differs": "d", "example": {"type": "text", "draft": "x"}}]


def test_a_re_ask_of_a_waiting_question_on_the_same_plan_is_refused():
    from agent_bridge.inbox import repeat_of
    store = FakeStore()
    qid = make(store).post("question", "s8 check", "q", OPT, extra={"planId": "p1"})
    assert qid in repeat_of(store, "p1", ["S8 check?"]) and "inbox_redraw" in repeat_of(store, "p1", ["s8 check"])
    assert repeat_of(store, "p2", ["s8 check"]) == "" and repeat_of(store, "p1", ["s8 ship"]) == ""
    assert qid in repeat_of(store, "p1", ["s8 check, with previews"])  # same start too
    assert repeat_of(store, "p1", ["s8"]) != "" and repeat_of(store, "p1", ["s8 checks"]) == ""  # whole words only
    owner_answers(store, qid, "A")
    assert "on its way" in repeat_of(store, "p1", ["s8 check"])  # answered, not delivered yet
    store.update(f"inbox/{qid}", {"status": "delivered"})
    assert repeat_of(store, "p1", ["s8 check"]) == ""  # the session has the answer: asking again is allowed


def test_two_different_answers_to_one_question_ask_the_owner_which_counts():
    store = FakeStore()
    ib = make(store)
    a = ib.post("question", "s8 check", "q", OPT, extra={"planId": "p1"})
    b = ib.post("question", "s8 check", "q", OPT, extra={"planId": "p1"})  # asked again before a was delivered
    owner_answers(store, a, "Your ok")
    owner_answers(store, b, "", "no test")
    text = answer_text(store.get(f"inbox/{b}"), store)
    assert "answers differ" in text and a in text and "Your ok" in text
    owner_answers(store, b, "Your ok")
    assert "differ" not in answer_text(store.get(f"inbox/{b}"), store)  # the same answer twice: no note


def test_every_waiting_answer_of_a_session_goes_in_one_turn_in_answer_order():
    store = FakeStore()
    ib = make(store)
    ids = ib.post_batch([{"title": t, "text": "?", "options": OPT} for t in ("one", "two", "three")])
    for k, i in enumerate(ids):
        store.update(f"inbox/{i}", {"status": "answered", "answer": {"choice": "A", "text": "", "at": f"t{3 - k}"}})
    other = make(store, "s2").post("question", "x", "x")
    owner_answers(store, other, "A")
    beat(store, "s1", 10)
    beat(store, "s2", 10)
    deliver(store, "PC", "claude")
    cs = store.where("commands", "action", "message")
    assert len(cs) == 2  # one run per session, not one per answer
    c = next(x for x in cs if x["sessionId"] == "s1")
    assert c["inboxIds"] == list(reversed(ids)) and "answered 3 items" in c["prompt"]
    assert c["prompt"].index('"three"') < c["prompt"].index('"one"')
    assert all(store.get(f"inbox/{i}")["commandId"] == c["id"] for i in ids)


def test_a_live_session_that_does_not_poll_still_gets_its_answer():
    # 2026-11-22: a result answered while the session's process stayed up (a background job) without any inbox_ask /
    # inbox_wait polling stayed "answered" for hours; only a polling session takes its answers itself
    store = FakeStore()
    rid = make(store).post("result", "S6 done", "test it")
    owner_answers(store, rid, "Reviewed, see note", "passed")
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    store.put_many({"liveSessions/s1": {"sessionId": "s1", "beatAt": now, "waitingOn": ["q9"]}})
    assert deliver(store, "PC", "claude") == [] and store.get(f"inbox/{rid}")["status"] == "answered"  # polls: takes it
    store.put_many({"liveSessions/s1": {"sessionId": "s1", "beatAt": now}})
    assert deliver(store, "PC", "claude") == []  # an older inbox server (no waitingOn) counts as polling, as before
    store.put_many({"liveSessions/s1": {"sessionId": "s1", "beatAt": now, "waitingOn": []}})
    log = deliver(store, "PC", "claude")
    item, c = handed(store, rid)
    assert item["status"] == "delivering" and log == [f"{rid}: handed to run {c['id']}"] and "passed" in c["prompt"]


def test_set_waiting_writes_waiting_on_with_the_beat():
    store = FakeStore()
    ib = make(store)
    ib.set_waiting("q1", True)
    assert store.get("liveSessions/s1")["waitingOn"] == ["q1"]
    ib.set_waiting("q1", True)
    ib.set_waiting("q1", False)
    assert store.get("liveSessions/s1")["waitingOn"] == ["q1"]  # a second wait on the same item still polls
    ib.set_waiting("q1", False)
    assert store.get("liveSessions/s1")["waitingOn"] == []


def test_long_text_is_kept_or_refused_never_cut():
    # the owner, 2026-11-25 (plan 41e0e5f2 #169): rules were saved cut at 400 chars with "…"; now kept whole up to
    # the limit, refused over it, nothing saved
    import pytest
    store = FakeStore()
    ib = make(store)
    pid = ib.plan_start("Long", parts=PARTS)
    rule = "r" * 1500
    n = ib.plan_version(pid, "", "long rule", parts={**PARTS, "rules": [{"rule": rule, "source": "s"}], "goal": "g" * 30000})
    saved = store.docs[f"planVersions/{pid}_v{n}"]["parts"]
    assert saved["rules"][0]["rule"] == rule and len(saved["goal"]) == 30000
    with pytest.raises(ValueError, match=r"rules\[0\]\.rule is 2001 characters"):
        ib.plan_version(pid, "", "too long", parts={**PARTS, "rules": [{"rule": "x" * 2001, "source": "s"}]})
    assert store.docs[f"plans/{pid}"]["current"] == n


def test_patch_changes_only_what_it_names():
    import pytest
    store = FakeStore()
    ib = make(store)
    base = {**PARTS, "rules": [{"rule": "a", "source": "1"}, {"rule": "b", "source": "2"}],
            "steps": [{"id": "s1", "title": "t", "does": "d", "check": "c"}, {"id": "s2", "title": "t2", "does": "d2", "check": "c2"}],
            "board": {**BOARD, "product": [{"feature": "Send", "steps": ["s1", "s2"]}],
                      "glossary": [{"group": "g", "term": "A", "means": "a"}]}}
    pid = ib.plan_start("Patch", parts=base)
    n = ib.plan_version(pid, "", "patch", patch={"rules": {"1": {"rule": "B"}, "2": {"rule": "c", "source": "3"}},
                                                  "steps": {"s2": {"does": "D2"}},
                                                  "board": {"glossary": [{"group": "g", "term": "A", "means": "a"},
                                                                         {"group": "g", "term": "B", "means": "b"}]}})
    p = store.docs[f"planVersions/{pid}_v{n}"]["parts"]
    assert [r["rule"] for r in p["rules"]] == ["a", "B", "c"] and p["rules"][1]["source"] == "2"
    assert p["steps"][1] == {"id": "s2", "title": "t2", "does": "D2", "check": "c2", "v": 2, "vSince": 2} and p["steps"][0]["does"] == "d"
    assert p["steps"][0]["v"] == 1 and p["steps"][0]["vSince"] == 1  # A: an unchanged step keeps its version
    assert len(p["board"]["glossary"]) == 2 and p["board"]["whatFor"] == BOARD["what_for"]
    assert p["goal"] == "g" and p["board"]["product"] == [{"feature": "Send", "steps": ["s1", "s2"]}]
    m = ib.plan_version(pid, "", "append", patch={"goal": {"append": "more"}})
    assert store.docs[f"planVersions/{pid}_v{m}"]["parts"]["goal"] == "g\n\nmore"
    with pytest.raises(ValueError, match="not both"):
        ib.plan_version(pid, "", "x", parts=base, patch={"goal": "x"})
    with pytest.raises(ValueError, match="use 0 to 3"):
        ib.plan_version(pid, "", "x", patch={"rules": {"7": {"rule": "z"}}})


def test_result_keeps_per_file_change_lines():
    # the owner, 2026-11-27: "show me a short summarize what is changed in the files and what need to review so I can
    # check via the file link"; pick "A: per file lines"
    from agent_bridge.inbox import missing_changes
    store = FakeStore()
    inbox = make(store)
    rows = [{"file": "K:/a/x.py", "changed": "adds the gate", "check": "the gate refuses empty rows"}]
    rid, n = inbox.result("r", "done", ["K:/a/x.py"], changes=rows, edit_of="")
    item = store.get(f"inbox/{rid}")
    assert n == 1 and item["changes"] == rows and "K:/a/x.py" in item["files"]
    # an edit replaces the lines and keeps the earlier ones in its version
    rid2, n2 = inbox.result("r", "done 2", [], edit_of=rid,
                            changes=[{"file": "K:/a/y.py", "changed": "c", "check": "k"}])
    item = store.get(f"inbox/{rid}")
    assert rid2 == rid and n2 == 2 and item["files"] == ["K:/a/y.py"] and item["versions"][-1]["changes"] == rows
    # a row missing a line is refused; a file with no row is named
    for bad in ([{"file": "K:/a/x.py", "changed": "c"}], ["x"]):
        try:
            inbox.result("r", "t", changes=bad)
            raise AssertionError("not refused")
        except ValueError:
            pass
    assert missing_changes(["K:/a/x.py", "K:/a/z.py"], rows) == ["K:/a/z.py"]


def test_result_quote_is_checked_against_the_file(tmp_path):
    # the owner, 2026-11-28: a "quote" section "which show me exactly the part of the work ... quote what changed inside
    # what file"; pick "Session quote, bridge checks"
    from agent_bridge.inbox import missing_quotes
    f = tmp_path / "x.py"
    f.write_bytes(b"def a():\r\n    return 1   \r\n\r\ndef b():\r\n    return 2\r\n")
    img = tmp_path / "p.png"
    img.write_bytes(b"\x89PNG\x00\x00")
    store = FakeStore()
    inbox = make(store)
    ok = "def a():\n    return 1\n...\ndef b():"
    rows = [{"file": str(f), "changed": "adds a and b", "check": "both return", "quote": ok},
            {"file": str(img), "changed": "new picture", "check": "markers"}]
    rid, _ = inbox.result("r", "done", changes=rows)
    item = store.get(f"inbox/{rid}")
    assert item["changes"][0]["quote"] == ok and "quote" not in item["changes"][1]
    # a quote not in the file, a quote on a picture, and an over long quote are refused, never cut
    for bad in ({"file": str(f), "changed": "c", "check": "k", "quote": "def c():"},
                {"file": str(img), "changed": "c", "check": "k", "quote": "PNG"},
                {"file": str(f), "changed": "c", "check": "k", "quote": "x" * 6001}):
        try:
            inbox.result("r", "t", changes=[bad])
            raise AssertionError("not refused")
        except ValueError:
            pass
    # a text file with no quote is named; a picture and a deleted file need none
    gone = str(tmp_path / "gone.py")
    assert missing_quotes([{"file": str(f)}, {"file": str(img)}, {"file": gone}]) == [str(f)]


REPORT = {"status": "Completed", "bottom_line": "Quote built and pushed. Nothing needs you.",
          "created": ["tests/quote.card.test.ts"], "updated": ["inbox.py: 4 functions"], "sent": [],
          "decisions": ["quote check ignores trailing spaces"], "skipped": [{"item": "no screenshot", "fix": "check on the next card"}],
          "next": "Task closed, no further runs scheduled"}


def test_result_report_is_checked_and_its_header_measured_from_the_run():
    # the owner, 2026-11-28: "New Result field" in the "Dashboard Card / Report Layout"; "Add Failed"; "Item + fix"
    from agent_bridge.inbox import clean_result_report as clean_report
    store = FakeStore()
    ib = make(store)
    store.put_many({"commands/c1": {"id": "c1", "sessionId": "s1", "status": "running", "action": "message",
                                    "startedAt": (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()}})
    rid, _ = ib.result("r", "done", result_report=REPORT)
    rep = store.get(f"inbox/{rid}")["report"]
    assert rep["status"] == "Completed" and rep["runId"] == "c1" and 290 <= rep["seconds"] <= 320 and rep["sent"] == []
    assert rep["skipped"] == [{"item": "no screenshot", "fix": "check on the next card"}] and rep["at"]
    assert clean_report({**REPORT, "status": "Failed"})["status"] == "Failed"
    for bad in ({**REPORT, "status": "Done"}, {**REPORT, "bottom_line": ""}, {**REPORT, "bottom_line": "A. B. C."},
                {**REPORT, "skipped": [{"item": "x"}]}, {**REPORT, "next": ""}):
        try:
            clean_report(bad)
            raise AssertionError(f"not refused: {bad}")
        except ValueError:
            pass
    # an edit keeps the earlier report in its version; a step report keeps the posted report
    ib.result("r2", "done 2", edit_of=rid, result_report={**REPORT, "status": "Failed"})
    item = store.get(f"inbox/{rid}")
    assert item["report"]["status"] == "Failed" and item["versions"][-1]["report"]["status"] == "Completed"


def test_review_questions_sit_in_the_review_and_their_answers_go_once():
    # the owner, 2026-11-28: "the question will listed inside the review/report if it is belong to this review, not like
    # current 2 messages and send two times when I answered each"
    from agent_bridge import coordinator as co
    store = FakeStore()
    ib = make(store)
    rid, _ = ib.result("r", "done", result_report=REPORT)
    opts = [{"label": "A", "differs": "d"}, {"label": "B", "differs": "d"}]
    _, (q1,) = co.ask(ib, "First?", "First", opts, 0, route="scope", review=rid)
    _, (q2, q3) = co.ask(ib, "Second?", "Second", opts, 0, route="scope", review=rid,
                         more_questions=[{"question": "Third?", "title": "Third", "options": opts, "route": "scope"}])
    assert all(store.get(f"inbox/{q}")["reviewId"] == rid for q in (q1, q2, q3))
    beat(store, "s1", 10)
    owner_answers(store, q1, "A")
    owner_answers(store, rid, "", "ok")
    assert deliver(store, "PC", "claude") == []  # q2, q3 still open: nothing goes yet
    owner_answers(store, q2, "B")
    owner_answers(store, q3, "A")
    log = deliver(store, "PC", "claude")
    cmds = store.where("commands", "action", "message")
    assert len(log) == 1 and len(cmds) == 1 and set(cmds[0]["inboxIds"]) == {rid, q1, q2, q3}
    # a review that is not a result, or a coordinator question, is refused
    for kw in ({"review": q1, "route": "scope"}, {"review": rid, "route": "coordinator"}):
        try:
            co.ask(ib, "Fourth?", "Fourth", opts, 0, **kw)
            raise AssertionError("not refused")
        except ValueError:
            pass
