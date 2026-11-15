"""s3 (plan 1c08f4c2): the local command. Ollama is faked (no network); files only from WORK_ROOTS; no claude at all."""
import io
import json
import time
import urllib.error

import pytest

from agent_bridge import localrun
from agent_bridge.runs import Runs, parse_result
from agent_bridge.status import Status
from agent_bridge.texts import live_of
from test_inbox import FakeStore

TAGS = {"models": [{"name": "qwen3:4b-instruct", "size": 2_500_000_000,
                    "details": {"family": "qwen3", "parameter_size": "4.0B", "quantization_level": "Q4_K_M"}},
                   {"name": "nomic-embed-text:latest", "size": 274_000_000, "details": {"family": "nomic-bert"}}]}
CHAT = [{"message": {"content": "Two "}, "done": False}, {"message": {"content": "bullets."}, "done": False},
        {"message": {"content": ""}, "done": True, "load_duration": 5_700_000_000, "prompt_eval_count": 120,
         "eval_count": 37, "eval_duration": 5_000_000_000}]


class Resp(list):
    def __init__(self, items, body=b""):
        super().__init__(items)
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return self.body


class FakeOllama:
    def __init__(self, chat=CHAT, up=True, length=262144):
        self.chat, self.up, self.sent, self.calib, self.length, self.shows = chat, up, [], [], length, 0

    def __call__(self, req, timeout):
        if not self.up:
            raise ConnectionRefusedError("refused")
        if req.full_url.endswith("/api/tags"):
            return Resp([], json.dumps(TAGS).encode())
        body = json.loads(req.data)
        if req.full_url.endswith("/api/show"):
            self.shows += 1
            return Resp([], json.dumps({"model_info": {"qwen3.context_length": self.length}}).encode())
        if not body.get("stream"):  # the count call: 3 characters per token, plus 10 for the template
            n = sum(len(m["content"]) for m in body["messages"]) // 3 + 10
            self.calib.append(n)
            if n > body["options"]["num_ctx"]:  # Ollama refuses a request over the window, with its count
                err = f'{{"error":"request ({n} tokens) exceeds the available context size ({body["options"]["num_ctx"]} tokens)"}}'
                raise urllib.error.HTTPError(req.full_url, 400, "Bad Request", {}, io.BytesIO(err.encode()))
            return Resp([], json.dumps({"prompt_eval_count": n, "done": True}).encode())
        self.sent.append(body)
        return Resp([(json.dumps(e) + "\n").encode() for e in self.chat])


def user_of(body):
    return body["messages"][-1]["content"]


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.delenv("OLLAMA_URL", raising=False)
    root = tmp_path / "work"
    root.mkdir()
    (tmp_path / ".env").write_text("")
    fake = FakeOllama()
    monkeypatch.setattr(localrun.urllib.request, "urlopen", fake)
    store = FakeStore()
    runs = Runs(store, "PC", [("work", str(root))], None, tmp_path / "out")  # claude=None: no Claude CLI needed
    runs.env_path = tmp_path / ".env"
    runs.local_models.opener = fake
    return store, runs, root, fake, tmp_path


def run(store, runs, cid, **c):
    store.docs[f"commands/{cid}"] = {"id": cid, "action": "local", "machine": "PC", "status": "new", "createdAt": "1", **c}
    end = time.time() + 10
    while time.time() < end:
        runs.step([store.get(f"commands/{cid}")] if store.get(f"commands/{cid}")["status"] == "new" else [])
        if store.get(f"commands/{cid}")["status"] not in ("new", "running", "stopping"):
            return store.get(f"commands/{cid}")
        time.sleep(0.05)
    raise AssertionError("local run did not end")


def test_a_file_inside_work_roots_goes_with_the_prompt_and_the_answer_streams(setup):
    store, runs, root, fake, tmp = setup
    f = root / "notes.md"
    f.write_text("line one", encoding="utf-8")
    c = run(store, runs, "a1", model="qwen3:4b-instruct", prompt="Sum up.", files=[str(f)])
    assert c["status"] == "done" and c["engine"] == "ollama" and c["workType"] == "local"
    assert c["tokensPerSec"] == 7.4 and c["outputTokens"] == 37 and c["promptTokens"] == 120 and c["loadMs"] == 5700
    assert c["context"] == [{"name": str(f.resolve()), "chars": 8, "sent": 8, "chunks": None}]
    msg = user_of(fake.sent[0])
    assert "line one" in msg and msg.endswith("Sum up.") and fake.sent[0]["model"] == "qwen3:4b-instruct"
    out = (tmp / "out" / "a1.out").read_text(encoding="utf-8")
    assert parse_result(out)["result"] == "Two bullets." and "Two bullets." in json.dumps(live_of(out))


