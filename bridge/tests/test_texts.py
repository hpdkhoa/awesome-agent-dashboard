import json

from agent_bridge.files import Files, serve
from agent_bridge.texts import Texts, turns_of
from test_files import call, verify


def line(kind, content, ts, mid=None, model="m", **extra):
    m = {"content": content, "model": model}
    if mid:
        m["id"] = mid
    return json.dumps({"type": kind, "timestamp": ts, "message": m, **extra})


def write_log(tmp_path, lines):
    logs = tmp_path / "logs"
    (logs / "proj").mkdir(parents=True)
    (logs / "proj" / "sess1.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return logs


def test_turns_keep_the_whole_last_reply_of_each_turn(tmp_path):
    long = "x" * 9000
    logs = write_log(tmp_path, [
        line("user", "first ask", "2026-11-08T01:00:00Z", origin={"kind": "human"}),
        line("assistant", [{"type": "text", "text": "thinking out"}], "2026-11-08T01:00:05Z", mid="a1"),
        line("assistant", [{"type": "tool_use", "name": "Read"}], "2026-11-08T01:00:06Z", mid="a2"),
        line("user", [{"type": "tool_result", "content": "data"}], "2026-11-08T01:00:07Z"),
        line("assistant", [{"type": "text", "text": "final part"}], "2026-11-08T01:00:08Z", mid="a3"),
        line("assistant", [{"type": "text", "text": "final part one, " + long}], "2026-11-08T01:00:09Z", mid="a3"),
        line("user", "[Request interrupted]", "2026-11-08T01:01:00Z", isMeta=True),
        line("user", "second ask", "2026-11-08T02:00:00Z", origin={"kind": "human"}),
        line("assistant", [{"type": "text", "text": "No response requested."}], "2026-11-08T02:00:01Z", model="<synthetic>"),
        line("assistant", [{"type": "text", "text": "second reply with KEY=sk-ant-api03-" + "a" * 90}], "2026-11-08T02:00:02Z", mid="b1"),
    ])
    turns = turns_of(logs / "proj" / "sess1.jsonl")
    assert [t["n"] for t in turns] == [1, 2]
    assert turns[0]["text"] == "final part one, " + long  # the streamed id's last line, whole, over any old cap
    assert turns[0]["prompt"] == "first ask" and turns[0]["at"] == "2026-11-08T01:00:09Z"
    assert turns[1]["text"].startswith("second reply with KEY=[redacted]")
    t = Texts(logs, None)
    last = t.session("sess1", None)
    assert last["n"] == 2 and last["chars"] == len(turns[1]["text"]) and [x["n"] for x in last["turns"]] == [1, 2]
    assert t.session("sess1", 1)["chars"] == 9016 and t.session("sess1", 99)["n"] == 2


def test_run_result_comes_whole_from_the_out_file(tmp_path):
    out = tmp_path / "runs"
    out.mkdir()
    (out / "abc123.out").write_text(json.dumps({"result": "r" * 20000, "total_cost_usd": 0.1}), encoding="utf-8")
    t = Texts(None, out)
    assert t.run("abc123")["chars"] == 20000 and t.run("abc123")["isError"] is False
    for bad in ("..", "abc123/x", "zzz", ""):
        try:
            t.run(bad)
            assert False, bad
        except ValueError as e:
            assert "no record" in str(e)


def test_text_call_needs_the_owner_and_answers_json(tmp_path):
    logs = write_log(tmp_path, [line("user", "q", "2026-11-08T01:00:00Z", origin={"kind": "human"}),
                                line("assistant", [{"type": "text", "text": "a" * 5000}], "2026-11-08T01:00:01Z", mid="a1")])
    files = Files([("work", str(tmp_path))], verify)
    srv = serve(files, ["https://agent.example.com"], 0, Texts(logs, tmp_path / "runs"))
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    try:
        status, _, body = call(base, "/text", {"session": "sess1"})
        assert status == 200 and json.loads(body)["chars"] == 5000
        assert call(base, "/text", {"session": "sess1"}, token="guest")[0] == 401
        assert call(base, "/text", {"session": "nope"})[0] == 404
        assert call(base, "/text", {"run": "nope"})[0] == 404
        assert call(base, "/text", {})[0] == 400
    finally:
        srv.shutdown()


def test_text_call_is_off_without_texts(tmp_path):
    srv = serve(Files([("work", str(tmp_path))], verify), ["https://agent.example.com"], 0)
    try:
        assert call(f"http://127.0.0.1:{srv.server_address[1]}", "/text", {"session": "s"})[0] == 404
    finally:
        srv.shutdown()
