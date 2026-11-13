import json
import sys
import time

from agent_bridge.inbox import approval_reply
from agent_bridge.texts import Texts
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
if prompt == "nosession":
    print("No conversation found with session ID: abc", file=sys.stderr)
    print(json.dumps({"type": "result", "subtype": "error_during_execution", "is_error": True, "num_turns": 0,
                      "errors": ["No conversation found with session ID: abc"]}))
    sys.exit(1)
if prompt.startswith("limit") or prompt.endswith("limit"):
    print(json.dumps({"type": "result", "is_error": True, "api_error_status": 429, "api_error": "usage_limit_reached",
                      "result": "You've hit your 5-hour limit · resets 5:30pm (Asia/Ho_Chi_Minh)"}))
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
    assert c["status"] == "done" and c["costUsd"] == 0.12 and "result" not in c  # the result stays on the PC
    assert Texts(None, tmp_path / "out").run("c1")["text"] == "did: hello in work"
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


def test_runs_lost_by_a_restart_are_marked_or_finished_from_their_out_file(tmp_path):
    store = FakeStore()
    store.put_many({"commands/c1": {"id": "c1", "machine": "PC", "status": "running"},
                    "commands/c2": {"id": "c2", "machine": "PC", "status": "running", "inboxId": "q1"},
                    "commands/c3": {"id": "c3", "machine": "PC", "status": "running"},
                    "inbox/q1": {"id": "q1", "status": "delivering"}})
    (tmp_path / "c2.out").write_text(json.dumps({"result": "all done", "total_cost_usd": 0.5}), encoding="utf-8")
    (tmp_path / "c3.out").write_text("", encoding="utf-8")  # the run was cut before claude wrote its result
    log = Runs(store, "PC", [], "claude", tmp_path).forget_lost()
    assert store.get("commands/c1")["status"] == "lost" and store.get("commands/c3")["status"] == "lost"
    c2 = store.get("commands/c2")
    assert c2["status"] == "done" and c2["costUsd"] == 0.5 and "result" not in c2
    assert store.get("inbox/q1")["status"] == "delivered" and store.get("inbox/q1")["deliveredVia"] == "resume"
    assert any("c2: done" in x and "finished from its .out" in x for x in log) and sum("lost" in x for x in log) == 2


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


def test_claude_error_with_no_result_shows_its_errors(tmp_path, monkeypatch):
    # runs 93b4759d to 291358a9 (2026-11-12) showed only "claude reported an error"
    store, runs, work = setup(tmp_path, monkeypatch)
    cmd(store, "c1", action="start", folder=str(work), prompt="nosession")
    c = wait_done(runs, "c1", store)
    assert c["status"] == "failed" and c["error"] == "No conversation found with session ID: abc"


def test_answer_to_a_gone_session_closes_it_and_its_siblings_no_retry(tmp_path, monkeypatch):
    # 2026-11-13: 3 answers to session 8143f4fb retried every 10 minutes, 9 failed runs; the owner: "close and no rerty
    # for same orphan cases"
    store, runs, work = setup(tmp_path, monkeypatch)
    store.put_many({"inbox/q1": {"id": "q1", "status": "delivering", "sessionId": "gone", "machine": "PC"},
                    "inbox/q2": {"id": "q2", "status": "answered", "sessionId": "gone", "machine": "PC"},
                    "inbox/q3": {"id": "q3", "status": "answered", "sessionId": "other", "machine": "PC"}})
    cmd(store, "m1", action="message", sessionId="gone", cwd=str(work), prompt="nosession", inboxId="q1")
    assert wait_done(runs, "m1", store)["status"] == "failed"
    assert store.get("inbox/q1")["status"] == "closed" and store.get("inbox/q2")["status"] == "closed"
    assert "not retried" in store.get("inbox/q1")["error"]
    assert store.get("inbox/q3")["status"] == "answered"  # another session's answer is left alone


