import json

import pytest

from agent_bridge.digest import chain, records, session_record, write_pages
from agent_bridge.inbox import Inbox, check_example
from agent_bridge.planfrom import kind_args, mark_quotes
from agent_bridge.runs import message_command
from test_inbox import FakeStore
from test_runs import cmd, setup, wait_done

PARTS = {"goal": "ship it (#1)", "summary": "- built x (#2)", "rules": [{"rule": "no bypass", "source": "#1"}],
         "lessons": [{"lesson": "sort the queue", "taught_by": "#3", "applied_in": "runs.py"}],
         "leftover": ["read count"], "steps": [{"id": "s1", "title": "Count reads", "does": "count", "check": "a number"}]}
EX = {"type": "text", "draft": "the draft"}


def entry(kind, content, **f):
    return json.dumps({"type": kind, "timestamp": "2026-11-03T01:00:00Z", "message": {"content": content}, **f})


def write_log(folder):
    log = folder / "proj" / "s1.jsonl"
    log.parent.mkdir(parents=True)
    log.write_text("\n".join([
        entry("user", "build the plan"),
        entry("user", "<system-reminder>x</system-reminder>"),
        entry("user", "summary of before", isCompactSummary=True),
        entry("assistant", [{"type": "thinking", "thinking": "hidden"}, {"type": "text", "text": "On it."},
                            {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "ls"}}]),
        entry("user", [{"type": "tool_result", "tool_use_id": "t1", "content": [{"type": "text", "text": "a.py"}, {"type": "image"}]}]),
        json.dumps({"type": "file-history-snapshot", "snapshot": "x" * 100}),
    ]), encoding="utf-8")
    sub = folder / "proj" / "s1" / "subagents"
    sub.mkdir(parents=True)
    (sub / "agent-a1.jsonl").write_text(entry("assistant", [{"type": "text", "text": "first"}]) + "\n"
                                        + entry("assistant", [{"type": "text", "text": "final report"}]), encoding="utf-8")
    (sub / "agent-a1.meta.json").write_text(json.dumps({"description": "check x"}), encoding="utf-8")
    return log


def test_the_real_record_keeps_words_calls_outputs_and_subagent_reports(tmp_path):
    rec = records(write_log(tmp_path))
    labels = [r[1] for r in rec]
    assert labels == ["OWNER", "CONTEXT SUMMARY (written by Claude, not the owner)", "CLAUDE", "CALL Bash",
                      "OUTPUT Bash", "SUBAGENT agent-a1"]
    assert rec[0][2] == "build the plan" and rec[4][2] == "a.py\n[image]"
    assert "final report" in rec[5][2] and "first" not in rec[5][2] and "check x" in rec[5][2]
    assert not any("hidden" in r[2] or "system-reminder" in r[2] for r in rec)


def test_pages_hold_every_entry_and_split_a_huge_one(tmp_path):
    log = write_log(tmp_path)
    pages = write_pages(log, tmp_path / "out", page_bytes=200)
    text = "".join((tmp_path / "out" / p["file"]).read_text(encoding="utf-8") for p in pages)
    for n in range(1, 7):
        assert f"#{n} " in text
    assert pages[0]["first"] == 1 and pages[-1]["last"] == 6 and all(p["bytes"] <= 200 for p in pages)
    big = tmp_path / "big"
    big.mkdir()
    (big / "p").mkdir()
    (big / "p" / "s.jsonl").write_text(entry("user", "y" * 1000), encoding="utf-8")
    pages = write_pages(big / "p" / "s.jsonl", tmp_path / "out2", page_bytes=300)
    assert len(pages) >= 4 and "continues on the next page" in (tmp_path / "out2" / "page-01.txt").read_text(encoding="utf-8")
    assert sum((tmp_path / "out2" / p["file"]).read_text(encoding="utf-8").count("y") for p in pages) == 1000


