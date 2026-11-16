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
    g = {k["name"]: k for k in a.answer({"op": "env_keys"})["keys"]}["GEMINI_API_KEY"]
    assert g["set"] is False and g["last4"] == "" and g["secret"] and "value" not in g
    env.write_bytes(env.read_bytes() + f"GEMINI_API_KEY={KEY}\r\n".encode())
    out = json.dumps(a.answer({"op": "env_keys"}))
    assert '"last4": "ZZZZ"' in out and KEY not in out


def test_every_bridge_key_is_listed_plain_in_full_secret_masked(tmp_path):
    a, env, _ = api(tmp_path, f"GEMINI_API_KEY={KEY}\nVITE_FIREBASE_API_KEY={KEY}\nGEMINI_MODEL=gemini-2.5-x\nWORK_ROOTS=a=K:\\a\n")
    keys = a.answer({"op": "env_keys"})["keys"]
    names = [k["name"] for k in keys]
    assert len(names) == 18 and "ANTHROPIC_API_KEY" not in names
    by = {k["name"]: k for k in keys}
    assert by["GEMINI_MODEL"]["value"] == "gemini-2.5-x" and by["WORK_ROOTS"]["value"] == "a=K:\\a"
    assert {k for k, r in by.items() if r["risky"]} == {"WORK_ROOTS", "SITE_ORIGINS", "OWNER_EMAIL"}
    assert all(r["when"] == "rebuild" for k, r in by.items() if k.startswith(("VITE_", "FIREBASE_")))
    assert KEY not in json.dumps(keys)  # both secrets masked


@pytest.mark.parametrize("name,value", [("GEMINI_MODEL", "gemini-2.5-flash-native-audio-latest"), ("OLLAMA_URL", "http://linux:11434"),
                                        ("LOCAL_NUM_CTX", "8192"), ("LOCAL_KEEP_ALIVE", "10m"), ("FILES_PORT", "8793"),
                                        ("STATUS_HOSTS", "linux=10.0.0.5:8794;mac=mac.local"), ("MACHINE_NAME", "Republic-Gamer"),
                                        ("VITE_FIREBASE_AUTH_DOMAIN", "x.firebaseapp.com")])
def test_plain_settings_are_written_and_shown_in_full(tmp_path, name, value):
    a, env, _ = api(tmp_path)
    r = a.answer({"op": "env_set", "name": name, "value": value})
    assert r["ok"] and r["value"] == value and f"{name}={value}" in env.read_text()


@pytest.mark.parametrize("name,value", [("WORK_ROOTS", "a=K:\\a;b=D:\\Work"), ("SITE_ORIGINS", "https://agent.500kv.co"),
                                        ("OWNER_EMAIL", "me@example.com")])
def test_risky_keys_need_the_second_confirm(tmp_path, name, value):
    a, env, _ = api(tmp_path)
    before = env.read_bytes()
    for c in (None, False, "true", 1):
        body = {"op": "env_set", "name": name, "value": value}
        if c is not None:
            body["confirm"] = c
        with pytest.raises(ValueError, match="CONFIRM"):
            a.answer(body)
        assert env.read_bytes() == before
    assert a.answer({"op": "env_set", "name": name, "value": value, "confirm": True})["ok"]
    assert f"{name}={value}" in env.read_text()


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


@pytest.mark.parametrize("name,value", [("ANTHROPIC_API_KEY", KEY), ("CLAUDE_BIN", "C:\\x.exe"), ("", KEY),
                                        ("GEMINI_API_KEY", "short"), ("GEMINI_API_KEY", "a b c d e f g h"),
                                        ("GEMINI_API_KEY", KEY + "\nWORK_ROOTS=C:\\"), ("GEMINI_API_KEY", 'x"=y' * 4),
                                        ("GEMINI_MODEL", "bad model"), ("OLLAMA_URL", "ftp://x"), ("OLLAMA_URL", "http://x\n#"),
                                        ("LOCAL_NUM_CTX", "0"), ("LOCAL_NUM_CTX", "8k"), ("FILES_PORT", "70000"),
                                        ("LOCAL_KEEP_ALIVE", "10 minutes"), ("STATUS_HOSTS", "linux"), ("MACHINE_NAME", "a#b"),
                                        ("OWNER_EMAIL", "not-an-email"), ("SITE_ORIGINS", "agent.500kv.co"),
                                        ("WORK_ROOTS", 'a="K:\\a"')])
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
