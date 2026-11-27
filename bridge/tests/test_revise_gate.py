"""A step version, B plan revise, C the owner's gate on a step's check (the owner, 2026-11-25: "I want each step has a
version and when any work not change the step then the version is kept"; "any work will change the plan and show it
out, so the step in future will have the flexible the adjust due to previous step result"; "it need inbox review but I
said ok or agree but the plan step still failed, and I don't have the auto check run config"; "build a b c, for c
default is off")."""
import pytest

from agent_bridge.deliver import deliver
from agent_bridge.inbox import Inbox
from agent_bridge.stepcheck import StepChecks, ticked
from agent_bridge.stepgate import CHECKED, NOT_DONE, TICK, act
from test_inbox import FakeStore
from test_stepcheck import REP, ROOT, fake

STEPS = [{"id": f"s{i}", "title": f"t{i}", "does": f"d{i}", "check": f"c{i}"} for i in (1, 2, 3)]
PARTS = {"goal": "g", "summary": "s", "rules": [], "lessons": [], "leftover": [], "steps": STEPS}


def make():
    store = FakeStore()
    ib = Inbox(store, "PC", [("t", ROOT)], "s1", ROOT)
    pid = ib.plan_start("T", parts=PARTS)
    store.update(f"plans/{pid}", {"phase": "build"})
    return store, ib, pid


def steps_of(store, pid):
    p = store.get(f"plans/{pid}")
    return {s["id"]: s for s in store.get(f"planVersions/{pid}_v{p['current']}")["parts"]["steps"]}


def gates(store, pid):
    return [i for i in store.where("inbox", "planId", pid) if i.get("stepGate")]


def answer(store, item_id, choice="", text=""):
    store.update(f"inbox/{item_id}", {"status": "answered", "answer": {"choice": choice, "text": text, "at": "x"}})


def run_gate_commands(store):
    out = []
    for c in store.where("commands", "action", "step_gate"):
        out.append(act(store, store.get(f"inbox/{c['inboxId']}"), "PC"))
        store.delete(f"commands/{c['id']}")
    return out


# A
def test_a_step_keeps_its_version_until_its_own_text_changes():
    store, ib, pid = make()
    assert {k: (s["v"], s["vSince"]) for k, s in steps_of(store, pid).items()} == {"s1": (1, 1), "s2": (1, 1), "s3": (1, 1)}
    ib.plan_version(pid, "", "rule only", patch={"rules": {"0": {"rule": "r", "source": "o"}}})
    assert {k: s["v"] for k, s in steps_of(store, pid).items()} == {"s1": 1, "s2": 1, "s3": 1}
    ib.plan_version(pid, "", "s2 changes", patch={"steps": {"s2": {"does": "new"}, "s4": {"title": "t4", "does": "", "check": ""}}})
    st = steps_of(store, pid)
    assert (st["s1"]["v"], st["s1"]["vSince"]) == (1, 1) and (st["s2"]["v"], st["s2"]["vSince"]) == (2, 3)
    assert (st["s4"]["v"], st["s4"]["vSince"]) == (1, 3)
    ib.plan_version(pid, "", "plain", phase="verify", order="move")  # a plain version keeps every step's version
    assert {k: s["v"] for k, s in steps_of(store, pid).items()} == {"s1": 1, "s2": 2, "s3": 1, "s4": 1}


def test_a_session_cannot_set_a_step_version_itself():
    store, ib, pid = make()
    ib.plan_version(pid, "", "try", patch={"steps": {"s1": {"v": 9}}})
    assert steps_of(store, pid)["s1"]["v"] == 1


def test_each_report_round_carries_the_step_version_it_ran_on():
    store, ib, pid = make()
    ib.step_update(pid, "s1", "now", "go")
    assert store.get(f"planSteps/{pid}_s1")["versions"][-1]["stepV"] == 1


