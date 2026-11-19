"""F12 inbox hygiene (plan bf73af63; the owner's picks 2026-11-19 "Start F12, build now", "Same plan step"): one result
per item, later ones edit it; a session withdraws a moot question."""
from test_inbox import FakeStore, make, owner_answers


def results(store):
    return [d for p, d in store.docs.items() if p.startswith("inbox/") and d.get("kind") == "result"]


def test_second_result_on_a_plan_step_edits_not_adds():
    store = FakeStore()
    a, b = make(store, "sA"), make(store, "sB")  # sB: the session after a handoff
    i1, n1 = a.result("F1 built", "v1 text", ["x.png"], plan_id="P", step_id="F1")
    owner_answers(store, i1, "Reviewed, see note", "commit push and restart")
    i2, n2 = b.result("Step done: F1", "v2 text", ["y.png"], plan_id="P", step_id="F1")
    assert (i2, n1, n2) == (i1, 1, 2) and len(results(store)) == 1
    item = store.get(f"inbox/{i1}")
    assert item["title"] == "Step done: F1" and item["text"] == "v2 text" and item["status"] == "open" and item["answer"] is None
    v = item["versions"][0]
    assert v["n"] == 1 and v["title"] == "F1 built" and v["answer"]["text"] == "commit push and restart" and v["files"] == ["x.png"]
    i3, n3 = a.result("third", "v3", plan_id="P", step_id="F1")
    assert (i3, n3) == (i1, 3) and [x["n"] for x in store.get(f"inbox/{i1}")["versions"]] == [1, 2]


def test_other_step_or_no_step_is_a_new_card_and_edit_of_edits():
    store = FakeStore()
    ib = make(store)
    i1, _ = ib.result("F1", "t", plan_id="P", step_id="F1")
    i2, _ = ib.result("F2", "t", plan_id="P", step_id="F2")
    i3, _ = ib.result("loose", "t")
    i4, _ = ib.result("loose again", "t")
    assert len({i1, i2, i3, i4}) == 4
    i5, n5 = ib.result("loose, edited", "t2", edit_of=i3)
    assert (i5, n5) == (i3, 2) and len(results(store)) == 4


def test_step_update_done_twice_keeps_one_result():
    store = FakeStore()
    ib = make(store)
    store.put_many({"plans/P": {"id": "P", "current": 1, "sessionId": "s1"},
                    "planVersions/P_v1": {"parts": {"steps": [{"id": "s1", "title": "t"}]}}})
    ib.step_update("P", "s1", "failed", "first try")
    ib.step_update("P", "s1", "failed", "second try")
    rs = results(store)
    assert len(rs) == 1 and rs[0]["version"] == 2 and rs[0]["text"] == "second try"


def test_withdraw_a_moot_question():
    store = FakeStore()
    ib, other = make(store, "s1"), make(store, "s2")
    q = ib.post("question", "Moot?", "t", [{"label": "A", "differs": "d"}, {"label": "B", "differs": "d"}])
    assert "reason" in ib.withdraw(q, " ")
    assert other.withdraw(q, "moot").startswith("Only")
    assert ib.withdraw(q, "answered in the plan v8") == ""
    item = store.get(f"inbox/{q}")
    assert item["status"] == "closed" and item["withdrawn"]["reason"] == "answered in the plan v8"
    assert ib.withdraw(q, "again").startswith("Not withdrawn")
    a = ib.post("question", "Answered", "t", [{"label": "A", "differs": "d"}])
    owner_answers(store, a, "A")
    assert ib.withdraw(a, "moot").startswith("Not withdrawn")


def test_the_plan_holder_withdraws_after_a_handoff():
    store = FakeStore()
    old = make(store, "old")
    store.put_many({"plans/P": {"id": "P", "sessionId": "new"}})
    q = old.post("question", "Q", "t", [{"label": "A", "differs": "d", "example": {"type": "text", "draft": "x"}}], extra={"planId": "P"})
    assert make(store, "new").withdraw(q, "moot after the handoff") == ""
