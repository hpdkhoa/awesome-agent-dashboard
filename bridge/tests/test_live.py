"""Step i3, Live output (the owner's choice, 2026-11-12: "Token stream"): runs write claude's stream into the .out,
the page reads the running turn from the PC, the result and the Firestore writes stay as before."""

import json
import sys
import time

from agent_bridge.runs import STREAM, Runs, message_command, parse_result, start_command
from agent_bridge.texts import LIVE_TAIL, Texts, live_of
from test_inbox import FakeStore

# A stand-in for claude in stream mode: init, two text deltas, a tool call, a pause, then the result line.
FAKE = r'''
import json, sys, time
assert "stream-json" in sys.argv and "--include-partial-messages" in sys.argv and "--verbose" in sys.argv
out = lambda e: (print(json.dumps(e)), sys.stdout.flush())
out({"type": "system", "subtype": "init", "session_id": "s1"})
out({"type": "stream_event", "event": {"type": "message_start"}})
for t in ("Reading ", "the files."):
    out({"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": t}}})
out({"type": "stream_event", "event": {"type": "content_block_start", "content_block": {"type": "tool_use", "name": "Read"}}})
out({"type": "stream_event", "parent_tool_use_id": "x", "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "SUBAGENT"}}})
time.sleep(float(sys.argv[sys.argv.index("-p") + 1]))
out({"type": "stream_event", "event": {"type": "message_start"}})
out({"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Done."}}})
out({"type": "result", "subtype": "success", "is_error": False, "result": "Done.", "session_id": "s1", "total_cost_usd": 0.1})
'''


class CountingStore(FakeStore):
    def __init__(self):
        super().__init__()
        self.writes = 0

    def put_many(self, docs):
        self.writes += len(docs)
        return super().put_many(docs)

    def update(self, path, fields):
        self.writes += 1
        return super().update(path, fields)


def test_runs_ask_claude_for_the_token_stream():
    for cmd in (start_command("claude", "hi", "s"), message_command("claude", "hi", "s")):
        i = cmd.index("--output-format")
        assert cmd[i:i + len(STREAM)] == STREAM and "json" not in cmd[i + 1:i + 2]


def test_result_is_the_last_result_line_of_a_stream():
    lines = [{"type": "system", "subtype": "init"}, {"type": "assistant"}, {"type": "result", "result": "R", "is_error": False}]
    assert parse_result("\n".join(json.dumps(x) for x in lines) + "\n")["result"] == "R"
    assert parse_result(json.dumps(lines[0]) + "\n") == {}  # still working: no result yet
    assert parse_result(json.dumps(lines[0]) + "\n" + json.dumps(lines[1]) + "\n{\"type\": \"stream_ev") == {}
    assert parse_result(json.dumps({"result": "old json", "total_cost_usd": 1}))["result"] == "old json"  # a .out from before i3


def test_live_text_joins_deltas_marks_tools_and_skips_subagents():
    out = "\n".join(json.dumps(x) for x in [
        {"type": "system", "subtype": "init"},
        {"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hel"}}},
        {"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "lo"}}},
        {"type": "stream_event", "event": {"type": "content_block_start", "content_block": {"type": "tool_use", "name": "Bash"}}},
        {"type": "stream_event", "parent_tool_use_id": "t", "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "NO"}}},
    ]) + '\n{"type": "stream_event", "event": {"ty'  # a line still being written
    live = live_of(out)
    assert live["started"] and not live["done"] and live["tools"] == 1
    assert live["text"] == "Hello\n\n- tool: Bash" and "NO" not in live["text"]
    long = live_of(json.dumps({"type": "stream_event", "event": {"type": "content_block_delta",
                                                                 "delta": {"type": "text_delta", "text": "x" * (LIVE_TAIL + 5)}}}))
    assert long["cut"] and len(long["text"]) == LIVE_TAIL and long["chars"] == LIVE_TAIL + 5


def test_running_turn_shows_on_the_page_before_the_end_and_writes_stay_the_same(tmp_path):
    fake = tmp_path / "fake_claude.py"
    fake.write_text(FAKE)
    work = tmp_path / "work"
    work.mkdir()
    store = CountingStore()
    popen = lambda cmd, **kw: __import__("subprocess").Popen([sys.executable, str(fake), *cmd[1:]], **kw)
    runs = Runs(store, "PC", [("labs", str(work))], "claude", tmp_path / "out", popen=popen, logs=None, procs=lambda: [])
    texts = Texts(None, tmp_path / "out")
    store.put_many({"commands/r1": {"id": "r1", "machine": "PC", "status": "new", "action": "start",
                                    "folder": str(work), "prompt": "1.5"}})
    before = store.writes
    runs.step()
    seen, end = None, time.time() + 20
    while time.time() < end:
        live = texts.answer({"live": "r1"})
        if live["text"] and not live["done"]:
            seen = live
            break
        time.sleep(0.05)
    assert seen and seen["started"] and seen["text"].startswith("Reading the files.") and "- tool: Read" in seen["text"]
    while store.get("commands/r1")["status"] == "running" and time.time() < end:
        runs.step()
        time.sleep(0.1)
    c = store.get("commands/r1")
    assert c["status"] == "done"
    assert texts.answer({"run": "r1"})["text"] == "Done."
    assert texts.answer({"live": "r1"})["done"]
    assert store.writes - before == 2  # running, then the end: the stream adds no Firestore write
