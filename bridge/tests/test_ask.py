"""The question hook: answered on the dashboard within 10 minutes, the session gets the answers; otherwise it asks."""

from agent_bridge.ask import handle
from test_inbox import FakeStore, make, owner_answers

EVENT = {
    "session_id": "s1",
    "tool_name": "AskUserQuestion",
    "tool_input": {"questions": [
        {"question": "Which way?", "header": "Way", "options": [{"label": "A", "description": "fast"}, {"label": "B"}],
         "multiSelect": False},
        {"question": "Which parts?", "header": "Parts", "options": [{"label": "X"}, {"label": "Y"}], "multiSelect": True},
    ]},
}


class Clock:
    """A clock that moves only when the hook sleeps; `on_sleep` plays the owner."""

    def __init__(self, on_sleep=lambda n: None):
        self.t, self.n, self.on_sleep = 0.0, 0, on_sleep

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.n += 1
        self.t += s
        self.on_sleep(self.n)


def run(store, on_sleep):
    c = Clock(on_sleep)
    return handle(EVENT, make(store), clock=c, sleep=c.sleep), c


def items(store):
    return {p.split("/")[1]: d for p, d in store.docs.items() if p.startswith("inbox/")}


def test_answers_from_the_dashboard_reach_the_session():
    store = FakeStore()

    def owner(n):
        if n == 2:
            a, b = items(store)
            owner_answers(store, a, "A", "keep it short")
            owner_answers(store, b, "X, Y")

    out, _ = run(store, owner)
    o = out["hookSpecificOutput"]
    assert o["permissionDecision"] == "allow"
    assert o["updatedInput"]["questions"] == EVENT["tool_input"]["questions"]
    assert o["updatedInput"]["answers"] == {"Which way?": "A. Note: keep it short", "Which parts?": "X, Y"}
    posted = list(items(store).values())
    assert [p["options"][0] for p in posted] == [{"label": "A", "detail": "fast"}, {"label": "X", "detail": ""}]
    assert [p["multi"] for p in posted] == [False, True] and all(p["via"] == "hook" for p in posted)
    assert all(p["status"] == "delivered" for p in posted)
    assert store.get("liveSessions/s1")  # the bridge sees the session as open and never resumes it meanwhile


def test_no_answer_in_10_minutes_lets_the_session_ask():
    store = FakeStore()
    out, c = run(store, lambda n: None)
    assert out is None and c.t >= 600
    assert all(p["status"] == "closed" for p in items(store).values())


def test_one_answer_is_not_enough():
    store = FakeStore()
    out, _ = run(store, lambda n: n == 1 and owner_answers(store, next(iter(items(store))), "A"))
    assert out is None


def test_a_deleted_question_stops_the_wait():
    store = FakeStore()
    out, c = run(store, lambda n: n == 1 and store.docs.pop(next(p for p in store.docs if p.startswith("inbox/"))))
    assert out is None and c.t < 600


def test_other_tools_are_left_alone():
    store = FakeStore()
    assert handle({"tool_name": "Bash", "tool_input": {"command": "ls"}}, make(store)) is None
    assert store.docs == {}