def test_message_to_a_closed_session_resumes_it(tmp_path, monkeypatch):
    store, runs, work = setup(tmp_path, monkeypatch)
    sub = work / "sub"
    sub.mkdir()
    cmd(store, "m1", action="message", sessionId="old-session", cwd=str(sub), prompt="carry on")
    c = wait_done(runs, "m1", store)
    assert c["status"] == "done" and Texts(None, tmp_path / "out").run("m1")["text"] == "did: carry on in sub resumed old-session"


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
    OPEN[:] = [("busy", str(work))]  # in a process that holds the session
    cmd(store, "m1", action="message", sessionId="busy", cwd=str(work), prompt="later")
    runs.step()
    c = store.get("commands/m1")
    assert c["status"] == "waiting" and c["waitReason"] == "turn" and runs.procs == {}
    log.write_text(log.read_text() + chr(10) + line("assistant", message={"stop_reason": "end_turn"}))  # the turn ended
    OPEN.clear()  # and the process went away
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
    assert log_wait_reason(logs, "term", procs=lambda: [(None, r"K:\w")]) == "app"  # a terminal in its folder
    assert log_wait_reason(logs, "term", procs=lambda: [(None, "K:/other")]) is None
    assert log_wait_reason(logs, "run", procs=lambda: [(None, "K:/w")]) is None  # last turn was a headless run
    assert log_wait_reason(logs, "app", procs=lambda: None) == "app"  # no process list: the old guess
    (logs / "p" / "cut.jsonl").write_text(line("user", "claude-desktop", cwd="K:/w", message={"content": "<task-notification>"}))
    assert log_wait_reason(logs, "cut", procs=lambda: []) is None  # no turn end, but no process: cut off, closed
    assert log_wait_reason(logs, "cut", procs=lambda: [("cut", "K:/w")]) == "turn"


def test_two_messages_to_one_session_go_oldest_first(tmp_path, monkeypatch):
    store, runs, work = setup(tmp_path, monkeypatch)
    OPEN.clear()
    # the newer one comes back first, as a random document id can make Firestore do
    cmd(store, "zz2", action="message", sessionId="s", cwd=str(work), prompt="second", createdAt="2026-11-02T01:00:01Z")
    cmd(store, "aa1", action="message", sessionId="s", cwd=str(work), prompt="first", createdAt="2026-11-02T01:00:00Z")
    runs.step()
    assert store.get("commands/aa1")["status"] == "running"
    assert store.get("commands/zz2")["status"] == "waiting" and store.get("commands/zz2")["waitReason"] == "turn"
    assert wait_done(runs, "aa1", store)["status"] == "done"
    assert wait_done(runs, "zz2", store)["status"] == "done" and "did: second" in Texts(None, tmp_path / "out").run("zz2")["text"]


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
    OPEN[:] = [("busy", str(work))]
    cmd(store, "m1", action="message", sessionId="busy", cwd=str(work), prompt="hi", force=True)
    runs.step()
    assert store.get("commands/m1")["waitReason"] == "turn" and runs.procs == {}
    OPEN.clear()


def test_message_outside_registered_folders_is_refused(tmp_path, monkeypatch):
    store, runs, work = setup(tmp_path, monkeypatch)
    cmd(store, "m1", action="message", sessionId="s", cwd=str(tmp_path), prompt="x")
    runs.step()
    assert store.get("commands/m1")["status"] == "failed" and runs.procs == {}


def test_message_command_shape():
    c = message_command("claude", "hi", "sid")
    assert c[:3] == ["claude", "-p", "hi"] and c[c.index("--resume") + 1] == "sid" and APPROVAL_TOOL in c


def test_one_setting_picks_the_mode_for_every_run(tmp_path):
    # Manual unless meta/runs says "auto"; bypass is never passed, whatever the setting holds
    assert "--permission-mode" not in message_command("claude", "hi", "sid")
    for mode in ("bypassPermissions", "dontAsk", "acceptEdits", ""):
        assert "--permission-mode" not in start_command("claude", "x", "sid", mode)
    auto = message_command("claude", "hi", "sid", "auto")
    assert auto[auto.index("--permission-mode") + 1] == "auto" and APPROVAL_TOOL in auto
    store = FakeStore()
    runs = Runs(store, "PC", [], "claude", tmp_path)
    assert runs.mode() == "manual"
    store.put_many({"meta/runs": {"permissionMode": "bypassPermissions"}})
    assert runs.mode() == "manual"
    store.put_many({"meta/runs": {"permissionMode": "auto"}})
    assert runs.mode() == "auto"


