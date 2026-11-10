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
