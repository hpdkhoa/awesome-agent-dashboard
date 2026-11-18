"""Run all steps (chain.py; the owner's words, 2026-11-10: "an automatic job or way to start all the steps without need
me to press every single one"; picks "Chain, stop on fail", "Button only"; note "when resume or restart just work on
the remaining not done items, if the item is out dated then I'll be the one press rerun manually")."""
from agent_bridge.chain import Chains, harness_note, item_hash

HARNESS = [{"id": "h1", "kind": "tool", "item": "pytest"}, {"id": "h2", "kind": "check", "item": "build passes"}]
from test_inbox import FakeStore


class Push:
    def __init__(self):
        self.sent = []

    def notify(self, title, body, url="/", tag=""):
        self.sent.append((title, body))
        return 1


def plan(store, phase="build", done=()):
    steps = [{"id": f"S{i}", "title": f"step {i}", "does": "", "check": ""} for i in (1, 2, 3)]
    store.put_many({
        "plans/p1": {"id": "p1", "title": "T", "machine": "PC", "sessionId": "s1", "cwd": "K:/w", "current": 2, "phase": phase, "kind": "parts"},
        "planVersions/p1_v2": {"parts": {"steps": steps}, "harness": HARNESS},
        "planHarness/p1": {"items": {"h1": {"ok": True, "hash": item_hash(HARNESS[0])}}},
        "planChains/p1": {"planId": "p1", "machine": "PC", "state": "on", "model": "opus"},
    })
    for s in done:  # done on an older plan version: an outdated step, still done for the chain
        report(store, s, "done")


def report(store, step, state):
    store.put_many({f"planSteps/p1_{step}": {"planId": "p1", "stepId": step, "state": state}})


def end(store, ch, status):  # ch: unused, reads well at the call
    store.update(f"commands/{store.get('planChains/p1')['runId']}", {"status": status})


def test_runs_the_steps_not_done_in_order_then_done():
    store, push = FakeStore(), Push()
    plan(store, done=("S1",))
    ch = Chains(store, "PC", push)
    ch.resume()
    c = store.get("planChains/p1")
    run = store.get(f"commands/{c['runId']}")
    assert c["stepId"] == "S2" and run["stepId"] == "S2" and run["sessionId"] == "s1" and run["model"] == "opus"
    assert run["prompt"] == "Work on step S2: step 2. Report it with step_update. Use only the approved harness items: h1. Not approved, left out: h2."
    assert ch.resume() == []  # the run is new: wait
    report(store, "S2", "done")
    end(store, ch, "done")
    ch.resume()
    assert store.get("planChains/p1")["stepId"] == "S3"
    report(store, "S3", "done")
    end(store, ch, "done")
    ch.resume()
    assert store.get("planChains/p1")["state"] == "done" and push.sent[-1][0] == "All steps done: T"


def test_stops_on_a_failed_report_a_failed_run_or_no_done_report():
    for status, rep, why in (("done", "failed", "reported it failed"), ("failed", "now", "the run failed"),
                             ("done", "now", "no done report"), ("stopped", None, "the run stopped")):
        store, push = FakeStore(), Push()
        plan(store)
        ch = Chains(store, "PC", push)
        ch.resume()
        if rep:
            report(store, "S1", rep)
        end(store, ch, status)
        ch.resume()
        c = store.get("planChains/p1")
        assert c["state"] == "stopped" and why in c["reason"] and c["stepId"] == "S1", (status, rep, c)
        assert push.sent[-1][0] == "Run all steps stopped: T"


def test_a_run_lost_to_a_restart_goes_on_with_that_step():
    store = FakeStore()
    plan(store)
    ch = Chains(store, "PC")
    ch.resume()
    first = store.get("planChains/p1")["runId"]
    end(store, ch, "lost")
    ch.resume()
    c = store.get("planChains/p1")
    assert c["state"] == "on" and c["stepId"] == "S1" and c["runId"] != first


def test_a_paused_run_waits_then_follows_its_continue():
    store = FakeStore()
    plan(store)
    ch = Chains(store, "PC")
    ch.resume()
    first = store.get("planChains/p1")["runId"]
    store.update(f"commands/{first}", {"status": "paused"})
    assert ch.resume() == []
    store.put_many({"commands/k2": {"id": "k2", "status": "running"}})
    store.update(f"commands/{first}", {"continuedBy": "k2"})
    assert ch.resume() == [] and store.get("planChains/p1")["runId"] == "k2"


def test_explore_and_other_machines():
    store = FakeStore()
    plan(store, phase="explore")
    Chains(store, "PC").resume()
    assert store.get("planChains/p1")["state"] == "stopped"
    store2 = FakeStore()
    plan(store2)
    assert Chains(store2, "OTHER").resume() == []