def test_an_answer_message_writes_its_outcome_on_the_inbox_item(tmp_path, monkeypatch):
    store, runs, work = setup(tmp_path, monkeypatch)
    store.put_many({"inbox/q1": {"id": "q1", "status": "delivering"}})
    OPEN[:] = [("app", str(work))]
    (tmp_path / "logs" / "proj" / "app.jsonl").write_text(line("assistant", "claude-desktop", message={"stop_reason": "end_turn"}))
    cmd(store, "m1", action="message", sessionId="app", cwd=str(work), prompt="The owner answered", inboxId="q1")
    runs.step()
    assert store.get("inbox/q1")["waitReason"] == "app"  # the inbox page shows why it waits
    OPEN.clear()  # the owner closed the window
    assert wait_done(runs, "m1", store)["status"] == "done"
    q = store.get("inbox/q1")
    assert q["status"] == "delivered" and q["deliveredVia"] == "resume" and "followUp" not in q  # the reply is read from the PC
    assert Texts(None, tmp_path / "out").run("m1")["text"].startswith("did: The owner answered")
    assert q["waitReason"] is None


def test_check_now_writes_what_the_rule_sees(tmp_path, monkeypatch):
    store, runs, work = setup(tmp_path, monkeypatch)
    (tmp_path / "logs" / "proj" / "s.jsonl").write_text(line("user", "claude-desktop", message={"content": "work"}))
    cmd(store, "k1", action="check", sessionId="s")
    runs.step()
    c = store.get("commands/k1")
    assert c["status"] == "done" and c["check"]["lastFrom"] == "claude-desktop"
    # no claude process carries this made-up id, so the turn with no end counts as cut off
    assert c["check"]["open"] is False and c["check"]["turn"] is False


def test_a_run_deleted_while_it_runs_is_not_written_back(tmp_path, monkeypatch):
    store, runs, work = setup(tmp_path, monkeypatch)
    cmd(store, "c1", action="start", folder=str(work), prompt="hello")
    runs.step()
    store.delete("commands/c1")
    end = time.time() + 20
    while runs.procs and time.time() < end:
        runs.step()
        time.sleep(0.2)
    assert not runs.procs and store.get("commands/c1") is None


def test_a_stop_sent_by_delete_kills_the_run_and_leaves_no_record(tmp_path, monkeypatch):
    store, runs, work = setup(tmp_path, monkeypatch)
    cmd(store, "c1", action="start", folder=str(work), prompt="sleep")
    runs.step()
    assert runs.procs["c1"].poll() is None
    store.delete("commands/c1")
    cmd(store, "x1", action="stop", target="c1", deleting=True)
    runs.step()
    assert runs.procs.get("c1") is None or runs.procs["c1"].wait(10) is not None
    runs.step()
    assert not runs.procs and store.get("commands/c1") is None and store.get("commands/x1") is None


def test_a_message_waiting_a_minute_for_the_app_asks_the_archiver_and_unarchives_after_it_runs(tmp_path, monkeypatch):
    from datetime import datetime, timedelta, timezone
    from agent_bridge.archiver import Hand
    store, runs, work = setup(tmp_path, monkeypatch)
    hand = Hand(runs.archiver.folder, "arch")
    hand.take(0)
    held = {"v": "app"}
    monkeypatch.setattr(runs, "wait_reason", lambda sid, force=False: held["v"])
    cmd(store, "m1", action="message", sessionId="s1", cwd=str(work), prompt="hi")
    runs.step()
    assert store.get("commands/m1")["status"] == "waiting" and runs.archiver.of("m1") == ""
    old = (datetime.now(timezone.utc) - timedelta(seconds=61)).isoformat()
    store.update("commands/m1", {"waitingSince": old})
    runs.step([store.get("commands/m1")])
    assert runs.archiver.of("m1") == "asked" and store.get("commands/m1")["archive"] == "asked"
    assert hand.take(1, poll=0.05)["action"] == "archive"
    hand.report("m1", "archive", True, app_session="local_s1")
    runs.step([])
    assert store.get("commands/m1")["archive"] == "archived"
    held["v"] = None  # the app process is gone: the bridge sends
    runs.step([store.get("commands/m1")])
    assert store.get("commands/m1")["status"] == "running" and store.get("commands/m1")["archive"] == "unarchiving"
    assert hand.take(1, poll=0.05)["action"] == "unarchive"


