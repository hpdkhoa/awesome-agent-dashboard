import json
from pathlib import Path

from agent_bridge.aggregate import build, work_type_of
from agent_bridge.firestore import to_value
from agent_bridge.logs import FileState, read_lines, session_files
from agent_bridge.prices import cost
from agent_bridge.redact import redact


def usage(inp=1, out=10, w5=0, w1h=100, read=1000):
    return {
        "input_tokens": inp,
        "output_tokens": out,
        "cache_read_input_tokens": read,
        "cache_creation_input_tokens": w5 + w1h,
        "cache_creation": {"ephemeral_5m_input_tokens": w5, "ephemeral_1h_input_tokens": w1h},
    }


def assistant(mid, ts, text="", model="claude-opus-5-5", sid="", **u):
    content = [{"type": "text", "text": text}] if text else [{"type": "tool_use"}]
    return {"type": "assistant", "timestamp": ts, "cwd": "K:/work/labs/x", "sessionId": sid,
            "message": {"id": mid, "model": model, "usage": usage(**u), "content": content}}


def human(ts, text):
    return {"type": "user", "timestamp": ts, "origin": {"kind": "human"}, "message": {"content": text}}


def write(path: Path, lines):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        for d in lines:
            f.write(json.dumps(d) + "\n")


T1, T2, T3 = "2026-10-30T10:00:00Z", "2026-10-30T10:01:00Z", "2026-10-30T10:02:00Z"


def test_one_message_split_over_lines_counts_once(tmp_path):
    p = tmp_path / "proj" / "s1.jsonl"
    write(p, [human(T1, "do it"), assistant("m1", T2), assistant("m1", T2, text="done"), assistant("m2", T3)])
    st = read_lines(p, FileState())
    assert len(st.msgs) == 2 and st.prompts == 1 and st.last_reply == "done"


def test_tool_results_are_not_prompts(tmp_path):
    p = tmp_path / "proj" / "s1.jsonl"
    write(p, [human(T1, "go"), {"type": "user", "timestamp": T2, "message": {"content": [{"type": "tool_result"}]}}])
    assert read_lines(p, FileState()).prompts == 1


def test_reading_in_two_steps_equals_one(tmp_path):
    p = tmp_path / "proj" / "s1.jsonl"
    write(p, [human(T1, "a"), assistant("m1", T2)])
    st = read_lines(p, FileState())
    write(p, [assistant("m2", T3, text="b")])
    p.open("a").write('{"type": "assistant", "half')  # a line still being written
    st = read_lines(p, st)
    whole = tmp_path / "proj" / "s2.jsonl"
    write(whole, [human(T1, "a"), assistant("m1", T2), assistant("m2", T3, text="b")])
    assert st.msgs == read_lines(whole, FileState()).msgs
    assert st.offset < p.stat().st_size  # the half line is left for the next read


def test_resumed_session_does_not_count_twice_and_subagents_count(tmp_path):
    proj = tmp_path / "proj"
    # like the real logs: the resumed file repeats m1 with the old session's id; subagent lines carry the parent's id
    write(proj / "old.jsonl", [human(T1, "first"), assistant("m1", T1, sid="old")])
    write(proj / "new.jsonl", [assistant("m1", T1, sid="old"), human(T2, "again"), assistant("m2", T2, sid="new")])
    write(proj / "new" / "subagents" / "agent-a.jsonl", [assistant("m3", T3, sid="new")])
    files = session_files(tmp_path, None)
    states = {sid: [read_lines(f, FileState()) for f in fs] for sid, fs in files.items()}
    docs, usage_docs, wts = build(states, "pc", [("labs", "K:/work/labs")])
    assert docs["old"]["messages"] == 1 and docs["new"]["messages"] == 2 and docs["new"]["subagents"] == 1
    day = next(iter(usage_docs.values()))
    assert len(usage_docs) == 1 and day["total"] == 3 * 1111 and wts["labs"]["sessions"] == 2


def test_cost_matches_the_price_table():
    # Opus 5.5: $4 in, $20 out, $5 write 5m, $8 write 1h, $0.20 read per million
    assert abs(cost("claude-opus-5-5", 1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000) - 37.2) < 1e-9
    assert cost("some-new-model", 1, 1, 1, 1, 1) is None


def test_work_type_longest_root_wins():
    roots = [("all", "K:/Projects"), ("labs", "K:\\Projects\\gitHub")]
    assert work_type_of("k:/projects/github/poselab", roots) == "labs"
    assert work_type_of("K:/Projects/Claude", roots) == "all"
    assert work_type_of("D:/elsewhere", roots) == "other"
    assert work_type_of("K:/Projects2", roots) == "other"


def test_secrets_never_leave_the_machine():
    leaks = ["AIza" + "x" * 35, "sk-ant-" + "y" * 30, "1//" + "z" * 40, "password=hunter2"]
    for s in leaks:
        assert s not in redact(f"before {s} after", 500)
    assert redact("a" * 50, 10) == "a" * 9 + "…"


def test_firestore_values():
    v = to_value({"n": 1, "f": 1.5, "s": "x", "b": True, "z": None, "l": [1], "m": {"k": "v"}})["mapValue"]["fields"]
    assert v["n"] == {"integerValue": "1"} and v["b"] == {"booleanValue": True} and v["z"] == {"nullValue": None}


def test_streamed_output_counts_its_final_size(tmp_path):
    p = tmp_path / "proj" / "s1.jsonl"
    write(p, [assistant("m1", T2, out=5), assistant("m1", T2, out=300), assistant("m1", T2, out=7)])
    assert read_lines(p, FileState()).msgs["m1"][4] == 300


def test_synthetic_messages_are_skipped(tmp_path):
    p = tmp_path / "proj" / "s1.jsonl"
    write(p, [assistant("m1", T2, model="<synthetic>"), assistant("m2", T2)])
    assert list(read_lines(p, FileState()).msgs) == ["m2"]