# B
def test_a_done_step_needs_its_revise_before_the_next_step_starts():
    store, ib, pid = make()
    ib.step_update(pid, "s1", "failed", "broke", report=REP)
    assert "s1" in store.get(f"plans/{pid}")["reviseDue"]
    with pytest.raises(ValueError, match="Post the revise for s1 first"):
        ib.step_update(pid, "s2", "now", "go")
    cur = store.get(f"plans/{pid}")["current"]
    line = ib.plan_revise(pid, "s1", "the result keeps s2 and s3 as they are")
    assert "no change" in line and store.get(f"plans/{pid}")["current"] == cur  # no plan version
    rec = store.get(f"planRevises/{pid}_s1_r1")
    assert rec["change"] == "none" and rec["result"] == "failed" and rec["stepV"] == 1
    assert store.get(f"plans/{pid}")["reviseDue"] == {}
    ib.step_update(pid, "s2", "now", "go")


def test_a_revise_patches_only_later_steps_and_shows_each_version_change():
    store, ib, pid = make()
    ib.step_update(pid, "s2", "failed", "s2 found the API is v2", report=REP)
    for bad in ({"s1": {"does": "x"}}, {"s2": {"does": "x"}}):
        with pytest.raises(ValueError, match="only the steps after s2"):
            ib.plan_revise(pid, "s2", "why", bad)
    with pytest.raises(ValueError, match="give the fields"):
        ib.plan_revise(pid, "s2", "why", {"s3": {"v": 3}})
    cur = store.get(f"plans/{pid}")["current"]
    line = ib.plan_revise(pid, "s2", "the API is v2", {"s3": {"does": "use API v2"}})
    n = store.get(f"plans/{pid}")["current"]
    assert n == cur + 1 and "s3 v1→v2" in line
    rv = store.get(f"planVersions/{pid}_v{n}")["revise"]
    assert rv["after"] == "s2" and rv["why"] == "the API is v2" and rv["changed"] == [{"id": "s3", "from": 1, "to": 2}]
    assert steps_of(store, pid)["s1"]["v"] == 1 and steps_of(store, pid)["s3"]["v"] == 2
    assert store.get(f"planRevises/{pid}_s2_r1")["planVersion"] == n


def test_a_revise_needs_a_result_first():
    store, ib, pid = make()
    with pytest.raises(ValueError, match="no done or failed report"):
        ib.plan_revise(pid, "s1", "why")


# C
def test_done_with_no_check_and_no_picture_waits_and_a_written_ok_makes_it_done():
    store, ib, pid = make()
    ib.step_update(pid, "s1", "done", "built", report=REP)
    assert store.get(f"planSteps/{pid}_s1")["state"] == "checking"
    g = gates(store, pid)
    assert len(g) == 1 and g[0]["stepGate"]["kind"] == "none" and [o["label"] for o in g[0]["options"]] == [CHECKED, NOT_DONE]
    answer(store, g[0]["id"], text="ok")  # the owner's case: "I said ok or agree but the plan step still failed"
    deliver(store, "PC", None)
    assert not store.where("commands", "action", "message")  # the bridge acts, no session run
    run_gate_commands(store)
    st = store.get(f"planSteps/{pid}_s1")
    assert st["state"] == "done" and st["versions"][-1]["receipt"]["kind"] == "owner"
    assert store.get(f"inbox/{g[0]['id']}")["status"] == "closed"


def test_ok_on_the_step_result_card_answers_its_open_gate_question():
    store, ib, pid = make()
    ib.step_update(pid, "s1", "done", "built", report=REP)
    res = next(i for i in store.where("inbox", "planId", pid) if i["kind"] == "result")
    answer(store, res["id"], text="Agree")
    deliver(store, "PC", None)
    run_gate_commands(store)
    assert store.get(f"planSteps/{pid}_s1")["state"] == "done"
    assert store.get(f"inbox/{res['id']}")["status"] == "closed"