@pytest.mark.parametrize("name, why", [("outside", "outside WORK_ROOTS"), (".env", "secret"), ("missing", "no such file")])
def test_a_refused_file_stops_the_run_and_nothing_is_sent(setup, name, why):
    store, runs, root, fake, tmp = setup
    if name == "outside":
        p = tmp / "elsewhere.txt"
        p.write_text("private")
    elif name == ".env":
        p = root / ".env"
        p.write_text("KEY=1")
    else:
        p = root / "gone.txt"
    c = run(store, runs, "r1", model="qwen3:4b-instruct", prompt="x", files=[str(p)])
    assert c["status"] == "failed" and why in c["error"] and fake.sent == []


def test_an_unknown_model_or_an_embedding_model_is_refused(setup):
    store, runs, root, fake, tmp = setup
    for m in ("llama9:70b", "nomic-embed-text:latest"):
        c = run(store, runs, "m" + m[:3], model=m, prompt="x")
        assert c["status"] == "failed" and "not one of this machine's models: qwen3:4b-instruct" in c["error"]
    assert fake.sent == []


def test_no_ollama_fails_with_the_setting_line(setup):
    store, runs, root, fake, tmp = setup
    fake.up = False
    c = run(store, runs, "n1", model="qwen3:4b-instruct", prompt="x")
    assert c["status"] == "failed" and "OLLAMA_URL" in c["error"]


def test_a_session_log_goes_as_context_read_only(setup):
    store, runs, root, fake, tmp = setup
    logs = tmp / "logs" / "proj"
    logs.mkdir(parents=True)
    sid = "11111111-2222-3333-4444-555555555555"
    lines = [{"type": "user", "timestamp": "2026-11-15T01:00:00", "message": {"role": "user", "content": "Owner asks A"}},
             {"type": "assistant", "timestamp": "2026-11-15T01:00:05",
              "message": {"role": "assistant", "content": [{"type": "text", "text": "Claude says B"}]}}]
    log = logs / f"{sid}.jsonl"
    log.write_text("\n".join(json.dumps(x) for x in lines), encoding="utf-8")
    before = log.read_bytes()
    runs.logs = tmp / "logs"
    c = run(store, runs, "s1", model="qwen3:4b-instruct", prompt="What was asked?", sessionId=sid)
    msg = user_of(fake.sent[0])
    assert c["status"] == "done" and "Owner asks A" in msg and "Claude says B" in msg and log.read_bytes() == before
    bad = run(store, runs, "s2", model="qwen3:4b-instruct", prompt="x", sessionId="nope")
    assert bad["status"] == "failed" and "no log" in bad["error"]


def test_an_ollama_error_is_a_failed_run_with_its_message(setup):
    store, runs, root, fake, tmp = setup
    fake.chat = [{"error": "model requires more system memory"}]
    c = run(store, runs, "e1", model="qwen3:4b-instruct", prompt="x")
    assert c["status"] == "failed" and "more system memory" in c["error"]


def test_the_machine_record_lists_its_chat_models(setup):
    store, runs, *_ = setup
    st = Status(store, "PC", [], runs).own_state()
    assert [m["name"] for m in st["localModels"]["models"]] == ["qwen3:4b-instruct"]
    assert st["localModels"]["models"][0]["params"] == "4.0B" and st["localModels"]["error"] is None


def test_stop_ends_a_local_run(setup):
    store, runs, root, fake, tmp = setup

    class Slow(list):
        def __iter__(self):
            for i in range(200):
                time.sleep(0.02)
                yield (json.dumps({"message": {"content": f"w{i} "}, "done": False}) + "\n").encode()

    def opener(req, timeout):
        if req.full_url.endswith("/api/tags"):
            return Resp([], json.dumps(TAGS).encode())
        return Resp(Slow())

    import agent_bridge.localrun as lr
    lr.urllib.request.urlopen = opener
    store.docs["commands/t1"] = {"id": "t1", "action": "local", "machine": "PC", "status": "new", "createdAt": "1",
                                 "model": "qwen3:4b-instruct", "prompt": "x"}
    runs.step([store.get("commands/t1")])
    time.sleep(0.2)
    store.docs["commands/stop1"] = {"id": "stop1", "action": "stop", "machine": "PC", "status": "new", "createdAt": "2",
                                    "target": "t1"}
    runs.step([store.get("commands/stop1")])
    end = time.time() + 10
    while store.get("commands/t1")["status"] in ("running", "stopping") and time.time() < end:
        runs.step([])
        time.sleep(0.05)
    assert store.get("commands/t1")["status"] in ("stopped", "failed")
    assert "Stopped on the page." in (tmp / "out" / "t1.out").read_text(encoding="utf-8") or store.get("commands/t1")["status"] == "stopped"


# s4 (plan 1c08f4c2): short system prompt, context budget per model, chunks and log trimming, keep_alive, stop on repeat