def test_a_message_on_an_older_plan_brings_it_to_the_latest_format_first(tmp_path, monkeypatch):
    store, runs, work = setup(tmp_path, monkeypatch)
    store.put_many({"plans/old": {"id": "old", "title": "Old plan", "sessionId": "old-s", "machine": "PC", "cwd": str(work),
                                  "status": "done", "current": 5, "closeNote": "approved"}})
    cmd(store, "m1", action="message", sessionId="old-s", cwd=str(work), planId="old", generate={"kinds": ["chart"]},
        prompt="Save each file in .plan_data/old/v5/tmp/ please", createdAt="1")
    runs.step()
    m = store.get("commands/m1")
    up = store.get(f"commands/{m['upgradeId']}")
    assert m["status"] == "waiting" and m["waitReason"] == "upgrade"
    assert up["action"] == "plan" and up["sourceSessionId"] == "old-s" and up["upgradeOf"] == "old"
    runs.step()  # the plan from the session is still going: the message keeps waiting
    assert store.get("commands/m1")["status"] == "waiting"
    store.put_many({"plans/new": {"id": "new", "title": "New plan", "kind": "parts", "sessionId": "new-s", "machine": "PC",
                                  "cwd": str(work), "status": "open", "current": 1}})
    store.update(f"commands/{m['upgradeId']}", {"status": "done", "planId": "new"})
    c = wait_done(runs, "m1", store)
    assert c["status"] == "done" and c["planId"] == "new" and c["upgradedFrom"] == "old"
    text = Texts(None, tmp_path / "out").run("m1")["text"]
    assert text.endswith("resumed new-s") and ".plan_data/new/v1/tmp/" in text
    old = store.get("plans/old")
    assert old["status"] == "done" and old["upgradedTo"] == "new" and "plan new" in old["closeNote"]


def test_a_failed_upgrade_fails_the_message_with_its_reason(tmp_path, monkeypatch):
    store, runs, work = setup(tmp_path, monkeypatch)
    store.put_many({"plans/old": {"id": "old", "title": "Old", "sessionId": "old-s", "machine": "PC", "cwd": str(work),
                                  "status": "open", "current": 2}})
    cmd(store, "m1", action="message", sessionId="old-s", cwd=str(work), planId="old", prompt="resume", createdAt="1")
    runs.step()
    store.update(f"commands/{store.get('commands/m1')['upgradeId']}", {"status": "failed", "error": "no log"})
    runs.step()
    m = store.get("commands/m1")
    assert m["status"] == "failed" and "latest format" in m["error"] and "no log" in m["error"]
    assert store.get("plans/old")["status"] == "open"


def test_a_plan_below_the_format_number_is_rebuilt_and_one_at_it_is_not(tmp_path, monkeypatch):
    import agent_bridge.runs as r
    store, runs, work = setup(tmp_path, monkeypatch)
    base = {"title": "P", "sessionId": "s", "machine": "PC", "cwd": str(work), "status": "open", "current": 1, "kind": "parts"}
    store.put_many({"plans/a": {"id": "a", **base}, "plans/b": {"id": "b", **base, "format": 2}})
    monkeypatch.setattr(r, "PLAN_FORMAT", 2)
    assert runs._upgrade_first({"id": "m1", "planId": "b"}) == (True, None)
    store.put_many({"commands/m2": {"id": "m2"}})
    go, _ = runs._upgrade_first({"id": "m2", "planId": "a"})  # parts but no number: format 1, below 2
    assert not go and store.get("commands/m2")["waitReason"] == "upgrade"


