import json

from agent_bridge.handoff import handoff_prompt, last_context, should_fresh


def test_last_context_is_the_last_turns_input(tmp_path):
    p = tmp_path / "s.jsonl"
    lines = [
        {"type": "user", "message": {"content": "q"}},
        {"type": "assistant", "message": {"usage": {"input_tokens": 10, "cache_read_input_tokens": 1000, "cache_creation_input_tokens": 50}}},
        {"type": "assistant", "message": {"usage": {"input_tokens": 5, "cache_read_input_tokens": 400000, "cache_creation_input_tokens": 0}}},
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "no usage line"}]}},
    ]
    p.write_text("\n".join(json.dumps(x) for x in lines) + "\n", encoding="utf-8")
    assert last_context(p) == 400005
    assert last_context(tmp_path / "missing.jsonl") == 0


def test_should_fresh_rule():
    assert should_fresh("always", 10, 300000) and not should_fresh("never", 10 ** 7, 300000)
    assert should_fresh("auto", 300001, 300000) and not should_fresh("auto", 300000, 300000)
    assert not should_fresh("auto", 10 ** 7, 0)  # the rule is off


def test_handoff_prompt_holds_the_last_turns_the_plan_and_the_message():
    turns = [{"n": i, "at": f"t{i}", "prompt": f"ask {i}", "text": "reply " + "x" * 3000} for i in range(1, 10)]
    text = handoff_prompt("old-sid", "K:/logs/old.jsonl", turns, "carry on with s3", plan_id="plan1", context=412345)
    assert "continues session old-sid" in text and "412,345 tokens" in text and "K:/logs/old.jsonl" in text
    assert "### turn 4" in text and "### turn 3" not in text  # the last six turns
    assert 'plan_id="plan1"' in text and text.rstrip().endswith("carry on with s3")
    assert len(text) < 30000
    assert "## Plan" not in handoff_prompt("s", "l", [], "m")


def test_handoff_carries_the_plans_rules_lessons_and_the_feedback_log():
    """G3 (the owner, 2026-11-18: "all 5 gap, fix one by one"): a fresh session keeps the plan's rules and lessons."""
    parts = {"rules": [{"rule": "no clipping", "source": "owner 2026-10-22"}],
             "lessons": [{"lesson": "measure, never guess", "taughtBy": "s4", "appliedIn": "s5"}]}
    text = handoff_prompt("s", "l", [], "go", plan_id="p1", plan_parts=parts)
    assert "- rule: no clipping (source: owner 2026-10-22)" in text
    assert "- lesson: measure, never guess (taught by: s4)" in text
    assert "OWNER_FEEDBACK.md" in text and text.endswith("## The owner's message now\ngo")
    assert "rules and lessons" not in handoff_prompt("s", "l", [], "go", plan_id="p1", plan_parts={"rules": []})
