"""Step i6, local search and the daily digest (localsearch.py), with a fake Ollama: words become vector slots."""

import json

from agent_bridge.localsearch import LocalSearch
from agent_bridge.texts import Texts

WORDS = ["budget", "guard", "phone", "title", "archiver", "push", "stream", "token", "folder", "root"]


def fake_post(calls):
    def post(path, body, timeout=600):
        calls.append((path, body))
        if path == "/api/embed":
            return {"embeddings": [[float(t.lower().count(w)) + 0.01 for w in WORDS] for t in body["input"]]}
        return {"response": "- worked on " + body["prompt"].split("\n- ")[1][:20]}
    return post


def log(folder, sid, prompts, day="2026-11-11T03:00:00Z"):
    p = folder / "proj" / f"{sid}.jsonl"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("\n".join(json.dumps({"type": "user", "timestamp": day, "message": {"content": x}}) for x in prompts), encoding="utf-8")
    return p


def test_search_finds_the_session_and_reembeds_only_changed_logs(tmp_path):
    logs, calls = tmp_path / "logs", []
    log(logs, "s-budget", ["add a budget guard before each page", "guard numbers on the row"])
    log(logs, "s-phone", ["the phone title is hidden", "check the title on the phone"])
    log(logs, "s-arch", ["archiver push test"])
    ls = LocalSearch(logs, tmp_path / "search", fake_post(calls))
    assert ls.refresh()["embedded"] == 3
    assert ls.search("phone title")["results"][0]["session"] == "s-phone"
    assert ls.search("budget guard")["results"][0]["session"] == "s-budget"
    n = len(calls)
    assert ls.refresh()["embedded"] == 0 and len(calls) == n  # nothing changed: no embedding call
    log(logs, "s-arch", ["archiver push test", "stream token folder root"])
    assert ls.refresh()["embedded"] == 1
    assert ls.search("folder root")["results"][0]["session"] == "s-arch"
    assert LocalSearch(logs, tmp_path / "search", fake_post(calls)).index.keys() == {"s-budget", "s-phone", "s-arch"}  # kept on disk


def test_digest_per_day_and_the_text_route(tmp_path):
    logs, calls = tmp_path / "logs", []
    log(logs, "s1", ["budget guard"], "2026-11-11T03:00:00Z")
    log(logs, "s2", ["phone title"], "2026-11-01T03:00:00Z")
    ls = LocalSearch(logs, tmp_path / "search", fake_post(calls))
    ls.refresh()
    from agent_bridge.localsearch import _local_day
    day = _local_day("2026-11-11T03:00:00Z")
    body = ls.write_digest(day)
    assert "s1"[:2] in body and "worked on budget guard" in body and "1 sessions" in body
    t = Texts(logs, tmp_path / "out", ls)
    assert t.answer({"digest": day})["text"] == body and day in t.answer({"digest": day})["days"]
    assert t.answer({"digest": "2026-01-01"})["missing"]
    assert t.answer({"search": "phone"})["results"][0]["session"] == "s2"
    try:
        t.answer({"digest": "../x"})
        assert False
    except ValueError:
        pass
    try:
        Texts(logs, tmp_path / "out").answer({"search": "x"})
        assert False
    except ValueError as e:
        assert "off" in str(e)