def test_the_button_command_starts_and_a_second_press_is_refused():
    store = FakeStore()
    plan(store)
    store.update("planChains/p1", {"state": "stopped"})
    ch = Chains(store, "PC")
    store.put_many({"commands/b1": {"id": "b1", "action": "chain", "planId": "p1", "effort": "high"}})
    ch.start(store.get("commands/b1"))
    c = store.get("planChains/p1")
    assert c["state"] == "on" and c["stepId"] == "S1" and store.get(f"commands/{c['runId']}")["effort"] == "high"
    assert store.get("commands/b1")["status"] == "done"
    store.put_many({"commands/b2": {"id": "b2", "action": "chain", "planId": "p1"}})
    ch.start(store.get("commands/b2"))
    assert store.get("commands/b2")["status"] == "failed" and store.get("planChains/p1")["runId"] == c["runId"]


def test_the_bridge_moves_the_chain_when_a_chain_run_ends(tmp_path, monkeypatch):
    from test_runs import setup, wait_done

    store, runs, work = setup(tmp_path, monkeypatch)
    plan(store)
    store.update("plans/p1", {"cwd": str(work), "sessionId": "s9"})
    runs.chains.resume()
    first = store.get("planChains/p1")["runId"]
    report(store, "S1", "done")
    wait_done(runs, first, store)
    assert store.get("planChains/p1")["stepId"] == "S2"
    assert store.get("planChains/p1")["runId"] != first


def test_the_harness_note_matches_the_page_and_is_read_at_each_step():
    # the same hashes as web/src/harness.ts itemHash (FNV-1a over "kind:item")
    assert item_hash({"kind": "tool", "item": ""}) == "38469847"  # node, web/src/harness.ts itemHash
    assert item_hash({"kind": "check", "item": "build đ 😀"}) == "0e01b142"  # code points, not UTF-16 units
    assert harness_note([], None) == ""
    assert harness_note(HARNESS, None) == " Use only the approved harness items: none. Not approved, left out: h1, h2."
    changed = {"items": {"h1": {"ok": True, "hash": "00000000"}}}  # ticked, then its text changed
    assert harness_note(HARNESS[:1], changed) == " Use only the approved harness items: none. Not approved, left out: h1."
    store = FakeStore()
    plan(store)
    ch = Chains(store, "PC")
    ch.resume()
    report(store, "S1", "done")
    store.update("planHarness/p1", {"items": {"h1": {"ok": True, "hash": item_hash(HARNESS[0])},
                                              "h2": {"ok": True, "hash": item_hash(HARNESS[1])}}})  # ticked mid-chain
    end(store, ch, "done")
    ch.resume()
    run = store.get(f"commands/{store.get('planChains/p1')['runId']}")
    assert run["stepId"] == "S2" and run["prompt"].endswith("approved harness items: h1, h2.")


def test_each_step_runs_with_its_own_pick():
    """Per-step picks (the owner's pick, 2026-11-16: "Bar + per-step picks table"): a step's own row wins over the
    chain's pick; a step with no row keeps the chain's pick; "auto" handoff sends nothing (the Runs tab rule)."""
    store = FakeStore()
    plan(store)
    store.put_many({"planPicks/p1": {"planId": "p1", "steps": {
        "S1": {"runner": "claude", "model": "claude-sonnet-5-5", "effort": "high", "fresh": "always"},
        "S2": {"runner": "claude", "effort": "low", "fresh": "auto"}}}})
    ch = Chains(store, "PC", Push())
    ch.resume()
    run = store.get(f"commands/{store.get('planChains/p1')['runId']}")
    assert (run["stepId"], run["model"], run["effort"], run["fresh"]) == ("S1", "claude-sonnet-5-5", "high", "always")
    report(store, "S1", "done")
    end(store, ch, "done")
    ch.resume()
    run = store.get(f"commands/{store.get('planChains/p1')['runId']}")
    assert (run["stepId"], run["model"], run["effort"]) == ("S2", "opus", "low") and "fresh" not in run
    report(store, "S2", "done")
    end(store, ch, "done")
    ch.resume()
    run = store.get(f"commands/{store.get('planChains/p1')['runId']}")
    assert run["stepId"] == "S3" and run["model"] == "opus" and "effort" not in run


def test_a_non_claude_runner_stops_the_chain():
    store, push = FakeStore(), Push()
    plan(store)
    store.put_many({"planPicks/p1": {"planId": "p1", "steps": {"S1": {"runner": "local", "model": "qwen3:14b"}}}})
    Chains(store, "PC", push).resume()
    c = store.get("planChains/p1")
    assert c["state"] == "stopped" and "Claude only" in c["reason"] and not c.get("runId")