def test_model_and_effort_come_from_the_run_or_the_setting(tmp_path, monkeypatch):
    from agent_bridge.runs import model_args

    assert model_args("opus", "high") == ["--model", "opus", "--effort", "high"]
    assert model_args("", "") == [] and model_args("rm -rf", "huge") == []  # nothing odd reaches the CLI
    c = start_command("claude", "x", "sid", "manual", "sonnet", "low")
    assert c[c.index("--model") + 1] == "sonnet" and c[c.index("--effort") + 1] == "low"
    assert "--model" not in message_command("claude", "hi", "sid")
    store, runs, work = setup(tmp_path, monkeypatch)
    store.put_many({"meta/runs": {"permissionMode": "manual", "model": "opus", "effort": "high"}})
    assert runs.run_with({"id": "c"}) == ("claude-opus-5-5", "high")  # the setting, an old alias made exact
    assert runs.run_with({"id": "c", "model": "claude-haiku-5-5", "effort": "low"}) == ("claude-haiku-5-5", "low")
    assert runs.run_with({"id": "c", "model": "x y", "effort": "huge"}) == ("claude-opus-5-5", "high")  # bad: the setting
    store.put_many({"meta/runs": {"permissionMode": "manual"}})
    assert runs.run_with({"id": "c"}) == ("claude-opus-5-5", "medium")  # never the CLI default: the owner's picks
    store.put_many({"meta/runs": {"permissionMode": "manual", "model": "opus", "effort": "high"}})
    cmd(store, "c1", action="start", folder=str(work), prompt="hello", model="claude-sonnet-5-5")
    runs.step()
    c = store.get("commands/c1")
    assert c["model"] == "claude-sonnet-5-5" and c["effort"] == "high"
    c = start_command("claude", "x", "sid", "manual", *runs.run_with({"id": "c"}))
    assert c[c.index("--model") + 1] == "claude-opus-5-5" and c[c.index("--effort") + 1] == "high"


def test_a_one_off_start_keeps_no_session():
    assert "--no-session-persistence" in start_command("claude", "x", "sid", keep=False)
    assert "--no-session-persistence" not in start_command("claude", "x", "sid")


def test_a_message_over_the_size_goes_to_a_fresh_session_with_a_handoff(tmp_path, monkeypatch):
    store, runs, work = setup(tmp_path, monkeypatch)
    log = tmp_path / "logs" / "proj" / "old-session.jsonl"
    log.write_text("\n".join(json.dumps(x) for x in [
        {"type": "user", "timestamp": "2026-11-10T01:00:00Z", "origin": {"kind": "human"}, "message": {"content": "first ask"}},
        {"type": "assistant", "timestamp": "2026-11-10T01:00:05Z", "message": {"id": "a1", "model": "m", "content": [{"type": "text", "text": "first reply"}],
                                                                                "usage": {"input_tokens": 5, "cache_read_input_tokens": 350000}}},
        {"type": "assistant", "timestamp": "2026-11-10T01:00:06Z", "message": {"stop_reason": "end_turn", "model": "m", "content": []}},
    ]) + "\n", encoding="utf-8")
    store.put_many({"plans/pl": {"id": "pl", "sessionId": "old-session", "status": "open", "kind": "parts", "format": 1}})
    cmd(store, "m1", action="message", sessionId="old-session", cwd=str(work), prompt="carry on", planId="pl", kind="qa")
    line = runs.step()[0]
    assert "fresh session" in line and "handoff from old-session" in line and "350,005 tokens" in line
    c = store.get("commands/m1")
    assert c["freshFrom"] == "old-session" and c["sessionId"] != "old-session" and c["contextTokens"] == 350005
    assert store.get("plans/pl")["sessionId"] == c["sessionId"] and store.get("plans/pl")["previousSessionId"] == "old-session"
    c = wait_done(runs, "m1", store)
    assert c["status"] == "done" and "first reply" in Texts(None, tmp_path / "out").run("m1")["text"]  # the handoff reached claude
    # under the size, or "never": resume as before
    store.put_many({"meta/runs": {"freshOver": 1000000}})
    cmd(store, "m2", action="message", sessionId="old-session", cwd=str(work), prompt="again")
    assert "sent to session old-session" in runs.step()[0]
    wait_done(runs, "m2", store)
    cmd(store, "m3", action="message", sessionId="old-session", cwd=str(work), prompt="again", fresh="always")
    runs.step()
    assert store.get("commands/m3")["freshFrom"] == "old-session"  # "always" wins over the size rule
    wait_done(runs, "m3", store)
    store.put_many({"meta/runs": {"freshOver": 10}})
    cmd(store, "m4", action="message", sessionId="old-session", cwd=str(work), prompt="again", fresh="never")
    runs.step()
    assert store.get("commands/m4")["sessionId"] == "old-session" and "freshFrom" not in store.get("commands/m4")  # "never" resumes
    wait_done(runs, "m4", store)


