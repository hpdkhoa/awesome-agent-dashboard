"""s5 (plan 44fc4979): the auto rule check B1 to B10 and the glance test scoring."""
from agent_bridge.boardrules import S7, check_board
from agent_bridge.glance import parse_score

GOOD = {"whatFor": "Board reads at a glance", "idea": ["Sources on every line", "Coverage bar shows gaps"],
        "product": [{"feature": "Source chips", "steps": ["s1"]}], "materials": [],
        "src": {"whatFor": ["goal"], "idea": [["s1"], ["s2"]]}}


def states(board):
    return {r["id"]: r["state"] for r in check_board(board)["rules"]}


def test_all_ten_rules_and_s7_waits():
    r = check_board(GOOD)
    assert [x["id"] for x in r["rules"]] == [f"B{i}" for i in range(1, 11)]
    st = states(GOOD)
    assert st["B2"] == st["B4"] == st["B7"] == S7  # the owner's pick: B2/B4/B7 wait for s7, never fails before it
    assert all(st[k] == "pass" for k in ("B1", "B3", "B5", "B6", "B8", "B9"))
    assert st["B10"] == "pass"  # the heading "Idea" (was "The idea", the owner's pick 2026-11-20: Rename to "Idea")
    assert r["wait"] == 3


def test_each_data_rule_fails_on_its_case():
    assert states({**GOOD, "whatFor": ""})["B1"] == "fail"
    assert states({**GOOD, "idea": ["Note: x", "Sources y"]})["B3"] == "fail"
    assert states({**GOOD, "idea": ["Node a", "Node b"]})["B3"] == "fail"  # an opener repeated down a list
    assert states({**GOOD, "src": {"whatFor": [], "idea": [["s1"], []]}})["B5"] == "fail"
    assert states({**GOOD, "idea": ["Sources\n- sub line", "Coverage"]})["B6"] == "fail"
    assert states({**GOOD, "idea": ["Board must be a glance, no sente...", "Coverage"]})["B8"] == "fail"
    assert states({**GOOD, "idea": ["Chips because readers need sources", "Coverage"]})["B9"] == "fail"
    big = {**GOOD, "idea": [f"Line {i}" for i in range(6)], "src": {"whatFor": ["goal"], "idea": [["s1"]] * 6}}
    b2 = next(x for x in check_board(big)["rules"] if x["id"] == "B2")
    assert b2["state"] == S7 and b2["n"] == 1 and "Idea: 6 lines" in b2["lines"]


def test_no_board_no_check():
    assert check_board(None) is None


def test_glance_score_from_the_json_line():
    got = parse_score('blah\n{"marks": [{"q": "whatFor", "verdict": "right", "why": "same"}, {"q": "done", "verdict": "partly", '
                      '"why": "half"}, {"q": "next", "verdict": "wrong", "why": "no"}]}')
    assert got["score"] == 1.5 and [m["q"] for m in got["marks"]] == ["whatFor", "done", "next", "blocked"]
    assert got["marks"][3]["verdict"] == "wrong"
    assert parse_score("no json") is None