def test_ticked_steps_run_together_up_to_max_then_in_order():
    """Async (the owner's pick, 2026-11-16: "Marked steps run together, max N"): S1 and S2 ticked, max 2, S3 not ticked.
    S1 and S2 start at once, each in its own fresh session; S3 waits until both end."""
    store = FakeStore()
    plan(store)
    store.put_many({"planPicks/p1": {"planId": "p1", "maxTogether": 2, "steps": {"S1": {"together": True}, "S2": {"together": True}}}})
    ch = Chains(store, "PC", Push())
    ch.resume()
    c = store.get("planChains/p1")
    assert sorted(c["running"]) == ["S1", "S2"]
    for s in ("S1", "S2"):
        r = store.get(f"commands/{c['running'][s]}")
        assert r["fresh"] == "always" and r["side"] is True
    report(store, "S1", "done")
    store.update(f"commands/{c['running']['S1']}", {"status": "done"})
    ch.resume()
    assert sorted(store.get("planChains/p1")["running"]) == ["S2"]  # S3 runs alone: waits for S2
    report(store, "S2", "done")
    store.update(f"commands/{c['running']['S2']}", {"status": "done"})
    ch.resume()
    c = store.get("planChains/p1")
    assert list(c["running"]) == ["S3"] and "side" not in store.get(f"commands/{c['running']['S3']}")


def test_max_n_caps_how_many_go_at_once():
    store = FakeStore()
    plan(store)
    store.put_many({"planPicks/p1": {"planId": "p1", "maxTogether": 2, "steps": {s: {"together": True} for s in ("S1", "S2", "S3")}}})
    ch = Chains(store, "PC", Push())
    ch.resume()
    c = store.get("planChains/p1")
    assert sorted(c["running"]) == ["S1", "S2"]
    report(store, "S1", "done")
    store.update(f"commands/{c['running']['S1']}", {"status": "done"})
    ch.resume()
    assert sorted(store.get("planChains/p1")["running"]) == ["S2", "S3"]


def test_a_heavy_step_runs_alone_even_when_ticked():
    """The owner's pick, 2026-11-16: "Heavy tick: runs alone"."""
    store = FakeStore()
    plan(store)
    store.put_many({"planPicks/p1": {"planId": "p1", "maxTogether": 3, "steps": {
        "S1": {"together": True, "heavy": True}, "S2": {"together": True}, "S3": {"together": True}}}})
    ch = Chains(store, "PC", Push())
    ch.resume()
    c = store.get("planChains/p1")
    assert list(c["running"]) == ["S1"] and "side" not in store.get(f"commands/{c['running']['S1']}")
    report(store, "S1", "done")
    store.update(f"commands/{c['running']['S1']}", {"status": "done"})
    ch.resume()
    assert sorted(store.get("planChains/p1")["running"]) == ["S2", "S3"]


def test_a_fail_stops_new_starts_and_the_running_ones_finish():
    store, push = FakeStore(), Push()
    plan(store)
    store.put_many({"planPicks/p1": {"planId": "p1", "maxTogether": 2, "steps": {s: {"together": True} for s in ("S1", "S2", "S3")}}})
    ch = Chains(store, "PC", push)
    ch.resume()
    c = store.get("planChains/p1")
    report(store, "S1", "failed")
    store.update(f"commands/{c['running']['S1']}", {"status": "done"})
    ch.resume()
    c = store.get("planChains/p1")
    assert c["state"] == "on" and list(c["running"]) == ["S2"] and "reported it failed" in c["failing"]
    report(store, "S2", "done")
    store.update(f"commands/{c['running']['S2']}", {"status": "done"})
    ch.resume()
    c = store.get("planChains/p1")
    assert c["state"] == "stopped" and c["stepId"] == "S1" and "reported it failed" in c["reason"]
    assert not any(k.startswith("commands/") and v.get("stepId") == "S3" for k, v in store.docs.items())


def test_step_text_carries_the_step_and_its_check():
    """G1 (the owner, 2026-11-18: "all 5 gap, fix one by one"): the message has the step's text and check, not only the title."""
    from agent_bridge.chain import step_text
    st = {"id": "s3", "title": "Add plan_get", "does": "Return the current version's parts\n and harness", "check": "pytest passes."}
    assert step_text(st, " H.") == ("Work on step s3: Add plan_get. The step: Return the current version's parts and harness."
                                    " Its check: pytest passes. Report it with step_update. H.")
    assert step_text({"id": "s1", "title": "x", "does": " ", "check": ""}) == "Work on step s1: x. Report it with step_update."
