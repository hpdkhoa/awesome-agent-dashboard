"""F9 detached long jobs (jobs.py): the runner writes progress.json and the done marker; the bridge's scan keeps
jobs/<id>; a job started from a process whose tree is then killed keeps running."""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from agent_bridge import jobs
from agent_bridge.localdb import LocalStore

WIN = os.name == "nt"


def _cmd(lines: list[str], sleep: float) -> str:
    if WIN:
        return "; ".join(f"Write-Output '{l}'; Start-Sleep -Milliseconds {int(sleep * 1000)}" for l in lines)
    return "; ".join(f"echo '{l}'; sleep {sleep}" for l in lines)


def _wait(cond, secs: float = 60):
    end = time.time() + secs
    while time.time() < end:
        v = cond()
        if v:
            return v
        time.sleep(0.2)
    return None


def test_parse_progress():
    assert jobs.parse_progress("PROGRESS 12/40 rendering") == {"done": 12, "total": 40, "pct": 30, "note": "rendering"}
    assert jobs.parse_progress("progress 55% step two")["pct"] == 55
    assert jobs.parse_progress("PROGRESS 5/0") is None
    assert jobs.parse_progress("no progress here") is None


def test_job_runs_writes_progress_and_done_marker(tmp_path, monkeypatch):
    monkeypatch.setenv("AAD_JOBS_DIR", str(tmp_path / "jobs"))
    job = jobs.start(_cmd(["PROGRESS 1/3 a", "PROGRESS 2/3 b", "PROGRESS 3/3 c", "last words"], 0.3), str(tmp_path),
                     "unit job", 1, {"sessionId": "s1"})
    d = Path(job["dir"])
    done = _wait(lambda: jobs._read(d / "done.json"))
    assert done and done["exit"] == 0
    prog = jobs._read(d / "progress.json")
    assert prog["report"] == {"done": 3, "total": 3, "pct": 100, "note": "c"}
    assert prog["lastLine"] == "last words" and prog["state"] == "ended"
    assert "PROGRESS 2/3 b" in (d / "out.log").read_text(encoding="utf-8", errors="replace")
    store = LocalStore(tmp_path / "db.sqlite")
    j = jobs.Jobs(store, "pc", root=tmp_path / "jobs")
    assert any("done" in line for line in j.scan(force=True))
    row = store.get(f"jobs/{job['id']}")
    assert row["state"] == "done" and row["exit"] == 0 and row["sessionId"] == "s1" and row["name"] == "unit job"
    assert j.scan(force=True) == []  # a finished job is written once


def test_failed_exit_and_lost_runner(tmp_path):
    d = tmp_path / "a"
    d.mkdir()
    jobs._write(d / "job.json", {"id": "a", "name": "x", "command": "x", "cwd": str(tmp_path), "startedAt": jobs.now_iso()})
    jobs._write(d / "done.json", {"id": "a", "exit": 3, "endedAt": jobs.now_iso(), "seconds": 1})
    assert jobs.read_job(d)["state"] == "failed"
    b = tmp_path / "b"
    b.mkdir()
    jobs._write(b / "job.json", {"id": "b", "name": "y", "command": "y", "cwd": str(tmp_path), "startedAt": "2026-01-01T00:00:00+00:00"})
    jobs._write(b / "progress.json", {"state": "running", "runnerPid": 999999, "beatAt": "2026-01-01T00:00:00+00:00"})
    assert jobs.read_job(b, alive=lambda p: False)["state"] == "lost"
    jobs._write(b / "progress.json", {"state": "running", "runnerPid": 999999, "beatAt": jobs.now_iso()})
    assert jobs.read_job(b, alive=lambda p: False)["state"] == "running"  # a fresh beat counts until STALE


@pytest.mark.skipif(not WIN, reason="taskkill tree kill is the Windows case the bridge uses")
def test_tree_kill_of_the_starter_leaves_the_job_running(tmp_path):
    """The session stand-in: a python process that calls jobs.start and then sleeps; taskkill /T /F on it (what the
    bridge's Stop does to a run) must leave the job's runner going and ending with its done marker."""
    jd = tmp_path / "jobs"
    code = ("import sys,time,json; from agent_bridge import jobs; "
            f"j=jobs.start({_cmd(['PROGRESS 1/4 a', 'PROGRESS 2/4 b', 'PROGRESS 3/4 c', 'PROGRESS 4/4 d'], 1.5)!r}, {str(tmp_path)!r}, 'kill test'); "
            "print(json.dumps(j), flush=True); time.sleep(120)")
    env = {**os.environ, "AAD_JOBS_DIR": str(jd), "PYTHONPATH": str(Path(jobs.__file__).parent.parent)}
    starter = subprocess.Popen([sys.executable, "-c", code], env=env, stdout=subprocess.PIPE, text=True,
                               creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
    job = json.loads(starter.stdout.readline())
    d = Path(job["dir"])
    assert _wait(lambda: jobs._read(d / "progress.json"), 20)
    subprocess.run(["taskkill", "/PID", str(starter.pid), "/T", "/F"], capture_output=True)
    assert starter.wait(10) is not None
    prog = jobs._read(d / "progress.json")
    assert jobs.pid_alive(prog["runnerPid"])  # the runner lives on
    done = _wait(lambda: jobs._read(d / "done.json"), 60)
    assert done and done["exit"] == 0
    assert jobs._read(d / "progress.json")["report"]["done"] == 4