def test_every_run_carries_the_owners_reply_style_once():
    from agent_bridge.planfrom import STYLE

    for c in (start_command("claude", "x", "sid"), message_command("claude", "hi", "sid"),
              message_command("claude", "hi", "sid", kind="qa"), message_command("claude", "hi", "sid", step="s3"),
              start_command("claude", "x", "sid", kind="qa", step="s3")):
        assert c.count("--append-system-prompt") == 1
        text = c[c.index("--append-system-prompt") + 1]
        assert text.startswith(STYLE)
    # the scope rides in the message (the owner's pick, 2026-11-12: "Scope in the message text"), never the system prompt
    m = message_command("claude", "hi", "sid", step="s3")
    assert "step s3" in m[2] and m[2].endswith("\n\nhi") and "step s3" not in m[m.index("--append-system-prompt") + 1]
    assert start_command("claude", "x", "sid", step="s3")[2].startswith("<run-scope>")
    assert message_command("claude", "hi", "sid")[2] == "hi"
    qa = message_command("claude", "hi", "sid", kind="qa")
    assert "--disallowedTools" in qa and "Ask about the plan" in " ".join(qa) or "--disallowedTools" in qa


def test_a_refused_end_write_keeps_the_run_and_writes_it_on_the_next_step(tmp_path, monkeypatch):
    # run 18442aa6 (2026-11-11) stayed "running" for hours: its end write met Firestore's 429 and the run was forgotten
    store, runs, work = setup(tmp_path, monkeypatch)
    cmd(store, "c1", action="start", folder=str(work), prompt="hi")
    real, refused = store.update, []

    def update(path, fields):
        if path == "commands/c1" and "endedAt" in fields and not refused:
            refused.append(path)
            raise SystemExit("Firestore refused (429): Quota exceeded.")
        return real(path, fields)

    monkeypatch.setattr(store, "update", update)
    end = time.time() + 20
    while not refused and time.time() < end:
        try:
            runs.step()
        except SystemExit:
            pass
        time.sleep(0.2)
    assert refused and "c1" in runs.procs and store.get("commands/c1")["status"] == "running"
    runs.step()
    assert store.get("commands/c1")["status"] == "done" and "c1" not in runs.procs


def test_waiting_message_reads_the_running_session_once_and_settings_from_the_listen(tmp_path, monkeypatch):
    # p16 (owner pick 2026-11-12: "Add step: read once, then listen"): a message waiting for a turn cost 2 reads a step
    store, runs, work = setup(tmp_path, monkeypatch)

    class Busy:
        pid = 1
        returncode = None
        def poll(self): return None

    store.put_many({"commands/r1": {"id": "r1", "machine": "PC", "status": "running", "sessionId": "busy"}})
    runs.procs["r1"] = Busy()
    prefs = [{"id": "runs", "model": "claude-opus-5-5", "effort": "high", "freshOver": 999999999}]

    class Feed:
        def current(self): return prefs
    runs.prefs_feed = Feed()
    reads = []
    get = store.get
    store.get = lambda path: reads.append(path) or get(path)
    cmd(store, "m1", action="message", sessionId="busy", cwd=str(work), prompt="later")
    for _ in range(10):
        runs.step([store.get("commands/m1")])
    assert store.get("commands/m1")["status"] == "waiting"
    assert reads.count("commands/r1") == 1 and reads.count("meta/runs") == 0
    assert runs.run_with({})[1] == "high"
    prefs[0]["effort"] = "low"  # the owner changes the setting on the page: the listen brings it
    assert runs.run_with({})[1] == "low"
    runs.prefs_feed = None  # no listen: read the document as before
    assert runs.prefs() == {} and reads.count("meta/runs") == 1


