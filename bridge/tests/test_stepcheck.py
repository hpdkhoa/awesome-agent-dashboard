"""Step check runner (stepcheck.py, step i8; the owner's picks 2026-11-12: "Session proposes, you edit + tick", "On
done + a Run check button", "Step turns failed, chain stops", "PowerShell, plan folder, 10 min")."""
import os

from agent_bridge.chain import Chains
from agent_bridge.inbox import Inbox
from agent_bridge.stepcheck import StepChecks, check_hash, inside, run_command, tail, ticked
from test_chain import Push, plan, report
from test_inbox import FakeStore

ROOT = os.path.dirname(os.path.abspath(__file__))


def setup(store, cmd="exit 0", tick=True, cwd=ROOT):
    plan(store)
    store.update("plans/p1", {"cwd": cwd})
    rec = {"planId": "p1", "stepId": "S1", "command": cmd, "state": "idle"}
    if tick:
        rec["tick"] = {"ok": True, "hash": check_hash(cmd), "at": "x"}
    store.put_many({"planChecks/p1_S1": rec})


def fake(code, out="line\n"):
    return lambda cmd, cwd: (code, out, 0.1)


def cmd(store, trigger="button"):
    store.put_many({"commands/c1": {"id": "c1", "action": "step_check", "machine": "PC", "planId": "p1", "stepId": "S1", "trigger": trigger, "status": "new"}})
    return store.get("commands/c1")


def test_tick_holds_the_hash_so_an_edited_command_is_unticked():
    rec = {"command": "npm test", "tick": {"ok": True, "hash": check_hash("npm test")}}
    assert ticked(rec)
    assert not ticked({**rec, "command": "npm test -- --bail"})
    assert not ticked({"command": "", "tick": rec["tick"]})


def test_runs_only_a_ticked_command_inside_work_roots():
    for kw, why in (({"tick": False}, "not ticked"), ({"cwd": "C:/Windows"}, "not inside a work folder")):
        store = FakeStore()
        setup(store, **kw)
        chk = StepChecks(store, "PC", [("t", ROOT)], runner=fake(0))
        line = chk.start(cmd(store), wait=True)
        assert why in line and store.get("commands/c1")["status"] == "failed"
        assert "last" not in store.get("planChecks/p1_S1")


def test_a_pass_keeps_the_output_and_exit_code_and_the_step_stays_done():
    store = FakeStore()
    setup(store)
    report(store, "S1", "done")
    StepChecks(store, "PC", [("t", ROOT)], runner=fake(0, "ok 5 tests\n")).start(cmd(store, "done"), wait=True)
    rec = store.get("planChecks/p1_S1")
    assert rec["state"] == "idle" and rec["last"]["exit"] == 0 and rec["last"]["tail"] == "ok 5 tests" and rec["last"]["trigger"] == "done"
    assert store.get("planSteps/p1_S1")["state"] == "done"


def test_a_fail_after_done_turns_the_step_failed_and_stops_the_chain():
    store, push = FakeStore(), Push()
    setup(store)
    ch = Chains(store, "PC", push)
    ch.resume()  # S1 sent
    run = store.get("planChains/p1")["runId"]
    store.put_many({"planSteps/p1_S1": {"planId": "p1", "stepId": "S1", "state": "done", "versions": [{"n": 1, "state": "done"}]}})
    store.update("planChecks/p1_S1", {"state": "queued"})
    store.update(f"commands/{run}", {"status": "done"})
    assert ch.after({"planId": "p1"}) is None  # waits for the check
    StepChecks(store, "PC", [("t", ROOT)], ch, push, runner=fake(1, "1 failed\n")).start(cmd(store, "done"), wait=True)
    st = store.get("planSteps/p1_S1")
    assert st["state"] == "failed" and st["versions"][-1]["by"] == "check" and "exit 1" in st["versions"][-1]["reply"]
    c = store.get("planChains/p1")
    assert c["state"] == "stopped" and "its check failed" in c["reason"]
    assert any(t.startswith("Check failed") for t, _ in push.sent)


def test_a_done_report_queues_a_ticked_check_and_a_proposal_unticks_a_changed_command():
    store = FakeStore()
    setup(store, cmd="npm test")
    ib = Inbox(store, "PC", [("t", ROOT)], "s1", ROOT)
    ib.step_update("p1", "S1", "done", "built")
    q = [c for c in store.where("commands", "action", "step_check")]
    assert len(q) == 1 and q[0]["trigger"] == "done" and store.get("planChecks/p1_S1")["state"] == "queued"
    ib.step_update("p1", "S1", "now", "again", check_command="npm test -- --bail")
    rec = store.get("planChecks/p1_S1")
    assert rec["command"] == "npm test -- --bail" and rec["proposedBy"] == "session" and not ticked(rec)
    ib.step_update("p1", "S1", "done", "built")
    assert len(store.where("commands", "action", "step_check")) == 1  # not ticked: nothing queued


def test_powershell_runs_in_the_folder_with_exit_code_and_timeout():
    code, out, _ = run_command("Write-Output (Get-Location).Path; exit 3", ROOT)
    assert code == 3 and out.strip().lower() == ROOT.lower()
    code, out, secs = run_command("Start-Sleep -Seconds 20", ROOT, timeout=2)
    assert code is None and secs < 15
    assert inside(ROOT, [("t", os.path.dirname(ROOT))]) and not inside("C:/Windows", [("t", ROOT)])
    assert tail("\n".join(str(i) for i in range(300))).split("\n")[0] == "100"