def test_every_option_of_a_plan_question_needs_an_example():
    assert check_example(None) == "no example"
    assert check_example({"type": "image", "before": "a.png"}) is not None
    assert check_example({"type": "image", "before": "a.png", "after": "b.png"}) is None
    assert check_example({"type": "code", "diff": "-a\n+b"}) is not None  # no benchmark
    assert check_example({"type": "code", "diff": "-a\n+b", "bench": [{"name": "t", "before": "1", "after": "2"}]}) is not None
    assert check_example({"type": "code", "diff": "-a\n+b", "bench": [{"name": "t", "measured": False}]}) is None
    assert check_example({"type": "text", "draft": " "}) is not None
    store = FakeStore()
    ib = Inbox(store, "PC", [], "s1", "/x")
    ib.post("question", "free", "no plan, no example needed", [{"label": "A", "differs": "d"}])
    ib.plan_start("p", parts=PARTS)
    with pytest.raises(ValueError, match="needs an example"):
        ib.post("question", "q", "x", [{"label": "A", "differs": "d", "example": EX}, {"label": "B", "differs": "d"}])
    qid = ib.post("question", "q", "x", [{"label": "A", "differs": "d", "example": EX}])
    assert store.docs[f"inbox/{qid}"]["options"][0]["example"] == EX


def test_parts_plan_versions_change_on_data_never_on_a_step():
    store = FakeStore()
    store.put_many({"commands/c1": {"id": "c1", "action": "plan", "sourceSessionId": "old", "pagesDir": "D:/p",
                                    "pages": [{"file": "page-01.txt", "first": 1, "last": 9}]}})
    ib = Inbox(store, "PC", [], "s1", "/x")
    pid = ib.plan_start("From old", parts=PARTS, source="c1")
    plan = store.docs[f"plans/{pid}"]
    assert plan["kind"] == "parts" and plan["source"]["sessionId"] == "old" and plan["current"] == 1
    assert store.docs["commands/c1"]["planId"] == pid
    v1 = store.docs[f"planVersions/{pid}_v1"]
    assert v1["parts"]["lessons"][0]["appliedIn"] == "runs.py" and "## 1. Goal" in v1["text"]
    with pytest.raises(ValueError, match="six parts"):
        ib.plan_version(pid, "", "x", parts={"goal": "g"})
    assert ib.step_update(pid, "s1", "now", "counting") == 1
    assert ib.step_update(pid, "s1", "done", "40 reads a view") == 2
    assert store.docs[f"plans/{pid}"]["current"] == 1  # a step moving makes no plan version
    st = store.docs[f"planSteps/{pid}_s1"]
    assert st["state"] == "done" and [v["reply"] for v in st["versions"]] == ["counting", "40 reads a view"]
    with pytest.raises(ValueError, match="no step s9"):
        ib.step_update(pid, "s9", "now", "x")


def test_a_question_asked_during_a_step_joins_it():
    store = FakeStore()
    ib = Inbox(store, "PC", [], "s1", "/x")
    pid = ib.plan_start("p", parts=PARTS)
    ib.step_update(pid, "s1", "now", "working")
    qid = ib.post("question", "q", "x", [{"label": "A", "differs": "d", "example": EX}])
    assert store.docs[f"inbox/{qid}"]["stepId"] == "s1"
    ib.step_update(pid, "s1", "done", "ok")
    assert "stepId" not in store.docs[f"inbox/{ib.post('question', 'q', 'x', [{'label': 'A', 'differs': 'd', 'example': EX}])}"]


