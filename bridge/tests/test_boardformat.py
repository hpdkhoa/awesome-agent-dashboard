"""s6 of plan 44fc4979 (the owner, 2026-11-21: "I want the update button so I can do manual update for the roll out, the
next run steps on a plan will auto generate to selfupdate the work to keep up with latest work")."""
from agent_bridge.boardformat import board_gaps, update_block
from agent_bridge.runs import Runs
from test_inbox import FakeStore

STEPS = [{"id": "s1", "title": "a"}, {"id": "s2", "title": "b"}]
CARD = {"for": "f", "action": "a", "how": "h", "done": "d", "missed": "nothing"}
NEW = {"steps": STEPS, "board": {"whatFor": "x", "idea": ["i"], "glossary": [{"group": "g", "term": "t", "means": "m"}],
                                 "stepCards": [{"step": "s1", **CARD}, {"step": "s2", **CARD}]}}
OLD = {"steps": STEPS, "board": {"whatFor": "x", "idea": ["1", "2", "3", "4", "5"],
                                 "stepCards": [{"step": "s1", "for": "f", "how": "h"}]}}


def test_gaps():
    assert board_gaps(NEW) == []
    assert board_gaps({"steps": STEPS}) == ["no board"]
    g = board_gaps(OLD)
    assert "step cards without Action: s1" in g and "no step card: s2" in g and "step cards without Done: s1" in g and "step cards without Missed: s1" in g
    assert "no glossary" in g and "idea over 4 lines with no idea groups" in g
    assert "Update board" in update_block([], True) and "rule:23" in update_block(g, False)


def runs_with(tmp_path, parts):
    store = FakeStore()
    store.put_many({"plans/p": {"id": "p", "current": 3}, "planVersions/p_v3": {"parts": parts}})
    return Runs(store, "PC", [], "claude", tmp_path)


def test_step_run_self_updates_only_an_old_board(tmp_path):
    t, f = runs_with(tmp_path, OLD).board_first({"planId": "p", "stepId": "s2"}, "Work on step s2")
    assert t.startswith("Board update") and t.endswith("Work on step s2") and f["boardUpdated"]["by"] == "step"
    t, f = runs_with(tmp_path, NEW).board_first({"planId": "p", "stepId": "s2"}, "Work on step s2")
    assert (t, f) == ("Work on step s2", {})


def test_button_always_and_other_messages_never(tmp_path):
    t, f = runs_with(tmp_path, NEW).board_first({"planId": "p", "kind": "action", "boardUpdate": True}, "Update board")
    assert t.startswith("Board update") and "pressed Update board" in t and f["boardUpdated"]["by"] == "button"
    for c in ({"planId": "p", "kind": "qa"}, {"planId": "p", "kind": "action", "stepId": "s1"}, {"stepId": "s1"}):
        assert runs_with(tmp_path, OLD).board_first(c, "hi") == ("hi", {})
