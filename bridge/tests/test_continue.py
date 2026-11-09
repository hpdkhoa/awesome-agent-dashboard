"""A run cut by the usage limit pauses; Continue and the auto continue at the reset do the leftover work (the owner's
words, 2026-11-09: "I need the continue button inside run tab and session tab to do the leftover work manually";
choice "Continue + auto at reset", note "auto only the last or the message I choose to auto restart when limit
lifted")."""
from datetime import datetime

from agent_bridge.runs import CONTINUE_NOTE, Runs, reset_time
from test_runs import cmd, setup, wait_done


def local(y, mo, d, h, mi=0):
    return datetime(y, mo, d, h, mi).astimezone()


def test_reset_time_is_the_next_such_local_time():
    msg = "You've hit your 5-hour limit · resets 5:30pm (Asia/Ho_Chi_Minh)"
    assert reset_time(msg, local(2026, 11, 9, 10)) == local(2026, 11, 9, 17, 30)
    assert reset_time(msg, local(2026, 11, 9, 18)) == local(2026, 11, 10, 17, 30)  # past today: tomorrow
    assert reset_time("resets 12am", local(2026, 11, 9, 23)) == local(2026, 11, 10, 0)
    assert reset_time("resets Nov 12, 5:30pm (UTC)", local(2026, 11, 9, 10)) == local(2026, 11, 12, 17, 30)
    assert reset_time("resets Jan 2 at 9am", local(2026, 12, 30, 10)) == local(2027, 1, 2, 9)
    assert reset_time("You've hit your limit", local(2026, 11, 9, 10)) is None


def test_a_limited_run_pauses_and_only_the_last_one_is_auto(tmp_path, monkeypatch):
    store, runs, work = setup(tmp_path, monkeypatch)
    cmd(store, "c1", action="start", folder=str(work), prompt="limit", createdAt="1")
    c = wait_done(runs, "c1", store)
    assert c["status"] == "paused" and c["pausedUntil"] == "5:30pm (Asia/Ho_Chi_Minh)" and c["pausedUntilAt"]
    assert c["autoContinue"] is True and c["autoBy"] == "last" and set(runs.auto) == {"c1"}
    cmd(store, "m1", action="message", sessionId="s9", cwd=str(work), prompt="do the limit", createdAt="2")
    c = wait_done(runs, "m1", store)
    assert c["status"] == "paused" and c["autoBy"] == "last"
    assert store.get("commands/c1")["autoContinue"] is False and set(runs.auto) == {"m1"}  # only the last one
    cmd(store, "a1", action="auto_continue", target="c1", on=True, createdAt="3")  # the owner's pick
    runs.step()
    assert store.get("commands/a1")["status"] == "done" and store.get("commands/c1")["autoBy"] == "owner"
    cmd(store, "m2", action="message", sessionId="s8", cwd=str(work), prompt="limit again", createdAt="4")
    wait_done(runs, "m2", store)
    assert set(runs.auto) == {"c1", "m2"}  # m1 (the earlier last) drops, the owner's pick stays
    assert Runs(store, "PC", runs.roots, "claude", tmp_path / "out2", logs=runs.logs)._auto_runs().keys() == {"c1", "m2"}

    for a in runs.auto.values():  # the reset time has come
        a["due"] = 0
    runs.popen = lambda *a, **k: (_ for _ in ()).throw(AssertionError("no run starts in this step"))
    log = runs.step([])
    assert sum("auto at the reset" in line for line in log) == 2 and runs.auto == {}
    new = {x["continueOf"]: x for x in store.where("commands", "status", "new") if x.get("continueOf")}
    assert new.keys() == {"c1", "m2"}
    assert new["c1"]["action"] == "start" and new["c1"]["prompt"] == "limit"  # its session never got a log
    assert new["m2"]["action"] == "message" and new["m2"]["sessionId"] == "s8"
    assert new["m2"]["prompt"] == CONTINUE_NOTE + "limit again"
    assert store.get("commands/c1")["continuedBy"] == new["c1"]["id"] and store.get("commands/m1").get("continuedBy") is None


def test_continue_button_and_its_refusals(tmp_path, monkeypatch):
    store, runs, work = setup(tmp_path, monkeypatch)
    cmd(store, "m1", action="message", sessionId="s9", cwd=str(work), prompt="limit", kind="goal", planId="p1",
        inboxId="i1", createdAt="1")
    wait_done(runs, "m1", store)
    cmd(store, "k1", action="continue", target="m1", createdAt="2")
    runs.step()
    k = store.get("commands/k1")
    n = store.get(f"commands/{k['continuedAs']}")
    assert k["status"] == "done" and n["continueOf"] == "m1" and n["kind"] == "goal" and n["inboxId"] == "i1"
    assert n["prompt"] == CONTINUE_NOTE + "limit" and n["sessionId"] == "s9"
    assert store.get("commands/m1")["autoContinue"] is False and runs.auto == {}
    cmd(store, "k2", action="continue", target="m1", createdAt="3")  # twice
    cmd(store, "d1", action="start", folder=str(work), prompt="hello", createdAt="4")
    wait_done(runs, "d1", store)
    cmd(store, "k3", action="continue", target="d1", createdAt="5")  # a finished run
    cmd(store, "a1", action="auto_continue", target="d1", on=True, createdAt="6")
    runs.step()
    assert "Already continued" in store.get("commands/k2")["error"]
    assert "Only a paused run" in store.get("commands/k3")["error"]
    assert store.get("commands/a1")["status"] == "failed"
    wait_done(runs, n["id"], store)  # the continued message hits the limit again: paused again, the new last one
    assert store.get(f"commands/{n['id']}")["status"] == "paused" and set(runs.auto) == {n["id"]}
    cmd(store, "k4", action="continue", target=n["id"], createdAt="7")
    runs.step()
    again = store.get(f"commands/{store.get('commands/k4')['continuedAs']}")
    assert again["prompt"] == CONTINUE_NOTE + "limit"  # the note is never doubled
