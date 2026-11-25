"""F4, done needs a receipt (plan bf73af63; the owner's picks 2026-11-13: "Check or checked pictures", "Badge only";
2026-11-19: "Done waits for its receipt", "All done before F4 without receipt")."""
import os

import pytest

from agent_bridge.chain import Chains
from agent_bridge.evidence import queue
from agent_bridge.inbox import Inbox
from agent_bridge.stepcheck import StepChecks
from test_chain import Push, plan
from test_evidence import PNG, make, wait
from test_inbox import FakeStore
from test_stepcheck import REP, ROOT, cmd, fake, setup


def test_done_with_neither_a_ticked_check_nor_a_picture_waits_and_asks_the_owner():
    store = FakeStore()
    setup(store, tick=False)
    ib = Inbox(store, "PC", [("t", ROOT)], "s1", ROOT)
    ib.step_update("p1", "S1", "done", "built", report=REP, evidence=["gone.png"])
    st = store.get("planSteps/p1_S1")
    assert st["state"] == "checking" and st["versions"][-1]["receiptBy"] == "owner"
    assert not store.where("commands", "action", "step_check")
    gate = [i for i in store.where("inbox", "planId", "p1") if i.get("stepGate")]
    assert len(gate) == 1 and gate[0]["sessionId"] == "" and "were not found" in gate[0]["text"]


def test_done_with_a_ticked_check_waits_then_exit_0_gives_the_receipt():
    store = FakeStore()
    setup(store)
    ib = Inbox(store, "PC", [("t", ROOT)], "s1", ROOT)
    ib.step_update("p1", "S1", "done", "built", report=REP)
    st = store.get("planSteps/p1_S1")
    assert st["state"] == "checking" and st["versions"][-1]["receiptBy"] == "check"
    StepChecks(store, "PC", [("t", ROOT)], runner=fake(0, "ok 5 tests\n")).start(cmd(store, "done"), wait=True)
    st = store.get("planSteps/p1_S1")
    r = st["versions"][-1]["receipt"]
    assert st["state"] == "done" and r["kind"] == "check" and r["exit"] == 0 and r["output"] == "ok 5 tests"
    assert r["command"] == "exit 0" and r["at"] and r["commit"]  # tests/ sits in the dashboard's git repo


def test_done_with_a_ticked_check_that_fails_turns_failed_and_stops_the_chain():
    store, push = FakeStore(), Push()
    setup(store)
    ch = Chains(store, "PC", push)
    ch.resume()
    run = store.get("planChains/p1")["runId"]
    Inbox(store, "PC", [("t", ROOT)], "s1", ROOT).step_update("p1", "S1", "done", "built", report=REP)
    store.update(f"commands/{run}", {"status": "done"})
    assert ch.after({"planId": "p1"}) is None  # checking: the chain waits
    StepChecks(store, "PC", [("t", ROOT)], ch, push, runner=fake(1, "1 failed\n")).start(cmd(store, "done"), wait=True)
    st = store.get("planSteps/p1_S1")
    assert st["state"] == "failed" and "receipt" not in st["versions"][-1] and "exit 1" in st["versions"][-1]["reply"]
    assert store.get("planChains/p1")["state"] == "stopped"


def test_a_check_that_cannot_run_asks_the_owner_and_the_step_waits():
    store = FakeStore()
    setup(store, cwd="C:/Windows")
    store.update("plans/p1", {"cwd": ROOT})
    Inbox(store, "PC", [("t", ROOT)], "s1", ROOT).step_update("p1", "S1", "done", "built", report=REP)
    store.update("plans/p1", {"cwd": "C:/Windows"})
    StepChecks(store, "PC", [("t", ROOT)], runner=fake(0)).start(cmd(store, "done"), wait=True)
    st = store.get("planSteps/p1_S1")
    gate = [i for i in store.where("inbox", "planId", "p1") if i.get("stepGate")]
    assert st["state"] == "checking" and len(gate) == 1 and gate[0]["stepGate"]["kind"] == "refused"
    assert "not inside a work folder" in gate[0]["text"]


