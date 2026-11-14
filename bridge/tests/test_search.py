"""s9 (plan c5cb9485): the search command. Gemini is faked (no network); the key never leaves for the record or .out."""
import io
import json
import time
import urllib.error

from agent_bridge import search
from agent_bridge.runs import Runs, parse_result
from agent_bridge.texts import live_of
from test_inbox import FakeStore

KEY = "AIza" + "Q" * 35  # the shape of a Google key, made up


def sse(*events):
    return [f"data: {json.dumps(e)}\n".encode() for e in events] + [b"\n"]


ANSWER = sse(
    {"candidates": [{"content": {"parts": [{"text": "Hanoi is the "}]}}]},
    {"candidates": [{"content": {"parts": [{"text": "capital of Vietnam."}]},
                     "groundingMetadata": {"groundingChunks": [{"web": {"uri": "https://a.example/1", "title": "a.example"}},
                                                               {"web": {"uri": "https://a.example/1", "title": "dup"}}]}}]},
)


class FakeResp(list):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def make(tmp_path, monkeypatch, env_text, opener):
    monkeypatch.delenv(search.KEY_NAME, raising=False)
    monkeypatch.delenv("GEMINI_MODEL", raising=False)
    env = tmp_path / ".env"
    env.write_text(env_text)
    store = FakeStore()
    runs = Runs(store, "PC", [], None, tmp_path / "out")
    runs.env_path = env
    monkeypatch.setattr(search.urllib.request, "urlopen", opener)
    return store, runs


def finish(runs, store, cid, seconds=10):
    end = time.time() + seconds
    while time.time() < end:
        runs.step([])
        if store.get(f"commands/{cid}").get("status") not in ("new", "running", "stopping"):
            return store.get(f"commands/{cid}")
        time.sleep(0.05)
    raise AssertionError("search did not end")


def test_search_streams_answer_records_sources_and_first_token(tmp_path, monkeypatch):
    seen = {}

    def opener(req, timeout):
        seen["url"], seen["headers"], seen["body"] = req.full_url, dict(req.header_items()), json.loads(req.data)
        return FakeResp(ANSWER)

    store, runs = make(tmp_path, monkeypatch, f"GEMINI_API_KEY={KEY}\n", opener)
    store.put_many({"commands/s1": {"id": "s1", "machine": "PC", "status": "new", "action": "search", "prompt": "capital of Vietnam?"}})
    runs.step()
    c = finish(runs, store, "s1")
    assert c["status"] == "done" and c["engine"] == "gemini" and c["model"] == search.DEFAULT_MODEL
    assert isinstance(c["firstTokenMs"], int) and c["firstTokenMs"] >= 0
    assert c["sources"] == [{"title": "a.example", "url": "https://a.example/1"}]  # the duplicate link dropped
    out = (tmp_path / "out" / "s1.out").read_text(encoding="utf-8")
    assert parse_result(out)["result"].startswith("Hanoi is the capital of Vietnam.\n\nSources:\n- [a.example]")
    assert live_of(out)["text"].startswith("Hanoi is the capital")  # the page's Live view reads it as a claude run
    # Google Search is on; the key goes in the header only
    assert seen["body"]["tools"] == [{"google_search": {}}] and "capital of Vietnam?" in json.dumps(seen["body"])
    assert KEY not in seen["url"] and seen["headers"].get("X-goog-api-key") == KEY
    assert KEY not in out and KEY not in json.dumps(store.docs)


def test_no_key_fails_at_once_with_the_config_line_and_calls_nothing(tmp_path, monkeypatch):
    called = []
    store, runs = make(tmp_path, monkeypatch, "OTHER=1\n", lambda *a, **k: called.append(1))
    store.put_many({"commands/s2": {"id": "s2", "machine": "PC", "status": "new", "action": "search", "prompt": "hi"}})
    runs.step()
    c = store.get("commands/s2")
    assert c["status"] == "failed" and c["error"] == search.NO_KEY and not called


def test_a_key_added_later_works_with_no_restart(tmp_path, monkeypatch):
    store, runs = make(tmp_path, monkeypatch, "", lambda req, timeout: FakeResp(ANSWER))
    store.put_many({"commands/a": {"id": "a", "machine": "PC", "status": "new", "action": "search", "prompt": "q"}})
    runs.step()
    assert store.get("commands/a")["status"] == "failed"
    runs.env_path.write_text(f"GEMINI_API_KEY={KEY}\n")  # what s10's Config node does
    store.put_many({"commands/b": {"id": "b", "machine": "PC", "status": "new", "action": "search", "prompt": "q"}})
    runs.step()
    assert finish(runs, store, "b")["status"] == "done"


def test_google_error_is_a_failed_run_with_its_message_redacted(tmp_path, monkeypatch):
    def opener(req, timeout):
        body = json.dumps({"error": {"message": f"API key not valid: {KEY}"}}).encode()
        raise urllib.error.HTTPError(req.full_url, 400, "Bad Request", {}, io.BytesIO(body))

    store, runs = make(tmp_path, monkeypatch, f"GEMINI_API_KEY={KEY}\n", opener)
    store.put_many({"commands/e": {"id": "e", "machine": "PC", "status": "new", "action": "search", "prompt": "q"}})
    runs.step()
    c = finish(runs, store, "e")
    assert c["status"] == "failed" and "Gemini said 400" in c["error"] and KEY not in json.dumps(store.docs)
    assert KEY not in (tmp_path / "out" / "e.out").read_text(encoding="utf-8")


def test_stop_ends_a_search(tmp_path, monkeypatch):
    def slow():
        for line in ANSWER[:1]:
            yield line
        time.sleep(0.5)
        for line in ANSWER[1:]:
            yield line

    class Slow(FakeResp):
        def __iter__(self):
            return slow()

    store, runs = make(tmp_path, monkeypatch, f"GEMINI_API_KEY={KEY}\n", lambda req, timeout: Slow())
    store.put_many({"commands/t": {"id": "t", "machine": "PC", "status": "new", "action": "search", "prompt": "q"}})
    runs.step()
    store.put_many({"commands/st": {"id": "st", "machine": "PC", "status": "new", "action": "stop", "target": "t"}})
    runs.step()
    assert finish(runs, store, "t")["status"] == "stopped"