def test_a_qa_message_never_changes_the_plan_until_the_owner_confirms_a_switch():
    store = FakeStore()
    ib = Inbox(store, "PC", [], "s1", "/x")
    pid = ib.plan_start("p", parts=PARTS)
    store.put_many({"commands/m1": {"id": "m1", "action": "message", "kind": "qa", "sessionId": "s1", "status": "running",
                                    "prompt": "why s1?", "startedAt": "t"}})
    with pytest.raises(ValueError, match="Q&A"):
        ib.plan_version(pid, "", "x", parts=PARTS)
    q = ib.ask_switch("step", "add s2: a test", "the answer needs a test step")
    item = store.docs[f"inbox/{q}"]
    assert item["planId"] == pid and item["options"][0]["example"]["draft"] == "add s2: a test"
    store.update(f"inbox/{q}", {"status": "answered", "answer": {"choice": "Keep Q&A", "text": "", "at": "t"}})
    assert ib.confirm_switch(q) is False and "switchedTo" not in store.docs["commands/m1"]
    q = ib.ask_switch("step", "add s2", "why")
    store.update(f"inbox/{q}", {"status": "answered", "answer": {"choice": "Switch to Add step", "text": "", "at": "t"}})
    assert ib.confirm_switch(q) is True
    assert ib.plan_version(pid, "", "added s2", parts=PARTS) == 2
    assert store.docs[f"planVersions/{pid}_v2"]["change"] == {"kind": "step", "message": "why s1?"}


def test_a_plan_message_kind_goes_as_a_system_prompt_and_qa_cannot_edit():
    c = message_command("claude", "add a test", "sid", "manual", "step")
    # the owner's pick, 2026-11-12, "Scope in the message text": a resumed session never takes a new system prompt
    assert c[2].endswith("\n\nadd a test") and "part 6" in c[2] and c[2].startswith("<run-scope>")
    assert "part 6" not in c[c.index("--append-system-prompt") + 1]
    qa = message_command("claude", "why?", "sid", "manual", "qa")
    assert qa[qa.index("--disallowedTools") + 1] == "Edit,Write,NotebookEdit"
    from agent_bridge.planfrom import STYLE
    plain = message_command("claude", "hi", "sid")
    assert kind_args("bogus") == [] and plain[plain.index("--append-system-prompt") + 1] == STYLE  # only the reply style


def test_plan_from_a_session_reads_pages_writes_notes_then_starts_the_plan_session(tmp_path, monkeypatch):
    store, runs, work = setup(tmp_path, monkeypatch)
    write_log(tmp_path / "logs2")
    runs.logs = tmp_path / "logs2"
    cmd(store, "p1", action="plan", sourceSessionId="s1", cwd=str(work))
    runs.step()
    c = wait_done(runs, "p1", store, seconds=40)
    assert c["status"] == "done", c
    folder = tmp_path / "out" / "plans" / "p1"
    assert (folder / "page-01.txt").exists() and "did: This is page 1 of 1" in (folder / "notes-01.md").read_text(encoding="utf-8")
    assert c["sessionId"] not in ("", "s1") and c["pages"][0]["last"] == 6
    assert c["quotes"]["marked"] == 0
    assert 'source="p1"' in c["prompt"] and "six parts" in c["prompt"]


def test_plan_from_a_session_refuses_without_its_log(tmp_path, monkeypatch):
    store, runs, work = setup(tmp_path, monkeypatch)
    cmd(store, "p1", action="plan", sourceSessionId="nope", cwd=str(work))
    runs.step()
    assert store.get("commands/p1")["status"] == "failed" and "log" in store.get("commands/p1")["error"]


def test_a_quote_in_the_notes_that_differs_from_the_page_is_marked():
    page = "#4 12:00 OWNER\nleast verbose explains to me what\nthe log file contains, then the size cap"
    notes = ('"least verbose explains to me what the log file contains" ok; “explains to me … the size cap” ok; '
             '"least verbose tell me what the log file contains" wrong')
    out, seen, off = mark_quotes(notes, page, 9)
    assert (seen, off) == (3, 1)
    assert out.count("[quote differs from page 09") == 1 and out.index("[quote differs") > out.index("tell me")


def msg(kind, text, uid, parent=None, **f):
    return entry(kind, text, uuid=uid, parentUuid=parent, **f)