def test_a_chain_with_only_checking_steps_left_waits_instead_of_ending():
    store, push = FakeStore(), Push()
    plan(store)
    for s in ("S1", "S2", "S3"):
        store.put_many({f"planSteps/p1_{s}": {"planId": "p1", "stepId": s, "state": "done" if s != "S3" else "checking"}})
    ch = Chains(store, "PC", push)
    assert ch.after({"planId": "p1"}) is None and store.get("planChains/p1")["state"] == "on"
    store.update("planSteps/p1_S3", {"state": "done"})
    ch.after({"planId": "p1"})
    assert store.get("planChains/p1")["state"] == "done"


def _pictures_done(tmp_path, title):
    store, runs, work = make(tmp_path, None, step_title=title)
    store.put_many({"planSteps/p1_S1": {"planId": "p1", "stepId": "S1", "state": "now", "versions": [{"n": 1, "state": "now", "reply": "x"}]}})
    (work / "a.png").write_bytes(PNG)
    Inbox(store, "PC", [], "s1", str(work)).step_update("p1", "S1", "done", "built", report=REP, evidence=["a.png"])
    st = store.get("planSteps/p1_S1")
    assert st["state"] == "checking" and st["versions"][-1]["receiptBy"] == "pictures"
    c = next(c for c in store.where("commands", "action", "evidence"))
    assert c["what"] == "check" and c["trigger"] == "receipt"
    wait(runs, store, c["id"])
    return store


def test_pictures_only_the_llm_check_pass_gives_the_receipt(tmp_path):
    store = _pictures_done(tmp_path, "passme")
    st = store.get("planSteps/p1_S1")
    r = st["versions"][-1]["receipt"]
    assert st["state"] == "done" and r["kind"] == "pictures" and r["overall"] == "pass" and r["pictures"][0].endswith("a.png")
    assert r["findings"] == store.get("planEvidence/p1_S1")["check"]["findings"]  # F5: the receipt keeps the findings


def test_pictures_only_the_llm_check_fail_turns_failed(tmp_path):
    store = _pictures_done(tmp_path, "step 1")
    st = store.get("planSteps/p1_S1")
    assert st["state"] == "failed" and "LLM check of the pictures: fail" in st["versions"][-1]["reply"]


def test_the_page_button_llm_check_on_a_done_step_still_marks_only(tmp_path):
    store, runs, work = make(tmp_path, None)
    (work / "a.png").write_bytes(PNG)
    from agent_bridge.evidence import on_done
    on_done(store, store.get("plans/p1"), "S1", ["a.png"], 1, "PC")
    wait(runs, store, queue(store, store.get("plans/p1"), "S1", "check", "button", "PC"))
    assert store.get("planSteps/p1_S1")["state"] == "done"  # "Mark only" for a step not waiting


def test_owner_receipt_turns_a_reported_step_done_and_refuses_one_never_reported():
    # the owner, 2026-11-22, plan 41188c93: "option C": a check only a person can run gets the owner's word as receipt
    from agent_bridge.stepcheck import owner_confirm
    store = FakeStore()
    setup(store, tick=False)
    pl = {**store.get("plans/p1"), "id": "p1"}
    with pytest.raises(ValueError, match="not started"):
        owner_confirm(store, pl, "S1", "iPhone ok")
    store.put_many({"planSteps/p1_S1": {"id": "p1_S1", "planId": "p1", "stepId": "S1", "state": "failed", "versions": [
        {"n": 1, "state": "checking", "receiptBy": "pictures", "reply": "built"},
        {"n": 2, "state": "failed", "by": "llm", "reply": "- No receipt: picture unclear"}]}})
    r = owner_confirm(store, pl, "S1", "iPhone ok")
    st = store.get("planSteps/p1_S1")
    assert st["state"] == "done" and st["versions"][-1]["by"] == "owner" and r["kind"] == "owner" and r["note"] == "iPhone ok"
    with pytest.raises(ValueError, match="is done"):
        owner_confirm(store, pl, "S1", "again")  # only a step waiting for or failing its receipt
    store.put_many({"planSteps/p1_S2": {"id": "p1_S2", "planId": "p1", "stepId": "S2", "state": "failed",
                                        "versions": [{"n": 1, "state": "failed", "reply": "check failed"}]}})
    with pytest.raises(ValueError, match="reported done"):
        owner_confirm(store, pl, "S2", "x")  # failed without a done report: no receipt by word
