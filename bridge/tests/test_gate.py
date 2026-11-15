"""s6 (plan 1c08f4c2): the gate task set. Ollama is faked; the fixtures are the shipped ones; the score has no bar."""
import json

from agent_bridge import gate, localrun
from test_localrun import FakeOllama, TAGS


def answer(text):
    return [{"message": {"content": text}, "done": False},
            {"message": {"content": ""}, "done": True, "prompt_eval_count": 100, "eval_count": 40,
             "eval_duration": 2_000_000_000}]


class ByTask(FakeOllama):
    """Answers each task right except T3, so the score is 9 of 12."""

    def __call__(self, req, timeout):
        if not req.full_url.endswith("/api/chat") or not json.loads(req.data).get("stream"):
            return super().__call__(req, timeout)
        user = json.loads(req.data)["messages"][-1]["content"]
        self.chat = answer("- port 8471" if "port" in user else "- LIMIT_MARGIN is 90" if "LIMIT_MARGIN" in user
                           else "- Night backup check, then the restore drill" if "7e3a" in user
                           else "- a cache of keys\n- it grows with tokens")
        return super().__call__(req, timeout)


def test_fixtures_ship_with_the_bridge():
    for name in ("lab-notes.md", "runs_copy.py.txt", f"gate-project/{gate.LOG_ID}.jsonl"):
        assert (gate.FIXTURES / name).is_file(), name
    assert [t[0] for t in gate.TASKS] == ["T1", "T2", "T3", "T4"] and gate.RUNS == 3


def test_style_ok_is_the_h9_measure():
    assert gate.style_ok("- a\n- b\n- c\n- d\nplain")
    assert not gate.style_ok("## Head\n- a")
    assert not gate.style_ok("one\ntwo\n- a")


def test_gate_scores_every_task_three_times_and_saves_the_score(tmp_path, monkeypatch):
    monkeypatch.delenv("OLLAMA_URL", raising=False)
    (tmp_path / ".env").write_text("")
    fake = ByTask()
    s = gate.gate("qwen3:4b-instruct", "http://x", tmp_path, tmp_path / ".env", opener=fake, log=lambda *_: None)
    assert (s["pass"], s["runs"]) == (9, 12)
    assert s["tasks"]["T3"]["pass"] == 0 and s["tasks"]["T2"]["pass"] == 3
    assert s["tokensPerSec"] == 20.0  # 40 tokens in 2 s, every run
    # the session-log task sent the synthetic log, chunked to fit
    log_runs = [b for b in fake.sent if "7e3a" in b["messages"][-1]["content"]]
    assert len(log_runs) == 3 and "session log" in log_runs[0]["messages"][-1]["content"]
    cache = json.loads((tmp_path / "local_models.json").read_text())
    assert cache["qwen3:4b-instruct"]["score"]["pass"] == 9
    assert list((tmp_path / "gate").glob("*/qwen3_4b-instruct.json"))


def test_the_model_list_carries_the_score(tmp_path, monkeypatch):
    monkeypatch.delenv("OLLAMA_URL", raising=False)
    (tmp_path / ".env").write_text("")
    cache = tmp_path / "local_models.json"
    cache.write_text(json.dumps({"qwen3:4b-instruct": {"contextLength": 1, "score": {
        "pass": 11, "runs": 12, "tokensPerSec": 30.5, "at": "t", "tasks": {}}}}))
    lm = localrun.LocalModels(lambda: tmp_path / ".env", opener=FakeOllama(), cache=cache)
    models = lm.current(force=True)["models"]
    assert models[0]["score"] == {"pass": 11, "runs": 12, "tokensPerSec": 30.5, "at": "t"}
    assert len(models) == 1 and TAGS  # the embedding model stays out


def test_no_score_without_a_gate_run(tmp_path, monkeypatch):
    monkeypatch.delenv("OLLAMA_URL", raising=False)
    (tmp_path / ".env").write_text("")
    lm = localrun.LocalModels(lambda: tmp_path / ".env", opener=FakeOllama(), cache=tmp_path / "none.json")
    assert "score" not in lm.current(force=True)["models"][0]
