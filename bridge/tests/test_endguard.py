"""F11 run end guard (plan bf73af63; the owner's picks 2026-11-19 "Start F11, build now", "No report this run")."""
from agent_bridge.endguard import flag, promises
from test_inbox import FakeStore
from test_runs import cmd, setup, wait_done


def test_promise_lines_are_found_and_cleaned():
    text = "- **F8 built.**\n- Your note says \"start new run\", so I'll do these 3 things in the next run.\n- I will rerun it.\nDone."
    assert promises(text) == ["Your note says \"start new run\", so I'll do these 3 things in the next run.", "I will rerun it."]
    assert promises("I'm going to check.\nI am going to wait.") == ["I'm going to check.", "I am going to wait."]
    assert promises("Willow is ill. Ill will. It will run.") == []


def test_a_step_run_without_a_report_is_flagged_and_one_with_a_report_is_not():
    store = FakeStore()
    c = {"action": "message", "planId": "P", "stepId": "F11", "startedAt": "2026-11-19T09:00:00+00:00"}
    assert flag(store, c, "Built.", "2026-11-19T09:30:00+00:00") == {"openStep": "F11", "at": "2026-11-19T09:30:00+00:00"}
    store.put_many({"planSteps/P_F11": {"versions": [{"at": "2026-11-19T08:00:00+00:00"}]}})  # before the run: not this run's
    assert flag(store, c, "Built.", "2026-11-19T09:30:00+00:00")["openStep"] == "F11"
    store.docs["planSteps/P_F11"]["versions"].append({"at": "2026-11-19T09:20:00+00:00"})
    assert flag(store, c, "Built.", "2026-11-19T09:30:00+00:00") is None
    assert flag(store, {**c, "kind": "qa"}, "ok", "2026-11-19T09:30:00+00:00") is None  # Ask on a step is no Run step
    assert flag(store, {"action": "message"}, "ok", "x") is None


def test_a_run_ending_on_i_will_shows_the_flag_on_its_row(tmp_path, monkeypatch):
    store, runs, work = setup(tmp_path, monkeypatch)
    cmd(store, "c1", action="start", folder=str(work), prompt="I will finish the check tomorrow")
    cmd(store, "c2", action="start", folder=str(work), prompt="all finished")
    wait_done(runs, "c1", store)
    wait_done(runs, "c2", store)
    g = store.get("commands/c1")["endGuard"]
    assert g["promise"] == ["did: I will finish the check tomorrow in work"] and "openStep" not in g
    assert "endGuard" not in store.get("commands/c2")