def write_chain(folder):
    """An old session, a new one forked from it (copying its tail), and a decoy log that only prints the fork id."""
    proj = folder / "proj"
    proj.mkdir(parents=True)
    (proj / "old.jsonl").write_text("\n".join([
        msg("user", "first ask", "u1"), msg("assistant", "did the first", "u2", "u1"),
        msg("user", "second ask", "u3", "u2"), msg("assistant", "did the second", "u4", "u3"),
        msg("user", "branch ask that the new log never got", "u9", "u4"),
    ]), encoding="utf-8")
    (proj / "decoy.jsonl").write_text("\n".join([
        msg("user", "look at u4", "d1"), msg("assistant", [{"type": "text", "text": "u4"}], "u4-not", "d1"),
        json.dumps({"type": "user", "uuid": "d2", "message": {"content": [{"type": "tool_result", "content": "u4"}]}}),
    ]), encoding="utf-8")
    (proj / "new.jsonl").write_text("\n".join([
        msg("user", "summary of before", "c1", "u4", isCompactSummary=True),
        msg("assistant", "did the second", "u4", "u3"),  # a copy of the old tail
        msg("user", "third ask", "n1", "c1"), msg("assistant", "did the third", "n2", "n1"),
    ]), encoding="utf-8")
    return proj


def test_a_session_that_continues_an_earlier_one_is_read_with_it_first(tmp_path):
    proj = write_chain(tmp_path)
    logs = chain(proj / "new.jsonl")
    assert [(p.stem, stop) for p, stop in logs] == [("old", "u4"), ("new", "")]
    rec = session_record(logs)
    texts = [r[2] for r in rec]
    assert [r[1] for r in rec][0] == "SESSION old" and "SESSION new" in [r[1] for r in rec]
    assert texts.index("first ask") < texts.index("summary of before") < texts.index("third ask")
    assert texts.count("did the second") == 1  # the copied tail is read once
    assert "branch ask that the new log never got" not in texts  # after the fork point, not on this session's path


def test_a_log_that_only_prints_the_fork_id_is_not_taken_as_the_earlier_session(tmp_path):
    proj = write_chain(tmp_path)
    (proj / "old.jsonl").unlink()
    assert chain(proj / "new.jsonl")[0][0].stem == "new"


def test_a_fresh_session_reads_as_before_with_no_session_marks(tmp_path):
    log = write_log(tmp_path)
    assert session_record(chain(log)) == records(log)  # no auto-continue in this log
    pages = write_pages(write_chain(tmp_path / "c") / "new.jsonl", tmp_path / "out")
    text = (tmp_path / "out" / pages[0]["file"]).read_text(encoding="utf-8")
    assert "SESSION old" in text and text.index("first ask") < text.index("third ask")


def test_text_the_owner_did_not_write_is_not_labelled_owner(tmp_path):
    log = tmp_path / "p" / "s.jsonl"
    log.parent.mkdir()
    log.write_text("\n".join([
        entry("user", "do 1", turnOrigin="human", promptSource="sdk", origin={"kind": "human"}),
        entry("user", "commit and push", turnOrigin="sdk", promptSource="sdk"),  # sent from the dashboard
        entry("user", "Another Claude session sent a message: report", isMeta=True, turnOrigin="peer",
              origin={"kind": "peer", "body": "[Subagent hand-back] The text below is the final report"}),
        entry("user", "Another Claude session sent a message: hi", origin={"kind": "peer", "body": "hi from s2"}),
        entry("user", "[Usage limit reached; a short grace allowance remains]", isMeta=True),
        entry("user", "[Request interrupted by user]"),
    ]), encoding="utf-8")
    assert [r[1] for r in records(log)] == [
        "OWNER", "OWNER", "SUBAGENT (hand-back report, not the owner)", "AGENT MESSAGE (another session, not the owner)",
        "SYSTEM (not the owner)", "SYSTEM (not the owner)"]


def test_the_goal_box_goes_into_the_plan_prompt_and_a_blank_box_changes_nothing():
    from agent_bridge.planfrom import plan_prompt
    blank = plan_prompt("s1", "D:/p", 2, "c1")
    assert "goal box" not in blank and "Parts 1 to 5 and the cite: write only what the record shows" in blank
    goal = plan_prompt("s1", "D:/p", 2, "c1", ' finish the "delete" flow ')
    assert goal.startswith(blank) and "\"finish the 'delete' flow\"" in goal
    assert "not instructions" in goal and "Part 1 starts with the owner's goal" in goal


