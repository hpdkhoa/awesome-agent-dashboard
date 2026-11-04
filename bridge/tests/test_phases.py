"""The plan's phases (the owner's words, 2026-11-04): every plan starts in Explore; only the owner moves a phase,
forward or back; each move is a plain plan version, and every version carries its phase."""

import pytest

from agent_bridge.inbox import Inbox
from test_inbox import FakeStore

PARTS = {"goal": "g (#1)", "summary": "- s (#2)", "rules": [{"rule": "r", "source": "#1"}],
         "lessons": [{"lesson": "l", "taught_by": "#3", "applied_in": "x"}], "leftover": ["o"],
         "steps": [{"id": "s1", "title": "t", "does": "d", "check": "c"}]}


def owner_message(store, text):
    store.put_many({"commands/m1": {"id": "m1", "action": "message", "sessionId": "s1", "status": "running",
                                    "prompt": text, "ownerText": text, "startedAt": "t"}})


def test_every_plan_starts_in_explore_and_its_first_version_says_so():
    store = FakeStore()
    pid = Inbox(store, "PC", [], "s1", "/x").plan_start("p", parts=PARTS)
    assert store.docs[f"plans/{pid}"]["phase"] == "explore"
    assert store.docs[f"planVersions/{pid}_v1"]["phase"] == "explore"


def test_a_phase_moves_only_on_the_owners_order_as_a_plain_version():
    store = FakeStore()
    ib = Inbox(store, "PC", [], "s1", "/x")
    pid = ib.plan_start("p", parts=PARTS)
    with pytest.raises(ValueError, match="Only the owner moves a phase"):
        ib.plan_version(pid, "", "move", phase="build")
    owner_message(store, "Move the plan to Build.")
    n = ib.plan_version(pid, "", "Build, on the owner's order", phase="build")
    v = store.docs[f"planVersions/{pid}_v{n}"]
    assert n == 2 and v["phase"] == "build" and store.docs[f"plans/{pid}"]["phase"] == "build"
    assert v["phaseMove"] == {"from": "explore", "to": "build", "order": "Move the plan to Build."}
    assert v["parts"] == store.docs[f"planVersions/{pid}_v1"]["parts"]  # plain: the data is kept
    assert v["text"] == store.docs[f"planVersions/{pid}_v1"]["text"]


def test_a_rollback_to_an_earlier_phase_and_other_versions_keep_the_phase():
    store = FakeStore()
    ib = Inbox(store, "PC", [], "s1", "/x")
    pid = ib.plan_start("p", parts=PARTS)
    ib.plan_version(pid, "", "to verify", phase="verify", order="go to Verify")
    n = ib.plan_version(pid, "", "back", phase="explore", order="roll back to Explore")
    assert store.docs[f"planVersions/{pid}_v{n}"]["phaseMove"]["to"] == "explore"
    owner_message(store, "add a rule")
    n = ib.plan_version(pid, "", "a rule", parts=PARTS)  # a data change keeps the phase
    assert store.docs[f"planVersions/{pid}_v{n}"]["phase"] == "explore" and "phaseMove" not in store.docs[f"planVersions/{pid}_v{n}"]
    with pytest.raises(ValueError, match="no phase"):
        ib.plan_version(pid, "", "x", phase="ship", order="ship it")


def test_the_harness_list_rides_on_every_version_until_it_changes():
    store = FakeStore()
    ib = Inbox(store, "PC", [], "s1", "/x")
    h = [{"id": "h1", "item": "tests/test_delete.py written, fails now", "kind": "check"},
         {"id": "h2", "item": "web/src/Storage.tsx and the emulator", "kind": "tool"}, {"item": " "}]
    pid = ib.plan_start("p", parts=PARTS, harness=h)
    assert store.docs[f"planVersions/{pid}_v1"]["harness"] == h[:2]
    n = ib.plan_version(pid, "", "move", phase="build", order="Move the plan to phase Build.")
    assert store.docs[f"planVersions/{pid}_v{n}"]["harness"] == h[:2]  # kept on a plain version
    n = ib.plan_version(pid, "", "one check changed", parts=PARTS, harness=[dict(h[0], item="tests/test_delete.py, 3 cases")],
                        order="x")
    assert [x["item"] for x in store.docs[f"planVersions/{pid}_v{n}"]["harness"]] == ["tests/test_delete.py, 3 cases"]
    with pytest.raises(ValueError, match="two harness items"):
        ib.plan_version(pid, "", "dup", parts=PARTS, harness=[h[0], h[0]])


def test_build_takes_only_the_ticked_harness_items_and_a_changed_item_needs_a_new_tick():
    from agent_bridge.inbox import item_hash
    store = FakeStore()
    ib = Inbox(store, "PC", [], "s1", "/x")
    h = [{"id": "h1", "item": "tests/test_delete.py written, fails now", "kind": "check"},
         {"id": "h2", "item": "web/src/Storage.tsx", "kind": "tool"}, {"id": "h3", "item": "emulator", "kind": "tool"}]
    assert item_hash(h[0]) == "d1e192ba"  # the same value the page's harness.ts gives
    pid = ib.plan_start("p", parts=PARTS, harness=h)
    stale = dict(h[2], item="old text")
    store.put_many({f"planHarness/{pid}": {"planId": pid, "items": {
        "h1": {"ok": True, "hash": item_hash(h[0])}, "h2": {"ok": False, "hash": item_hash(h[1])},
        "h3": {"ok": True, "hash": item_hash(stale)}}}})
    n = ib.plan_version(pid, "", "Build", phase="build", order="Move the plan to phase Build.")
    assert store.docs[f"planVersions/{pid}_v{n}"]["phaseMove"]["harness"] == {"approved": ["h1"], "notApproved": ["h2", "h3"]}


def test_a_generate_order_adds_plan_data_to_the_projects_gitignore_once(tmp_path):
    from agent_bridge.runs import ensure_plan_data_ignored
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)
    (repo / ".gitignore").write_text("node_modules/", encoding="utf-8")  # no newline at the end
    assert ensure_plan_data_ignored(str(repo)) is True
    text = (repo / ".gitignore").read_text(encoding="utf-8")
    assert text.startswith("node_modules/\n") and text.rstrip().endswith(".plan_data/")
    assert ensure_plan_data_ignored(str(repo)) is False  # already there: nothing written twice
    assert (repo / ".gitignore").read_text(encoding="utf-8") == text
    plain = tmp_path / "plain"
    plain.mkdir()
    assert ensure_plan_data_ignored(str(plain)) is False and not (plain / ".gitignore").exists()  # not a git folder
