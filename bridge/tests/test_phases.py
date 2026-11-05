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


def test_approving_the_generated_result_moves_the_approved_files_and_cleans_tmp_and_the_dashboard(tmp_path, monkeypatch):
    from test_runs import cmd, setup
    store, runs, work = setup(tmp_path, monkeypatch)
    store.put_many({"plans/pl1": {"id": "pl1", "sessionId": "s1"},
                    "inbox/r1": {"id": "r1", "kind": "result", "sessionId": "s1", "title": "Generated diagram: a"},
                    "inbox/r2": {"id": "r2", "kind": "result", "sessionId": "s1", "title": "Generated mockup: b"},
                    "inbox/q1": {"id": "q1", "kind": "question", "sessionId": "s1", "title": "Generated? no"},
                    "inbox/o1": {"id": "o1", "kind": "result", "sessionId": "other", "title": "Generated diagram"}})
    tmp = work / ".plan_data" / "pl1" / "v3" / "tmp"
    tmp.mkdir(parents=True)
    for name in ("diagram-a.svg", "mockup-b.svg"):
        (tmp / name).write_text(name, encoding="utf-8")
    (tmp.parent / "diagram-a.svg").write_text("approved earlier", encoding="utf-8")  # taken: the new one gets -2
    outside = work / "secret.txt"
    outside.write_text("keep", encoding="utf-8")
    cmd(store, "a1", action="approve_generated", planId="pl1", cwd=str(work), folder=".plan_data/pl1/v3",
        keep=[".plan_data/pl1/v3/tmp/diagram-a.svg", "secret.txt", "../x.svg"], drop=["r1", "r2", "q1", "o1"])
    runs.step()
    c = store.get("commands/a1")
    assert c["status"] == "done", c
    assert c["moved"] == [{"from": ".plan_data/pl1/v3/tmp/diagram-a.svg", "to": ".plan_data/pl1/v3/diagram-a-2.svg"}]
    assert c["skipped"] == ["secret.txt", "../x.svg"] and outside.exists()  # nothing outside tmp is touched
    assert (tmp.parent / "diagram-a.svg").read_text(encoding="utf-8") == "approved earlier"  # never overwritten
    assert not tmp.exists()  # the unapproved mockup went with the tmp folder
    assert c["removed"] == 2 and "inbox/r1" not in store.docs and "inbox/r2" not in store.docs
    assert "inbox/q1" in store.docs and "inbox/o1" in store.docs  # only this session's Generated results
    gen = store.get("planGenerated/pl1")["versions"]["v3"]
    assert [(g["file"], g["kind"]) for g in gen] == [(".plan_data/pl1/v3/diagram-a-2.svg", "diagram")]
    assert "planVersions/pl1_v4" not in store.docs  # a supplement, never a plan version


def test_approving_refuses_a_folder_that_is_not_the_plans_version_folder(tmp_path, monkeypatch):
    from test_runs import cmd, setup
    store, runs, work = setup(tmp_path, monkeypatch)
    store.put_many({"plans/pl1": {"id": "pl1", "sessionId": "s1"}})
    for i, folder in enumerate([".", ".plan_data/other/v1", ".plan_data/pl1/v1/../../.."]):
        cmd(store, f"b{i}", action="approve_generated", planId="pl1", cwd=str(work), folder=folder, keep=[], drop=[])
    runs.step()
    assert all(store.get(f"commands/b{i}")["status"] == "failed" for i in range(3))


def test_a_deleted_plan_takes_only_its_own_plan_data_folder(tmp_path, monkeypatch):
    from test_runs import cmd, setup
    store, runs, work = setup(tmp_path, monkeypatch)
    mine = work / ".plan_data" / "pl1" / "v3"
    other = work / ".plan_data" / "pl2" / "v1"
    for d in (mine, other):
        d.mkdir(parents=True)
        (d / "diagram-a.svg").write_text("x", encoding="utf-8")
    (work / "keep.txt").write_text("keep", encoding="utf-8")
    store.put_many({"plans/pl2": {"id": "pl2"}})  # pl1 is deleted, pl2 still exists
    cmd(store, "d1", action="delete_plan_files", cwd=str(work), plan="pl1")
    cmd(store, "d2", action="delete_plan_files", cwd=str(work), plan="pl2")
    cmd(store, "d3", action="delete_plan_files", cwd=str(work), plan="..")
    runs.step()
    assert not (work / ".plan_data" / "pl1").exists() and "commands/d1" not in store.docs
    assert other.exists() and store.get("commands/d2")["status"] == "failed"  # a plan that exists keeps its files
    assert store.get("commands/d3")["status"] == "failed" and (work / "keep.txt").exists()
    assert (work / ".plan_data").exists()  # only the plan's own folder goes
