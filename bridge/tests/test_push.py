import json

from agent_bridge.push import Pusher, public_key
from test_inbox import FakeStore
from test_runs import cmd, setup, wait_done


def subscribed(store, *ids):
    for i in ids:
        store.put_many({f"pushSubs/{i}": {"id": i, "kind": "webpush", "endpoint": f"https://push.example/{i}", "keys": {"p256dh": "k", "auth": "a"}}})


def test_each_device_gets_it_and_a_gone_device_is_removed():
    store = FakeStore()
    subscribed(store, "phone", "old")
    sent = []

    def send(sub, data):
        sent.append((sub["endpoint"], json.loads(data)))
        return 410 if sub["endpoint"].endswith("old") else 201

    assert Pusher(store, "mailto:x", send).notify("Approval needed: Bash", "git status", "/?item=1", "1") == 1
    assert sent[0][1] == {"title": "Approval needed: Bash", "body": "git status", "url": "/?item=1", "tag": "1"}
    assert "pushSubs/old" not in store.docs and "pushSubs/phone" in store.docs


def test_a_failing_push_never_raises():
    store = FakeStore()
    subscribed(store, "phone")

    def send(sub, data):
        raise OSError("offline")

    assert Pusher(store, "mailto:x", send).notify("t", "b") == 0
    assert Pusher(FakeStore(), "mailto:x", send).notify("t", "b") == 0  # nobody subscribed


def test_finished_runs_notify_with_their_first_line(tmp_path, monkeypatch):
    store, runs, work = setup(tmp_path, monkeypatch)
    got = []
    runs.push = type("P", (), {"notify": lambda self, *a: got.append(a)})()
    cmd(store, "c1", action="start", folder=str(work), prompt="hello")
    cmd(store, "c2", action="start", folder=str(work), prompt="fail")
    wait_done(runs, "c1", store)
    wait_done(runs, "c2", store)
    by = {a[3]: a for a in got}
    assert by["c1"][0] == "Run done: labs" and by["c1"][1].startswith("did: hello") and by["c1"][2] == "/?run=c1"
    assert by["c2"][0] == "Run failed: labs" and "boom" in by["c2"][1]


def test_public_key_is_the_uncompressed_point():
    from py_vapid import Vapid02

    v = Vapid02()
    v.generate_keys()
    k = public_key(v.private_pem().decode())
    assert len(k) == 87 and k.startswith("B")


def test_questions_suggestions_results_and_plan_versions_push():
    from agent_bridge.inbox import Inbox

    store = FakeStore()
    got = []
    ib = Inbox(store, "PC", [("labs", "K:/labs")], "s1", "K:/labs/x", type("P", (), {"notify": lambda self, *a: got.append(a)})())
    pid = ib.plan_start("Plans tab", "# v1", "first draft")
    q = ib.post("question", "List or graph?", "\nPick one.")
    h = ib.post("question", "Hook question", "Which?", extra={"via": "hook"})
    ib.post("suggestion", "Idea", "Try this")
    ib.post("result", "Done", "All tests pass")
    ib.post("approval", "Allow Bash?", "{}")
    titles = [a[0] for a in got]
    assert titles == ["Plan v1: Plans tab", "Question: List or graph?", "Question: Hook question", "Suggestion: Idea", "Result to review: Done"]
    assert got[0][1] == "first draft" and got[0][2] == f"/?plan={pid}"
    assert got[1][1] == "Pick one." and got[1][2] == f"/?item={q}"
    assert got[2][1].startswith("Answer within 10 minutes") and got[2][3] == h
