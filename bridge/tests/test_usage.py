import json
import urllib.error

import pytest

from agent_bridge import firestore
from agent_bridge.files import Files, serve
from agent_bridge.usage import FREE_TIER, Counter, UsageCheck, claude_usage
from test_files import call, verify


def test_counter_counts_per_day_and_survives_a_restart(tmp_path, monkeypatch):
    path = tmp_path / "c.json"
    c = Counter(path)
    c.add("reads", 3)
    c.add("writes")
    c.add("deletes", 0)  # nothing
    c.add("other", 5)  # unknown kind: ignored
    assert c.today()["reads"] == 3 and c.today()["writes"] == 1 and c.today()["deletes"] == 0
    again = Counter(path)
    assert again.today()["reads"] == 3  # read back from the file
    monkeypatch.setattr("agent_bridge.usage.local_day", lambda: "2099-01-01")
    assert again.today()["reads"] == 0  # a new day starts at zero


def test_rest_calls_are_counted(tmp_path, monkeypatch):
    c = Counter(tmp_path / "c.json")
    firestore.set_counter(c)
    try:
        firestore.count_call("https://x/v1/p:runQuery", {"structuredQuery": {}}, None, [{"document": {}}, {"document": {}}, {"readTime": 1}])
        firestore.count_call("https://x/v1/p/docs/a", None, None, {"fields": {}})
        firestore.count_call("https://x/v1/p/docs/a?updateMask.fieldPaths=x", {"fields": {}}, "PATCH", {})
        firestore.count_call("https://x/v1/p:commit", {"writes": [{"update": {}}, {"update": {}}, {"delete": "p"}]}, None, {})
        t = c.today()
        assert (t["reads"], t["writes"], t["deletes"]) == (3, 3, 1)
    finally:
        firestore.set_counter(None)


def test_claude_usage_reads_the_windows(tmp_path):
    creds = tmp_path / ".credentials.json"
    creds.write_text(json.dumps({"claudeAiOauth": {"accessToken": "tok", "subscriptionType": "max", "rateLimitTier": "t"}}), encoding="utf-8")
    body = {"five_hour": {"utilization": 90.0, "resets_at": "2026-11-09T16:49:59+00:00", "locked_reason": None},
            "seven_day": {"utilization": 23.0, "resets_at": "2026-11-15T13:59:59+00:00"},
            "seven_day_opus": None, "extra_usage": {"is_enabled": False}}
    seen = {}

    def fetch(token):
        seen["token"] = token
        return body

    u = claude_usage(creds, fetch)
    assert seen["token"] == "tok"
    assert [w["key"] for w in u["windows"]] == ["five_hour", "seven_day"]
    assert u["windows"][0]["percent"] == 90.0 and u["windows"][0]["resetsAt"].startswith("2026-11-09")
    assert u["plan"] == "max" and u["extraUsage"] is False and u["checkedAt"]

    def expired(token):
        raise urllib.error.HTTPError("u", 401, "no", {}, None)

    with pytest.raises(ValueError, match="expired"):
        claude_usage(creds, expired)
    with pytest.raises(ValueError, match="no Claude sign-in"):
        claude_usage(tmp_path / "missing.json", fetch)


def test_usage_call_needs_the_owner(tmp_path):
    c = Counter(tmp_path / "c.json")
    c.add("reads", 7)
    srv = serve(Files([("work", str(tmp_path))], verify), ["https://agent.example.com"], 0, usage=UsageCheck(c, tmp_path / "none.json"))
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    try:
        status, _, body = call(base, "/usage", {"what": "firestore"})
        j = json.loads(body)
        assert status == 200 and j["today"]["reads"] == 7 and j["freeTier"] == FREE_TIER and j["counted"] is True
        assert call(base, "/usage", {"what": "firestore"}, token="guest")[0] == 401
        assert call(base, "/usage", {"what": "claude"})[0] == 404  # no sign-in file in this test folder
        assert call(base, "/usage", {"what": "x"})[0] == 400
    finally:
        srv.shutdown()


def test_page_reads_land_in_the_counter_by_listener(tmp_path):
    c = Counter(tmp_path / "c.json")
    u = UsageCheck(c, tmp_path / "none.json")
    r = u.answer({"what": "page", "tab": "ab12", "by": {"usage": 76, "commands": 100, "bad": "x", "neg": -5}})
    assert r == {"ok": True, "added": 176, "tab": "ab12"}
    t = c.today()
    assert t["reads"] == 176 and t["by"]["page:usage"]["reads"] == 76 and "page:bad" not in t["by"]