def test_other_text_with_no_button_asks_again_and_not_done_fails():
    store, ib, pid = make()
    ib.step_update(pid, "s1", "done", "built", report=REP)
    g = gates(store, pid)[0]
    answer(store, g["id"], text="hmm, maybe later")
    deliver(store, "PC", None)
    run_gate_commands(store)
    again = store.get(f"inbox/{g['id']}")
    assert again["status"] == "open" and "went to the plan's session" in again["error"]
    assert store.get(f"planSteps/{pid}_s1")["state"] == "checking"
    answer(store, g["id"], choice=NOT_DONE)
    deliver(store, "PC", None)
    run_gate_commands(store)
    assert store.get(f"planSteps/{pid}_s1")["state"] == "failed"


def test_tick_and_run_from_the_inbox_runs_the_check_and_settles_the_step():
    store, ib, pid = make()
    ib.step_update(pid, "s1", "done", "built", check_command="exit 0", report=REP)
    g = gates(store, pid)[0]
    assert g["stepGate"]["kind"] == "tick" and g["options"][0]["label"] == TICK
    answer(store, g["id"], choice=TICK)
    deliver(store, "PC", None)
    run_gate_commands(store)
    rec = store.get(f"planChecks/{pid}_s1")
    assert ticked(rec) and rec["tick"]["by"] == "owner-inbox"
    q = store.where("commands", "action", "step_check")
    assert len(q) == 1
    StepChecks(store, "PC", [("t", ROOT)], runner=fake(0)).start(q[0], wait=True)
    assert store.get(f"planSteps/{pid}_s1")["state"] == "done"


def test_auto_tick_is_off_by_default_and_on_it_runs_the_proposed_check():
    store, ib, pid = make()
    ib.step_update(pid, "s1", "now", "go", check_command="exit 0")
    assert not ticked(store.get(f"planChecks/{pid}_s1"))  # default off
    store.put_many({f"planPicks/{pid}": {"planId": pid, "autoTick": True}})
    ib.step_update(pid, "s1", "done", "built", report=REP)
    rec = store.get(f"planChecks/{pid}_s1")
    assert ticked(rec) and rec["tick"]["by"] == "auto"
    assert not gates(store, pid) and len(store.where("commands", "action", "step_check")) == 1


def test_an_unclear_picture_check_asks_the_owner_and_a_fail_still_fails():
    from agent_bridge.evidence import Evidence

    class R:
        machine, push, chains = "PC", None, None

    for overall, state, kinds in (("unclear", "checking", ["unclear"]), ("fail", "failed", [])):
        store, ib, pid = make()
        R.store = store
        ib.step_update(pid, "s1", "done", "built", report=REP)
        for g in gates(store, pid):  # the first gate (no picture) is not this test's
            store.update(f"inbox/{g['id']}", {"status": "closed"})
        Evidence(R()).finished({"id": "e1", "planId": pid, "stepId": "s1", "what": "check", "checkedPictures": []},
                               "done", '{"overall": "%s", "pictures": [], "note": "blurry"}' % overall)
        assert store.get(f"planSteps/{pid}_s1")["state"] == state
        assert [g["stepGate"]["kind"] for g in gates(store, pid) if g["status"] == "open"] == kinds


def test_an_ask_back_on_a_gate_question_goes_to_the_plan_session():
    # 2026-11-25: the gate question had sessionId "", so the owner's ask back "what is #149 which need me?" reached no
    # session and stayed unanswered; the owner's pick "Gắn phiên của plan khi tạo"
    store, ib, pid = make()
    ib.step_update(pid, "s1", "done", "built", report=REP)
    g = gates(store, pid)[0]
    assert g["sessionId"] == store.get(f"plans/{pid}")["sessionId"] == "s1"
    store.update(f"inbox/{g['id']}", {"thread": [{"who": "owner", "kind": "ask", "text": "what is #149?", "at": "t1"}]})
    deliver(store, "PC", "claude")
    runs = store.where("commands", "action", "message")
    assert len(runs) == 1 and runs[0]["sessionId"] == "s1" and runs[0]["askBackId"] == g["id"]
    answer(store, g["id"], text="ok")  # the answer still goes to the bridge, not to the session
    deliver(store, "PC", "claude")
    assert len(store.where("commands", "action", "message")) == 1 and store.where("commands", "action", "step_gate")