def _line(ts, mid, model="claude-opus-5-5", out=1000, read=0, sid="s1"):
    return json.dumps({"type": "assistant", "timestamp": ts, "sessionId": sid,
                       "message": {"id": mid, "model": model, "usage": {"input_tokens": 0, "output_tokens": out,
                                   "cache_read_input_tokens": read, "cache_creation": {"ephemeral_5m_input_tokens": 0,
                                                                                       "ephemeral_1h_input_tokens": 0}}}})


def test_run_cost_counts_only_the_runs_own_messages(tmp_path):
    # step i1: claude's total_cost_usd on a resume is the session's running total; the run costs only its own lines
    from agent_bridge.runs import run_cost

    logs = tmp_path / "logs"
    (logs / "p" / "s1" / "subagents").mkdir(parents=True)
    (logs / "p" / "s1.jsonl").write_text("\n".join([
        _line("2026-11-12T01:00:00Z", "old", out=1_000_000),  # before the run: a repeated old message
        _line("2026-11-12T02:00:10Z", "m1", out=500), _line("2026-11-12T02:00:11Z", "m1", out=1000),  # streamed twice
        _line("2026-11-12T03:00:00Z", "late", out=1_000_000),  # after the run
    ]) + "\n", encoding="utf-8")
    (logs / "p" / "s1" / "subagents" / "a.jsonl").write_text(_line("2026-11-12T02:00:20Z", "sub", out=1000) + "\n",
                                                             encoding="utf-8")
    c = {"action": "message", "sessionId": "s1", "startedAt": "2026-11-12T02:00:00+00:00"}
    got = run_cost(logs, {"session_id": "s1", "total_cost_usd": 1182.04}, c, "2026-11-12T02:01:00+00:00")
    assert got == {"costUsd": 0.04, "costFrom": "log"}  # 2,000 output tokens at $20 per million


def test_run_cost_without_a_log(tmp_path):
    from agent_bridge.runs import run_cost

    fresh = run_cost(tmp_path, {"total_cost_usd": 0.5}, {"action": "start", "startedAt": "2026-11-12T02:00:00+00:00"},
                     "2026-11-12T02:01:00+00:00")
    assert fresh == {"costUsd": 0.5, "costFrom": "claude"}  # a one-off Start keeps no log: claude's figure is its own
    msg = run_cost(tmp_path, {"total_cost_usd": 1182.04}, {"action": "message", "sessionId": "x",
                   "startedAt": "2026-11-12T02:00:00+00:00"}, "2026-11-12T02:01:00+00:00")
    assert msg == {}  # a resumed run with no log: no cost rather than the session's running total


def test_run_cost_window_ends_when_claude_wrote_its_result(tmp_path):
    # an end written hours late (a 429 on the write) must not take in the session's later runs
    from agent_bridge.runs import run_cost

    logs = tmp_path / "logs"
    (logs / "p").mkdir(parents=True)
    (logs / "p" / "s1.jsonl").write_text("\n".join([
        _line("2026-11-12T02:00:10Z", "m1", out=1000), _line("2026-11-12T05:00:00Z", "next", out=1_000_000)]) + "\n",
        encoding="utf-8")
    c = {"action": "message", "sessionId": "s1", "startedAt": "2026-11-12T02:00:00+00:00"}
    got = run_cost(logs, {"session_id": "s1"}, c, "2026-11-12T11:00:00+00:00", "2026-11-12T02:00:30+00:00")
    assert got == {"costUsd": 0.02, "costFrom": "log"}


