import json
import sys
import time

from agent_bridge.inbox import approval_reply
from agent_bridge.runs import APPROVAL_TOOL, Runs, folder_ok, start_command
from test_inbox import FakeStore

# A stand-in for claude: prints a JSON result like `claude -p --output-format json`, or sleeps when the prompt says so.
FAKE = r'''
import json, os, sys, time
prompt = sys.argv[sys.argv.index("-p") + 1]
if prompt == "sleep":
    time.sleep(60)
if prompt == "fail":
    print("boom", file=sys.stderr); sys.exit(3)
print(json.dumps({"result": "did: " + prompt + " in " + os.path.basename(os.getcwd()),
                  "total_cost_usd": 0.12, "key": os.environ.get("ANTHROPIC_API_KEY")}))
'''


def setup(tmp_path, monkeypatch):
    fake = tmp_path / "fake_claude.py"
    fake.write_text(FAKE)
    work = tmp_path / "work"
    work.mkdir()
    store = FakeStore()
    monkeypatch.setenv("ANTHROPIC_API_KEY", "should-not-pass")

    def popen(cmd, **kw):
        import subprocess

        return subprocess.Popen([sys.executable, str(fake), *cmd[1:]], **kw)

    runs = Runs(store, "PC", [("labs", str(work))], "claude", tmp_path / "out", popen=popen)
    return store, runs, work


def cmd(store, cid, **f):
    store.put_many({f"commands/{cid}": {"id": cid, "machine": "PC", "status": "new", **f}})


def wait_done(runs, cid, store, seconds=20):
    end = time.time() + seconds
    while time.time() < end:
        runs.step()
        if store.get(f"commands/{cid}")["status"] not in ("new", "running", "stopping"):
            return store.get(f"commands/{cid}")
        time.sleep(0.2)
    raise AssertionError("run did not finish")


def test_start_runs_claude_in_the_registered_folder(tmp_path, monkeypatch):
    store, runs, work = setup(tmp_path, monkeypatch)
    cmd(store, "c1", action="start", folder=str(work), prompt="hello")
    runs.step()
    c = store.get("commands/c1")
    assert c["status"] == "running" and len(c["sessionId"]) == 36 and c["workType"] == "labs"
    c = wait_done(runs, "c1", store)
    assert c["status"] == "done" and c["costUsd"] == 0.12 and c["result"] == "did: hello in work"
    out = json.loads((tmp_path / "out" / "c1.out").read_text())
    assert out["key"] is None  # ANTHROPIC_API_KEY never reaches claude


def test_unregistered_folder_and_empty_prompt_are_refused(tmp_path, monkeypatch):
    store, runs, work = setup(tmp_path, monkeypatch)
    cmd(store, "c1", action="start", folder=str(tmp_path), prompt="x")
    cmd(store, "c2", action="start", folder=str(work), prompt="  ")
    cmd(store, "c3", action="shell", folder=str(work), prompt="rm -rf /")
    runs.step()
    assert [store.get(f"commands/{c}")["status"] for c in ("c1", "c2", "c3")] == ["failed"] * 3
    assert runs.procs == {}


def test_other_machine_is_left_alone(tmp_path, monkeypatch):
    store, runs, work = setup(tmp_path, monkeypatch)
    store.put_many({"commands/c1": {"id": "c1", "machine": "LINUX", "status": "new", "action": "start",
                                    "folder": str(work), "prompt": "x"}})
    runs.step()
    assert store.get("commands/c1")["status"] == "new"


def test_stop_ends_a_running_run(tmp_path, monkeypatch):
    store, runs, work = setup(tmp_path, monkeypatch)
    cmd(store, "c1", action="start", folder=str(work), prompt="sleep")
    runs.step()
    cmd(store, "s1", action="stop", target="c1")
    runs.step()
    assert store.get("commands/s1")["status"] == "done"
    assert wait_done(runs, "c1", store)["status"] == "stopped"


def test_failed_run_keeps_the_error(tmp_path, monkeypatch):
    store, runs, work = setup(tmp_path, monkeypatch)
    cmd(store, "c1", action="start", folder=str(work), prompt="fail")
    c = wait_done(runs, "c1", store)
    assert c["status"] == "failed" and c["exitCode"] == 3 and "boom" in c["error"]


def test_no_claude_cli(tmp_path, monkeypatch):
    store, runs, work = setup(tmp_path, monkeypatch)
    runs.claude = None
    cmd(store, "c1", action="start", folder=str(work), prompt="x")
    runs.step()
    assert "No signed-in claude CLI" in store.get("commands/c1")["error"]


def test_runs_lost_by_a_restart_are_marked(tmp_path):
    store = FakeStore()
    store.put_many({"commands/c1": {"id": "c1", "machine": "PC", "status": "running"}})
    Runs(store, "PC", [], "claude", tmp_path).forget_lost()
    assert store.get("commands/c1")["status"] == "lost"


def test_command_shape_and_folder_match():
    c = start_command("claude", "do x", "sid")
    assert c[:3] == ["claude", "-p", "do x"] and c[c.index("--permission-prompt-tool") + 1] == APPROVAL_TOOL
    assert "--dangerously-skip-permissions" not in c and "bypassPermissions" not in c
    assert folder_ok("K:\\Labs\\", [("labs", "K:/labs")]) == "labs" and folder_ok("K:/labs/sub", [("labs", "K:/labs")]) is None


def test_approval_replies():
    inp = {"command": "ls"}
    allow = json.loads(approval_reply({"answer": {"choice": "Allow"}}, inp))
    deny = json.loads(approval_reply({"answer": {"choice": "Deny", "text": "not now"}}, inp))
    late = json.loads(approval_reply(None, inp))
    assert allow == {"behavior": "allow", "updatedInput": inp}
    assert deny["behavior"] == "deny" and "not now" in deny["message"] and late["behavior"] == "deny"