def test_a_new_step_keeps_its_mark_in_the_parts_and_in_the_version_text():
    from agent_bridge.inbox import clean_parts, parts_markdown
    parts = dict(PARTS, steps=[{"id": "s1", "title": "Old", "does": "d", "check": "c"},
                               {"id": "s2", "title": "Bulk delete", "does": "d", "check": "c", "new": True}])
    out = clean_parts(parts)
    assert "new" not in out["steps"][0] and out["steps"][1]["new"] is True
    text = parts_markdown(out)
    assert "title: [new] Bulk delete" in text and "title: Old" in text and "new: True" not in text


def test_plan_from_a_session_passes_the_owners_goal(tmp_path, monkeypatch):
    store, runs, work = setup(tmp_path, monkeypatch)
    write_log(tmp_path / "logs2")
    runs.logs = tmp_path / "logs2"
    cmd(store, "p2", action="plan", sourceSessionId="s1", cwd=str(work), goal="ship the delete flow")
    runs.step()
    c = wait_done(runs, "p2", store, seconds=40)
    assert c["status"] == "done", c
    assert '"ship the delete flow"' in c["prompt"] and "not instructions" in c["prompt"]


def test_an_auto_continue_is_one_system_entry_that_names_the_owners_message_it_continues(tmp_path):
    from agent_bridge.digest import AUTO_CONTINUE
    log = tmp_path / "p" / "s.jsonl"
    log.parent.mkdir()
    log.write_text("\n".join([
        entry("user", "do 3", turnOrigin="human"),
        entry("assistant", [{"type": "text", "text": "working"}]),
        entry("user", AUTO_CONTINUE, turnOrigin="sdk", promptSource="sdk"),
        entry("user", AUTO_CONTINUE + " And I need all sections collapsed", turnOrigin="sdk", promptSource="sdk"),
    ]), encoding="utf-8")
    rec = session_record(chain(log))
    assert [r[1] for r in rec] == ["OWNER", "CLAUDE", "SYSTEM (auto continue of #1, not the owner)", "OWNER"]
    assert rec[2][2] == AUTO_CONTINUE  # kept, one entry


def test_the_cite_holds_the_owners_words_and_part_1_says_what_the_plan_is_for():
    from agent_bridge.inbox import clean_parts, parts_markdown
    from agent_bridge.planfrom import plan_prompt
    base = {"goal": "| builds | the dashboard |", "summary": "", "rules": [], "lessons": [], "leftover": [], "steps": []}
    assert "cite" not in clean_parts(base)
    p = clean_parts({**base, "cite": '- **Delete** (#303): "every item"'})
    assert p["cite"].startswith("- **Delete**") and parts_markdown(p).endswith('## Cite\n\n- **Delete** (#303): "every item"')
    text = plan_prompt("s1", "F", 2, "c1", goal="ship it")
    assert "what this plan is used for" in text and "No list of quotes here" in text and "cite: the owner's own words" in text


def test_a_run_step_message_carries_the_step_scope():
    c = message_command("claude", "Work on step s2: x. Report it with step_update.", "sid", "manual", "", "s2")
    # the scope is in the message itself (the owner's pick, 2026-11-12: "Scope in the message text"): a resumed
    # session never takes a new appended system prompt, so step i8 once ran under "step i7 only"
    scope = c[2]
    assert "only that step" in scope and "step s2" in scope and "inbox_ask" in scope and "never done in this run" in scope
    assert "replaces any earlier one" in scope and scope.endswith("Work on step s2: x. Report it with step_update.")
    assert "only that step" not in c[c.index("--append-system-prompt") + 1]
    plain = message_command("claude", "hi", "sid")
    assert plain[2] == "hi"  # no scope without a step
    k = message_command("claude", "why?", "sid", "manual", "qa", "s2")  # a kind keeps its own prompt
    assert "Q&A" in k[2] and "only that step" not in k[2]


