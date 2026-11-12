"""8. Evidence (evidence.py; the owner's picks 2026-11-12: pictures not text, "Attach, else picture run", "Fresh one-off
run", "Mark only")."""
import json
import os
import sys
import time

from agent_bridge.evidence import on_done, parse_marks, pictures, queue
from agent_bridge.inbox import Inbox
from agent_bridge.runs import Runs
from test_inbox import FakeStore

# A stand-in for claude: a picture run saves a png in the folder its prompt names; a check run answers with marks.
FAKE = r'''
import json, os, sys
prompt = sys.argv[sys.argv.index("-p") + 1]
assert "--no-session-persistence" in sys.argv
if prompt.startswith("Take the evidence pictures"):
    folder = prompt.split("folder (make it): ")[1].split("\n")[0].strip()
    if "nopics" not in prompt:
        os.makedirs(folder, exist_ok=True)
        open(os.path.join(folder, "desktop.png"), "wb").write(b"\x89PNG")
    print(json.dumps({"type": "result", "result": "saved"}))
else:
    edits = "--disallowedTools" in sys.argv
    print(json.dumps({"type": "result", "result": "looked.\n" + json.dumps({"overall": "fail" if edits else "pass",
        "pictures": [{"path": "a.png", "verdict": "fail", "why": "no phone view"}], "note": "phone view missing"})}))
'''

PNG = b"\x89PNG\r\n"


def make(tmp_path, monkeypatch, step_title="step 1"):
    fake = tmp_path / "fake_claude.py"
    fake.write_text(FAKE)
    work = tmp_path / "work"
    work.mkdir()
    store = FakeStore()
    store.put_many({
        "plans/p1": {"id": "p1", "title": "T", "machine": "PC", "sessionId": "s1", "cwd": str(work), "current": 1, "phase": "build"},
        "planVersions/p1_v1": {"parts": {"goal": "g", "steps": [{"id": "S1", "title": step_title, "does": "", "check": "page shows it"}]}},
        "planSteps/p1_S1": {"planId": "p1", "stepId": "S1", "state": "done", "versions": [{"n": 1, "state": "done", "reply": "built"}]},
    })

    def popen(cmd, **kw):
        import subprocess
        return subprocess.Popen([sys.executable, str(fake), *cmd[1:]], **kw)

    runs = Runs(store, "PC", [("w", str(work))], "claude", tmp_path / "out", popen=popen, logs=tmp_path / "logs", procs=lambda: [])
    return store, runs, work


def wait(runs, store, cid, seconds=20):
    end = time.time() + seconds
    while time.time() < end:
        runs.step()
        if store.get(f"commands/{cid}")["status"] not in ("new", "running"):
            return store.get(f"commands/{cid}")
        time.sleep(0.2)
    raise AssertionError("run did not finish")


def test_only_pictures_that_exist_count(tmp_path):
    (tmp_path / "a.png").write_bytes(PNG)
    (tmp_path / "b.txt").write_text("x")
    got = pictures(["a.png", "b.txt", "gone.png", str(tmp_path / "a.png")], str(tmp_path))
    assert got == [str((tmp_path / "a.png").resolve())]


def test_a_done_report_with_pictures_makes_a_set_and_none_queues_a_picture_run(tmp_path):
    store = FakeStore()
    (tmp_path / "shot.png").write_bytes(PNG)
    plan = {"id": "p1", "cwd": str(tmp_path), "machine": "PC"}
    assert "1 pictures" in on_done(store, plan, "S1", ["shot.png"], 3, "PC")
    rec = store.get("planEvidence/p1_S1")
    assert rec["sets"][0]["by"] == "report" and rec["sets"][0]["stepVersion"] == 3 and rec["state"] == "idle"
    assert not [k for k in store.docs if k.startswith("commands/")]
    assert "picture run queued" in on_done(store, plan, "S2", ["missing.png"], 1, "PC")
    c = next(v for k, v in store.docs.items() if k.startswith("commands/"))
    assert c["action"] == "evidence" and c["what"] == "pictures" and c["trigger"] == "done"
    assert store.get("planEvidence/p1_S2")["state"] == "queued"


def test_step_update_done_takes_the_attached_pictures(tmp_path):
    store, _, work = make(tmp_path, None)
    (work / "p.png").write_bytes(PNG)
    ib = Inbox(store, "PC", [], "s1", "/x")
    ib.step_update("p1", "S1", "done", "built", evidence=["p.png"])
    assert store.get("planEvidence/p1_S1")["sets"][0]["pictures"] == [str((work / "p.png").resolve())]


def test_a_picture_run_is_one_off_and_keeps_what_it_saved(tmp_path, monkeypatch):
    store, runs, work = make(tmp_path, monkeypatch)
    cid = queue(store, store.get("plans/p1"), "S1", "pictures", "button", "PC")
    c = wait(runs, store, cid)
    assert c["status"] == "done" and c["noSession"] and c["workType"] == "evidence pictures · step S1"
    rec = store.get("planEvidence/p1_S1")
    assert rec["state"] == "idle" and rec["sets"][0]["by"] == "run" and rec["sets"][0]["pictures"][0].endswith("desktop.png")
    assert os.path.dirname(rec["sets"][0]["pictures"][0]).endswith(os.path.join("evidence", "S1", cid))


def test_a_picture_run_that_saves_nothing_says_so(tmp_path, monkeypatch):
    store, runs, _ = make(tmp_path, monkeypatch, step_title="nopics")
    cid = queue(store, store.get("plans/p1"), "S1", "pictures", "button", "PC")
    wait(runs, store, cid)
    rec = store.get("planEvidence/p1_S1")
    assert rec["state"] == "idle" and "saved no picture" in rec["error"] and not rec.get("sets")


def test_the_llm_check_marks_only_and_the_step_stays_done(tmp_path, monkeypatch):
    store, runs, work = make(tmp_path, monkeypatch)
    (work / "a.png").write_bytes(PNG)
    on_done(store, store.get("plans/p1"), "S1", ["a.png"], 1, "PC")
    cid = queue(store, store.get("plans/p1"), "S1", "check", "button", "PC")
    wait(runs, store, cid)
    ck = store.get("planEvidence/p1_S1")["check"]
    assert ck["overall"] == "fail" and ck["pictures"][0]["why"] == "no phone view" and ck["note"] == "phone view missing"
    assert ck["set"] == store.get("planEvidence/p1_S1")["sets"][0]["at"]
    assert store.get("planSteps/p1_S1")["state"] == "done"  # the owner's pick "Mark only"


def test_a_check_with_no_pictures_is_refused(tmp_path, monkeypatch):
    store, runs, _ = make(tmp_path, monkeypatch)
    cid = queue(store, store.get("plans/p1"), "S1", "check", "button", "PC")
    runs.step()
    assert store.get(f"commands/{cid}")["status"] == "failed"
    assert "Generate evidence first" in store.get("planEvidence/p1_S1")["error"]


def test_marks_are_read_from_the_last_json_line_and_cleaned():
    text = 'first {"x": 1}\n' + json.dumps({"overall": "PASS", "pictures": [{"path": "a", "verdict": "maybe"}]})
    m = parse_marks(text, [])
    assert m["overall"] == "pass" and m["pictures"][0]["verdict"] == "unclear"
    assert parse_marks("no json here", []) is None
