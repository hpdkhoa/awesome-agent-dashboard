import json
import sys
import time

from agent_bridge.inbox import approval_reply
from agent_bridge.runs import APPROVAL_TOOL, Runs, folder_ok, message_command, start_command
from test_inbox import FakeStore

# A stand-in for claude: prints a JSON result like `claude -p --output-format json`, or sleeps when the prompt says so.
FAKE = r'''
import json, os, sys, time
prompt = sys.argv[sys.argv.index("-p") + 1]
if prompt == "sleep":
    time.sleep(60)
if prompt == "fail":
    print("boom", file=sys.stderr); sys.exit(3)
if prompt == "notlogged":
    print(json.dumps({"type": "result", "is_error": True, "result": "Not logged in · Please run /login", "subtype": "success"}))
    sys.exit(1)
resumed = sys.argv[sys.argv.index("--resume") + 1] if "--resume" in sys.argv else ""
print(json.dumps({"result": "did: " + prompt + " in " + os.path.basename(os.getcwd()) + (" resumed " + resumed if resumed else ""),
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

    logs = tmp_path / "logs"
    (logs / "proj").mkdir(parents=True)
    runs = Runs(store, "PC", [("labs", str(work))], "claude", tmp_path / "out", popen=popen, logs=logs, procs=lambda: OPEN)
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


def test_claude_error_shows_its_message_not_json(tmp_path, monkeypatch):
    store, runs, work = setup(tmp_path, monkeypatch)
    cmd(store, "c1", action="start", folder=str(work), prompt="notlogged")
    c = wait_done(runs, "c1", store)
    assert c["status"] == "failed" and c["error"] == "Not logged in · Please run /login"


def test_message_to_a_closed_session_resumes_it(tmp_path, monkeypatch):
    store, runs, work = setup(tmp_path, monkeypatch)
    sub = work / "sub"
    sub.mkdir()
    cmd(store, "m1", action="message", sessionId="old-session", cwd=str(sub), prompt="carry on")
    c = wait_done(runs, "m1", store)
    assert c["status"] == "done" and c["result"] == "did: carry on in sub resumed old-session"


def line(kind, entry="sdk-cli", **kw):
    return json.dumps({"type": kind, "entrypoint": entry, **kw})


def test_last_turn_reads_the_log_end(tmp_path):
    from agent_bridge.runs import last_turn

    f = tmp_path / "s.jsonl"
    asked = line("user", "claude-desktop", message={"content": "do it"})
    tool = line("assistant", "claude-desktop", message={"stop_reason": "tool_use"})
    done = line("assistant", "claude-desktop", message={"stop_reason": "end_turn"})
    hook = line("system", "claude-desktop", subtype="stop_hook_summary")
    stop = line("user", "claude-desktop", message={"content": [{"type": "text", "text": "[Request interrupted by user]"}]})
    for rows, want in (([asked], (True, "claude-desktop")), ([asked, tool], (True, "claude-desktop")),
                       ([asked, done, hook, '{"type": "queue-operation"}'], (False, "claude-desktop")),
                       ([asked, stop], (False, "claude-desktop")), ([], (False, "")),
                       ([line("user", "cli", message={"content": "<local-command-stdout>Login successful</local-command-stdout>"})],
                        (False, "cli"))):
        f.write_text(chr(10).join(rows))
        assert last_turn(f)[:2] == want


def test_message_waits_for_the_turn_to_end_then_goes(tmp_path, monkeypatch):
    store, runs, work = setup(tmp_path, monkeypatch)
    log = tmp_path / "logs" / "proj" / "busy.jsonl"
    log.write_text(line("user", message={"content": "work"}))  # a turn is running
    cmd(store, "m1", action="message", sessionId="busy", cwd=str(work), prompt="later")
    runs.step()
    c = store.get("commands/m1")
    assert c["status"] == "waiting" and c["waitReason"] == "turn" and runs.procs == {}
    log.write_text(log.read_text() + chr(10) + line("assistant", message={"stop_reason": "end_turn"}))  # the turn ended
    assert wait_done(runs, "m1", store)["status"] == "done"


OPEN: list = []  # the claude processes the tests pretend are running: (session id or None, folder)


def test_open_or_closed_comes_from_the_processes(tmp_path):
    from agent_bridge.runs import log_wait_reason

    logs = tmp_path / "logs"
    (logs / "p").mkdir(parents=True)
    ended = lambda entry: line("assistant", entry, cwd="K:/w", message={"stop_reason": "end_turn"})
    (logs / "p" / "app.jsonl").write_text(ended("claude-desktop"))
    (logs / "p" / "term.jsonl").write_text(ended("cli"))
    (logs / "p" / "run.jsonl").write_text(ended("sdk-cli"))
    assert log_wait_reason(logs, "app", procs=lambda: [("app", "K:/w")]) == "app"  # the app runs it: open
    assert log_wait_reason(logs, "app", procs=lambda: []) is None  # no process: closed, the message goes
    assert log_wait_reason(logs, "term", procs=lambda: [(None, "K:\w")]) == "app"  # a terminal in its folder
    assert log_wait_reason(logs, "term", procs=lambda: [(None, "K:/other")]) is None
    assert log_wait_reason(logs, "run", procs=lambda: [(None, "K:/w")]) is None  # last turn was a headless run
    assert log_wait_reason(logs, "app", procs=lambda: None) == "app"  # no process list: the old guess


def test_message_to_a_session_open_in_the_app_waits(tmp_path, monkeypatch):
    store, runs, work = setup(tmp_path, monkeypatch)
    OPEN[:] = [("app", str(work))]
    log = tmp_path / "logs" / "proj" / "app.jsonl"
    log.write_text(line("assistant", "claude-desktop", message={"stop_reason": "end_turn"}))
    cmd(store, "m1", action="message", sessionId="app", cwd=str(work), prompt="hi")
    runs.step()
    runs.step()
    c = store.get("commands/m1")
    assert c["status"] == "waiting" and c["waitReason"] == "app" and runs.procs == {}
    store.update("commands/m1", {"force": True})  # the owner taps Send anyway
    assert wait_done(runs, "m1", store)["status"] == "done"
    OPEN.clear()


def test_send_anyway_never_jumps_a_running_turn(tmp_path, monkeypatch):
    store, runs, work = setup(tmp_path, monkeypatch)
    (tmp_path / "logs" / "proj" / "busy.jsonl").write_text(line("user", "claude-desktop", message={"content": "work"}))
    cmd(store, "m1", action="message", sessionId="busy", cwd=str(work), prompt="hi", force=True)
    runs.step()
    assert store.get("commands/m1")["waitReason"] == "turn" and runs.procs == {}


def test_message_outside_registered_folders_is_refused(tmp_path, monkeypatch):
    store, runs, work = setup(tmp_path, monkeypatch)
    cmd(store, "m1", action="message", sessionId="s", cwd=str(tmp_path), prompt="x")
    runs.step()
    assert store.get("commands/m1")["status"] == "failed" and runs.procs == {}


def test_message_command_shape():
    c = message_command("claude", "hi", "sid")
    assert c[:3] == ["claude", "-p", "hi"] and c[c.index("--resume") + 1] == "sid" and APPROVAL_TOOL in c