def test_the_plans_own_parts_are_checked_against_the_record(tmp_path):
    from agent_bridge.planfrom import check_parts, read_entries
    (tmp_path / "page-01.txt").write_text(
        "\n#1 2026-11-03T10:00:00 OWNER\nleast verbose explains to me what\nthe log file contains\n"
        "\n#2 2026-11-03T10:01:00 CLAUDE\nI will read the log.\n[#3 continues on the next page]\n", encoding="utf-8")
    (tmp_path / "page-02.txt").write_text("\n#3 2026-11-03T10:02:00 OWNER\ndo 1 then commit\n"
                                          "\n#4  SESSION abc\nThe record of session abc starts here.\n", encoding="utf-8")
    e = read_entries(tmp_path)
    assert sorted(e) == [1, 2, 3, 4] and e[1][0] == "OWNER" and e[4][0] == "SESSION abc" and e[3][1] == "do 1 then commit"
    parts = dict(PARTS, goal="ok", cite=('- **Log** (#1): "least verbose explains to me what the log file contains"\n'
                                         '- **Wrong** (#1): "least verbose tell me"\n- **Range** (#2 to #3): "do 1 then commit"\n'
                                         '- **Gone** (#9999): "anything"'),
                 summary="- read (#2)")
    out, c = check_parts(parts, str(tmp_path))
    lines = out["cite"].split("\n")
    assert "[quote not in" not in lines[0] and "[quote not in the OWNER entries cited]" in lines[1]
    assert "[quote not in" not in lines[2] and "#9999 **[not in the record]**" in lines[3]
    assert c == {"refs": 6, "badRefs": 1, "quotes": 3, "marked": 1}  # 4 in the cite, the summary, the rule source
    again, c2 = check_parts(out, str(tmp_path))  # marks are never doubled on a later version
    assert again["cite"] == out["cite"] and c2["badRefs"] == 1
    assert check_parts(parts, str(tmp_path / "none"))[0] == parts


def test_a_restarted_plan_keeps_the_notes_of_unchanged_pages_and_a_usage_limit_pauses_it(tmp_path, monkeypatch):
    import subprocess
    import sys

    store, runs, work = setup(tmp_path, monkeypatch)
    write_log(tmp_path / "logs2")
    runs.logs = tmp_path / "logs2"
    real, notes_runs = runs.popen, []
    limit = json.dumps({"type": "result", "is_error": True, "api_error_status": 429, "api_error": "usage_limit_reached",
                        "result": "You've hit your 5-hour limit · resets 12:20pm (Asia/Ho_Chi_Minh)"})

    def limited(cmd, **kw):  # every notes run hits the usage limit
        if "--no-session-persistence" in cmd:
            notes_runs.append(cmd)
            return subprocess.Popen([sys.executable, "-c", f"print({limit!r})"], **kw)
        return real(cmd, **kw)

    runs.popen = limited
    cmd(store, "p1", action="plan", sourceSessionId="s1", cwd=str(work))
    c = wait_done(runs, "p1", store, seconds=40)
    assert c["status"] == "paused" and c["pausedUntil"] == "12:20pm (Asia/Ho_Chi_Minh)" and "page 1 of 1" in c["stage"]

    def counted(cmd, **kw):
        if "--no-session-persistence" in cmd:
            notes_runs.append(cmd)
        return real(cmd, **kw)

    runs.popen, notes_runs[:] = counted, []
    store.update("commands/p1", {"status": "new"})  # restart the same run: the failed page is written again
    runs.acted.discard("p1")
    c = wait_done(runs, "p1", store, seconds=40)
    assert c["status"] == "done" and len(notes_runs) == 1 and not c.get("reused") and c["pausedUntil"] is None
    cmd(store, "p2", action="plan", sourceSessionId="s1", cwd=str(work))  # a new run on the same session
    c = wait_done(runs, "p2", store, seconds=40)
    assert c["status"] == "done" and len(notes_runs) == 1 and c["reused"] == 1  # no new notes run
    assert (tmp_path / "out" / "plans" / "p2" / "notes-01.md").read_text(encoding="utf-8") == \
        (tmp_path / "out" / "plans" / "p1" / "notes-01.md").read_text(encoding="utf-8")
