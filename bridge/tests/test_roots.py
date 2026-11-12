"""Step i4, Work folders from the page (the owner's choice, 2026-11-12: "Bridge checks")."""

import shutil
import sys
import time
import uuid
from pathlib import Path

import pytest

from agent_bridge.config import Config, read_env, root_refusal, save_roots
from agent_bridge.files import Files
from agent_bridge.runs import Runs
from test_inbox import FakeStore


@pytest.fixture
def base():
    """A folder outside AppData (pytest's tmp_path is inside it, which the check refuses), removed after."""
    d = Path(__file__).resolve().parent / f"_roots_{uuid.uuid4().hex[:8]}"
    d.mkdir()
    yield d
    shutil.rmtree(d, ignore_errors=True)


FAKE = 'import json, os; print(json.dumps({"type": "result", "result": "in " + os.path.basename(os.getcwd())}))'


def test_refusals(base):
    tmp_path = base
    home = tmp_path / "home"
    (home / "AppData" / "x").mkdir(parents=True)
    (home / ".ssh").mkdir()
    ok = tmp_path / "proj"
    ok.mkdir()
    roots = [("labs", str(tmp_path / "labs"))]
    r = lambda name, folder: root_refusal(name, folder, roots, home)
    assert r("new", str(ok)) is None
    assert "already used" in r("Labs", str(ok))
    assert "letters" in r("", str(ok)) and "letters" in r("a;b=c", str(ok))
    assert "whole path" in r("new", "proj")
    assert "No such folder" in r("new", str(tmp_path / "missing"))
    assert "drive root" in r("new", Path(tmp_path).anchor)
    assert "user folder" in r("new", str(home)) and "user folder" in r("new", str(tmp_path))
    assert "AppData" in r("new", str(home / "AppData" / "x")) and ".ssh" in r("new", str(home / ".ssh"))
    assert "already a work folder" in root_refusal("other", str(ok), [("p", str(ok))], home)


def test_save_roots_changes_only_that_line(tmp_path):
    env = tmp_path / ".env"
    for eol in ("\n", "\r\n"):  # the file's own line ends stay (the live .env is CRLF)
        env.write_bytes(eol.join(["A=1", "# note", "WORK_ROOTS=labs=K:\\x", "SECRET=s", ""]).encode())
        save_roots([("labs", "K:\\x"), ("new", "K:\\y z")], env)
        assert env.read_bytes().decode() == eol.join(["A=1", "# note", "WORK_ROOTS=labs=K:\\x;new=K:\\y z", "SECRET=s", ""])
        assert read_env(env)["WORK_ROOTS"] == "labs=K:\\x;new=K:\\y z"
    bare = tmp_path / "bare.env"
    bare.write_bytes(b"A=1\n")
    save_roots([("n", "K:\\q")], bare)
    assert bare.read_bytes() == b"A=1\nWORK_ROOTS=n=K:\\q\n"


def test_added_folder_is_usable_at_once_with_no_restart(base):
    tmp_path = base
    fake = tmp_path / "fake.py"
    fake.write_text(FAKE)
    labs, new = tmp_path / "labs", tmp_path / "new"
    labs.mkdir()
    new.mkdir()
    env = tmp_path / ".env"
    env.write_text(f"WORK_ROOTS=labs={labs}\n", encoding="utf-8")
    store = FakeStore()
    store.put_many({"machines/PC": {"name": "PC", "folders": [{"workType": "labs", "path": str(labs)}]}})
    roots = [("labs", str(labs))]
    popen = lambda cmd, **kw: __import__("subprocess").Popen([sys.executable, str(fake), *cmd[1:]], **kw)
    runs = Runs(store, "PC", roots, "claude", tmp_path / "out", popen=popen, logs=None, procs=lambda: [])
    runs.env_path = env
    files = Files(roots, lambda t: None)
    runs.on_roots.append(lambda rs: [files.add_root(r) for _, r in rs])
    (new / "a.txt").write_text("x")
    try:
        files.resolve(str(new / "a.txt"), "")
        assert False, "served before it was added"
    except ValueError:
        pass
    t = time.time()
    store.put_many({"commands/a1": {"id": "a1", "machine": "PC", "status": "new", "action": "add_root", "name": "new",
                                    "folder": str(new), "createdAt": "1"}})
    runs.step()
    assert store.get("commands/a1")["status"] == "done"
    assert roots[-1][0] == "new"  # the same list the sync and the start check read
    assert {"workType": "new", "path": roots[-1][1]} in store.get("machines/PC")["folders"]
    assert f"new={roots[-1][1]}" in read_env(env)["WORK_ROOTS"]
    assert files.resolve(str(new / "a.txt"), "")
    store.put_many({"commands/s1": {"id": "s1", "machine": "PC", "status": "new", "action": "start", "folder": roots[-1][1],
                                    "prompt": "hi", "createdAt": "2"}})
    end = time.time() + 15
    while store.get("commands/s1")["status"] in ("new", "running") and time.time() < end:
        runs.step()
        time.sleep(0.1)
    assert store.get("commands/s1")["status"] == "done" and time.time() - t < 10
    store.put_many({"commands/a2": {"id": "a2", "machine": "PC", "status": "new", "action": "add_root", "name": "root",
                                    "folder": Path(tmp_path).anchor, "createdAt": "3"}})
    runs.step()
    assert store.get("commands/a2")["status"] == "failed" and "drive root" in store.get("commands/a2")["error"]
    assert len(roots) == 2
