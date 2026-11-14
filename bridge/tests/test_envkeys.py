"""s10 (plan c5cb9485): the Config node's two data API calls. A key goes into .env only: never into the database."""
import json

import pytest

from agent_bridge.dataapi import DataApi
from agent_bridge.search import settings
from test_inbox import FakeStore

KEY = "AIza" + "Z" * 35  # the shape of a Google key, made up


def api(tmp_path, text="FIREBASE_PROJECT_ID=x\r\nWORK_ROOTS=a=K:\a\r\n"):
    env = tmp_path / ".env"
    env.write_bytes(text.encode())
    store = FakeStore()
    return DataApi(store, env_path=env, backup_dir=tmp_path / "bk"), env, store


def test_keys_are_listed_masked(tmp_path):
    a, env, _ = api(tmp_path)
    assert a.answer({"op": "env_keys"}) == {"keys": [{"name": "GEMINI_API_KEY", "set": False, "last4": ""}]}
    env.write_bytes(env.read_bytes() + f"GEMINI_API_KEY={KEY}\r\n".encode())
    out = json.dumps(a.answer({"op": "env_keys"}))
    assert '"last4": "ZZZZ"' in out and KEY not in out


def test_set_writes_one_line_backs_up_and_keeps_the_rest(tmp_path, monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    a, env, store = api(tmp_path)
    before = env.read_bytes()
    r = a.answer({"op": "env_set", "name": "GEMINI_API_KEY", "value": KEY})
    assert r["ok"] and r["last4"] == "ZZZZ" and KEY not in json.dumps(r)
    assert (tmp_path / "bk" / r["backup"]).read_bytes() == before  # the old .env, as it was
    text = env.read_bytes().decode()
    assert text == before.decode() + f"GEMINI_API_KEY={KEY}\r\n"  # other lines and CRLF kept
    assert settings(env)[0] == KEY  # the search reads it at once, no restart
    a.answer({"op": "env_set", "name": "GEMINI_API_KEY", "value": "AIza" + "Y" * 35})
    assert env.read_bytes().decode().count("GEMINI_API_KEY=") == 1  # replaced, not added twice
    assert store.docs == {}  # nothing in the database, so nothing for the Firestore backup


@pytest.mark.parametrize("name,value", [("WORK_ROOTS", KEY), ("FIREBASE_PROJECT_ID", KEY), ("", KEY),
                                        ("GEMINI_API_KEY", "short"), ("GEMINI_API_KEY", "a b c d e f g h"),
                                        ("GEMINI_API_KEY", KEY + "\nWORK_ROOTS=C:\\"), ("GEMINI_API_KEY", 'x"=y' * 4)])
def test_refused_names_and_values_change_nothing(tmp_path, name, value):
    a, env, _ = api(tmp_path)
    before = env.read_bytes()
    with pytest.raises(ValueError) as e:
        a.answer({"op": "env_set", "name": name, "value": value})
    assert env.read_bytes() == before and value not in str(e.value)


def test_batch_and_many_never_reach_the_env(tmp_path):
    a, env, _ = api(tmp_path)
    before = env.read_bytes()
    a.answer({"op": "batch", "writes": [{"op": "env_set", "name": "GEMINI_API_KEY", "value": KEY}]})
    a.answer({"op": "many", "calls": [{"op": "env_set", "name": "GEMINI_API_KEY", "value": KEY}]})
    assert env.read_bytes() == before