def test_a_restart_keeps_following_a_live_run(tmp_path, monkeypatch):
    # i10, "Adopt live runs": the new bridge follows a run whose claude still lives; no lost, no second run
    import subprocess
    from datetime import datetime, timezone

    import agent_bridge.runs as R

    store, runs, work = setup(tmp_path, monkeypatch)
    p = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(1.5)"])
    started = datetime.now(timezone.utc).isoformat(timespec="seconds")
    cmd(store, "c9", action="message", status="running", sessionId="s9", pid=p.pid, startedAt=started)
    (tmp_path / "out").mkdir(exist_ok=True)
    monkeypatch.setattr(R, "live_claude", lambda pid, st, slack=120.0: __import__("psutil").Process(pid) if pid == p.pid else None)
    log = runs.forget_lost()
    assert any("followed again" in x for x in log) and store.get("commands/c9")["status"] == "running"
    p.wait()
    (tmp_path / "out" / "c9.out").write_text(json.dumps({"result": "ok", "total_cost_usd": 0.1}), encoding="utf-8")
    c = wait_done(runs, "c9", store)
    assert c["status"] == "done"


def test_live_claude_refuses_a_reused_pid():
    import os
    from agent_bridge.runs import live_claude

    assert live_claude(os.getpid(), "2026-11-12T00:00:00+00:00") is None  # python, not claude, and not that start
    assert live_claude(None, "") is None


def test_a_restart_keeps_following_a_live_run(tmp_path, monkeypatch):
    # i10, "Adopt live runs": the new bridge follows a run whose claude still lives; no lost, no second run
    import subprocess
    from datetime import datetime, timezone

    import agent_bridge.runs as R

    store, runs, work = setup(tmp_path, monkeypatch)
    p = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(1.5)"])
    started = datetime.now(timezone.utc).isoformat(timespec="seconds")
    cmd(store, "c9", action="message", status="running", sessionId="s9", pid=p.pid, startedAt=started)
    (tmp_path / "out").mkdir(exist_ok=True)
    monkeypatch.setattr(R, "live_claude", lambda pid, st, slack=120.0: __import__("psutil").Process(pid) if pid == p.pid else None)
    log = runs.forget_lost()
    assert any("followed again" in x for x in log) and store.get("commands/c9")["status"] == "running"
    p.wait()
    (tmp_path / "out" / "c9.out").write_text(json.dumps({"result": "ok", "total_cost_usd": 0.1}), encoding="utf-8")
    c = wait_done(runs, "c9", store)
    assert c["status"] == "done"


def test_live_claude_refuses_a_reused_pid():
    import os
    from agent_bridge.runs import live_claude

    assert live_claude(os.getpid(), "2026-11-12T00:00:00+00:00") is None  # python, not claude, and not that start
    assert live_claude(None, "") is None


class _Push:
    def __init__(self):
        self.sent = []

    def notify(self, title, body, url="/", tag=""):
        self.sent.append((title, body, url, tag))
        return 1


def test_a_message_waiting_3_minutes_for_an_app_session_pushes_once(tmp_path, monkeypatch):
    # i9, "Keep waiting, push me": one push after 3 minutes, the message keeps waiting and goes when the session closes
    from datetime import datetime, timedelta, timezone

    store, runs, work = setup(tmp_path, monkeypatch)
    runs.push = _Push()
    OPEN[:] = [("app", str(work))]
    (tmp_path / "logs" / "proj" / "app.jsonl").write_text(line("assistant", "claude-desktop", message={"stop_reason": "end_turn"}))
    store.put_many({"sessions/app": {"title": "Zombie Coop FPS"}})
    cmd(store, "m1", action="message", sessionId="app", cwd=str(work), prompt="hi")
    runs.step()
    assert store.get("commands/m1")["status"] == "waiting" and runs.push.sent == []
    old = (datetime.now(timezone.utc) - timedelta(seconds=200)).isoformat(timespec="seconds")
    store.update("commands/m1", {"waitingSince": old})
    runs.step()
    runs.step()
    c = store.get("commands/m1")
    assert c["status"] == "waiting" and c["closePushed"] and len(runs.push.sent) == 1  # once, still waiting
    assert "Zombie Coop FPS" in runs.push.sent[0][1] and runs.push.sent[0][2] == "/?run=m1"
    OPEN.clear()  # the owner closed it in the app
    assert wait_done(runs, "m1", store)["status"] == "done" and len(runs.push.sent) == 2  # the second is the run's end
