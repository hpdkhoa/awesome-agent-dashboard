"""s5 (plan 44fc4979): the auto rule check B1 to B10 and the glance test scoring."""
from agent_bridge.boardrules import S7, check_board
from agent_bridge.glance import parse_score

GOOD = {"whatFor": "Board reads at a glance", "idea": ["Sources on every line", "Coverage bar shows gaps"],
        "product": [{"feature": "Source chips", "steps": ["s1"]}], "materials": [],
        "src": {"whatFor": ["goal"], "idea": [["s1"], ["s2"]]}}


def states(board):
    return {r["id"]: r["state"] for r in check_board(board)["rules"]}


def test_all_ten_rules_none_waits_after_s7():
    r = check_board(GOOD)
    assert [x["id"] for x in r["rules"]] == [f"B{i}" for i in range(1, 11)]
    st = states(GOOD)
    assert S7 not in st.values() and r["wait"] == 0  # s7 built B2, B4, B7: no rule waits any more
    assert all(v == "pass" for v in st.values())  # B10: the heading "Idea" and the s7 sub-headings open with information words


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
    assert b2["state"] == "fail" and b2["n"] == 1 and "Idea: 6 lines with no named sub-groups" in b2["lines"][0]


def test_b2_idea_groups_by_meaning():
    big = {**GOOD, "idea": [f"Line {i}" for i in range(6)], "src": {"whatFor": ["goal"], "idea": [["s1"]] * 6}}
    ok = {**big, "ideaGroups": [{"head": "Research", "count": 2}, {"head": "Board parts", "count": 4}]}
    assert states(ok)["B2"] == "pass"
    assert states({**big, "ideaGroups": [{"head": "Research", "count": 1}, {"head": "Board parts", "count": 5}]})["B2"] == "fail"
    assert states({**big, "ideaGroups": [{"head": "Research", "count": 2}, {"head": "Board parts", "count": 3}]})["B2"] == "fail"
    assert states({**big, "ideaGroups": [{"head": "The parts", "count": 6}]})["B10"] == "fail"  # a generic group heading


def test_clean_board_keeps_idea_groups():
    from agent_bridge.inbox import clean_board
    b = clean_board({"what_for": "x", "idea": ["a", "b"], "product": [{"feature": "f", "steps": ["s1"]}],
                     "idea_groups": [{"head": "Research", "count": 2}, {"head": "", "count": 1}, "bad"]}, ["s1"])
    assert b["ideaGroups"] == [{"head": "Research", "count": 2}]
    assert "ideaGroups" not in clean_board({"what_for": "x", "product": [{"feature": "f", "steps": ["s1"]}]}, ["s1"])


def test_no_board_no_check():
    assert check_board(None) is None


def test_glance_score_from_the_json_line():
    got = parse_score('blah\n{"marks": [{"q": "whatFor", "verdict": "right", "why": "same"}, {"q": "done", "verdict": "partly", '
                      '"why": "half"}, {"q": "next", "verdict": "wrong", "why": "no"}]}')
    assert got["score"] == 1.5 and [m["q"] for m in got["marks"]] == ["whatFor", "done", "next", "blocked"]
    assert got["marks"][3]["verdict"] == "wrong"
    assert parse_score("no json") is None