def test_an_ask_back_on_an_old_gate_question_without_session_goes_to_the_plan_session():
    # 2026-11-26: gate question f9847d5e was made before be53aea with sessionId ""; the owner asked again and nothing
    # ran (the owner's pick "Fallback + no window")
    store, ib, pid = make()
    ib.step_update(pid, "s1", "done", "built", report=REP)
    g = gates(store, pid)[0]
    store.update(f"inbox/{g['id']}", {"sessionId": "", "thread": [{"who": "owner", "kind": "ask", "text": "what is #149?", "at": "t1"}]})
    deliver(store, "PC", "claude")
    runs = store.where("commands", "action", "message")
    assert len(runs) == 1 and runs[0]["sessionId"] == "s1" and runs[0]["askBackId"] == g["id"]
    assert store.get(f"inbox/{g['id']}")["sessionId"] == "s1"


def test_an_ask_back_with_no_session_anywhere_is_logged_once():
    store, ib, pid = make()
    ib.step_update(pid, "s1", "done", "built", report=REP)
    g = gates(store, pid)[0]
    store.update(f"plans/{pid}", {"sessionId": ""})
    store.update(f"inbox/{g['id']}", {"sessionId": "", "thread": [{"who": "owner", "kind": "ask", "text": "what?", "at": "t1"}]})
    assert any("no session" in l for l in deliver(store, "PC", "claude"))
    assert not any("no session" in l for l in deliver(store, "PC", "claude"))
    assert not store.where("commands", "action", "message") and store.get(f"inbox/{g['id']}")["error"]


# 2026-11-27, the owner: "inbox message đang có lỗi, không gửi answer và không thấy chạy"
def test_written_words_with_no_button_on_a_gate_go_to_the_plan_session():
    store, ib, pid = make()
    ib.step_update(pid, "s1", "done", "built", report=REP)
    g = gates(store, pid)[0]
    answer(store, g["id"], text="resend the inbox, I don't see the work")
    deliver(store, "PC", "claude")
    run_gate_commands(store)
    deliver(store, "PC", "claude")  # the open question's ask back goes to the session
    runs = store.where("commands", "action", "message")
    assert len(runs) == 1 and runs[0]["sessionId"] == "s1" and "resend the inbox" in runs[0]["prompt"]
    assert store.get(f"planSteps/{pid}_s1")["state"] == "checking"


def test_reviewed_see_note_ok_on_the_result_card_answers_the_gate():
    store, ib, pid = make()
    ib.step_update(pid, "s1", "done", "built", report=REP)
    res = next(i for i in store.where("inbox", "planId", pid) if i["kind"] == "result")
    answer(store, res["id"], choice="Reviewed, see note", text="ok")
    deliver(store, "PC", "claude")
    run_gate_commands(store)
    assert store.get(f"planSteps/{pid}_s1")["state"] == "done"
    assert not store.where("commands", "action", "message")


def test_not_done_with_words_fails_the_step_and_starts_a_run_with_the_words():
    store, ib, pid = make()
    ib.step_update(pid, "s1", "done", "built", report=REP)
    g = gates(store, pid)[0]
    answer(store, g["id"], choice=NOT_DONE, text="where are the edited samples?")
    deliver(store, "PC", "claude")
    run_gate_commands(store)
    assert store.get(f"planSteps/{pid}_s1")["state"] == "failed"
    runs = store.where("commands", "action", "message")
    assert len(runs) == 1 and runs[0]["sessionId"] == "s1" and "where are the edited samples?" in runs[0]["prompt"]
    assert runs[0]["planId"] == pid and runs[0]["answerStep"] == "s1"


def test_not_done_without_words_starts_no_run():
    store, ib, pid = make()
    ib.step_update(pid, "s1", "done", "built", report=REP)
    g = gates(store, pid)[0]
    answer(store, g["id"], choice=NOT_DONE)
    deliver(store, "PC", "claude")
    run_gate_commands(store)
    assert store.get(f"planSteps/{pid}_s1")["state"] == "failed" and not store.where("commands", "action", "message")