def test_the_short_system_prompt_keep_alive_and_the_model_budget_go_with_every_run(setup):
    store, runs, root, fake, tmp = setup
    c = run(store, runs, "b1", model="qwen3:4b-instruct", prompt="Hi")
    body = fake.sent[0]
    assert body["messages"][0] == {"role": "system", "content": localrun.SYSTEM}
    assert "least verbose and in bullet points" in localrun.SYSTEM and len(localrun.SYSTEM) < 600
    assert body["keep_alive"] == "30m" and body["options"] == {"num_ctx": 8192, "num_predict": 1024}
    assert c["numCtx"] == 8192 and c["keepAlive"] == "30m"


def test_the_env_sets_num_ctx_and_keep_alive_and_the_model_length_caps_it(setup):
    store, runs, root, fake, tmp = setup
    (tmp / ".env").write_text("LOCAL_NUM_CTX=16384\nLOCAL_KEEP_ALIVE=2h\n")
    fake.length = 4096
    run(store, runs, "e2", model="qwen3:4b-instruct", prompt="Hi")
    assert fake.sent[0]["keep_alive"] == "2h" and fake.sent[0]["options"]["num_ctx"] == 4096


def test_each_run_counts_its_own_message_and_the_cache_keeps_the_measured_numbers(setup):
    store, runs, root, fake, tmp = setup
    f = root / "a.txt"
    f.write_text("word " * 600)
    run(store, runs, "k1", model="qwen3:4b-instruct", prompt="x", files=[str(f)])
    run(store, runs, "k2", model="qwen3:4b-instruct", prompt="x", files=[str(f)])
    assert fake.shows == 1 and len(fake.calib) == 2  # the length once per model; each run's message counted once
    cache = json.loads((tmp / "local_models.json").read_text())["qwen3:4b-instruct"]
    assert cache["contextLength"] == 262144 and cache["charsPerToken"] > 2.9 and "chars =" in cache["measuredFrom"]
    run(store, runs, "k3", model="qwen3:4b-instruct", prompt="Hi")
    assert len(fake.calib) == 2  # a run with no context is not counted


def test_a_file_over_the_budget_keeps_the_chunks_that_hold_the_question_words(setup):
    store, runs, root, fake, tmp = setup
    (tmp / ".env").write_text("LOCAL_NUM_CTX=2048\n")  # 2048 - 1024 answer - system and prompt: about 2,500 chars
    lines = [f"filler line {i} about nothing much at all here" for i in range(400)]
    lines[300] = "NEEDLE_PORT = 8471  # the port"
    f = root / "big.txt"
    f.write_text("\n".join(lines))
    c = run(store, runs, "n1", model="qwen3:4b-instruct", prompt="What is NEEDLE_PORT?", files=[str(f)])
    msg = user_of(fake.sent[0])
    assert "NEEDLE_PORT = 8471" in msg and "chars left out ..." in msg and msg.endswith("What is NEEDLE_PORT?")
    ctx = c["context"][0]
    assert ctx["sent"] < ctx["chars"] and ctx["chunks"].split(" of ")[0] != ctx["chunks"].split(" of ")[1]
    assert fake.calib[0] > 2048 and fake.calib[-1] <= 2048 - 1024 and c["budgetCounts"] == len(fake.calib) >= 2


def test_log_trimming_keeps_words_whole_and_cuts_tool_outputs(setup):
    store, runs, root, fake, tmp = setup
    logs = tmp / "logs" / "proj"
    logs.mkdir(parents=True)
    sid = "21111111-2222-3333-4444-555555555555"
    lines = [{"type": "user", "timestamp": "t", "message": {"role": "user", "content": "Owner asks A " + "a" * 500}},
             {"type": "assistant", "timestamp": "t", "message": {"role": "assistant", "content": [
                 {"type": "tool_use", "id": "u1", "name": "Bash", "input": {"command": "ls"}}]}},
             {"type": "user", "timestamp": "t", "message": {"role": "user", "content": [
                 {"type": "tool_result", "tool_use_id": "u1", "content": "x" * 5000}]}}]
    (logs / f"{sid}.jsonl").write_text("\n".join(json.dumps(x) for x in lines), encoding="utf-8")
    runs.logs = tmp / "logs"
    run(store, runs, "l1", model="qwen3:4b-instruct", prompt="What was asked?", sessionId=sid)
    msg = user_of(fake.sent[0])
    assert "Owner asks A " + "a" * 500 in msg and "[trimmed 4,700 chars]" in msg and "x" * 301 not in msg


def test_stop_on_repeat_ends_the_answer_and_keeps_the_block_once(setup):
    store, runs, root, fake, tmp = setup
    block = "- the same line comes back again and again here\n"
    fake.chat = [{"message": {"content": "- start\n"}, "done": False}] + \
        [{"message": {"content": block}, "done": False} for _ in range(40)]
    c = run(store, runs, "p1", model="qwen3:4b-instruct", prompt="x")
    ans = parse_result((tmp / "out" / "p1.out").read_text(encoding="utf-8"))["result"]
    assert c["status"] == "done" and c["stoppedOnRepeat"] is True
    assert ans.count("the same line") == 1 and ans.endswith("[stopped: the answer repeated itself]")
