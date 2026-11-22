"""F9 detached long jobs (plan bf73af63; the step: "jobs over ~20 min run detached with a done marker and progress file;
Runs tab reads them"; its check: "a killed session leaves the job running and its progress visible").

A session starts a long job with the inbox tool job_start. The job runs outside the session's process tree, so a
session that is stopped, killed or handed off leaves it going:

- the inbox server starts `python -m agent_bridge.jobs spawn <dir>`, which starts the runner and exits at once; the
  runner's parent is then gone, so a tree kill of the session (taskkill /T) never reaches it. On Windows both starts
  use CREATE_BREAKAWAY_FROM_JOB (when the parent's job object allows it) and CREATE_NO_WINDOW (no console pops up).
- the runner runs the command (PowerShell on Windows, sh elsewhere), writes all its output to out.log, and keeps
  progress.json fresh: a beat every BEAT seconds, the last output line, and done / total when the job prints a line
  "PROGRESS 12/40 rendering" (or "PROGRESS 30% note").
- when the command ends the runner writes the done marker done.json: exit code, end time, seconds.

Each job is a folder jobs_dir()/<id> with job.json (what was started), progress.json and done.json. The bridge reads
the folders (Jobs.scan) and keeps jobs/<id> in the store, which the Runs tab shows. A job with no done marker whose
runner is gone is "lost".
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

BEAT = 15  # seconds between the runner's beats in progress.json
STALE = 90  # a beat older than this, with the runner pid gone: the job is lost
PROGRESS = re.compile(r"^\s*PROGRESS\s+(?:(\d+)\s*/\s*(\d+)|(\d+(?:\.\d+)?)\s*%)\s*(.*)$", re.I)
KEEP_DAYS = 14  # finished job folders older than this are left out of the scan (the folders stay on disk)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def jobs_dir() -> Path:
    from .config import data_dir

    p = Path(os.environ.get("AAD_JOBS_DIR") or data_dir() / "runs" / "jobs")
    p.mkdir(parents=True, exist_ok=True)
    return p


def _write(path: Path, data: dict) -> None:
    """Atomic: a reader never sees half a file."""
    tmp = path.with_name(path.name + f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def _read(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _flags() -> dict:
    if os.name != "nt":
        return {"start_new_session": True}
    return {"creationflags": subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
            | subprocess.CREATE_BREAKAWAY_FROM_JOB}


def _detach(cmd: list[str], cwd: str, env: dict) -> subprocess.Popen:
    kw = dict(cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
              close_fds=True)
    try:
        return subprocess.Popen(cmd, **kw, **_flags())
    except OSError:  # the parent's job object refuses breakaway: start without it (the double start still detaches)
        f = _flags()
        if "creationflags" in f:
            f["creationflags"] &= ~subprocess.CREATE_BREAKAWAY_FROM_JOB
        return subprocess.Popen(cmd, **kw, **f)


def pid_alive(pid) -> bool:
    if not pid:
        return False
    try:
        import psutil

        p = psutil.Process(int(pid))
        return p.is_running() and p.status() != psutil.STATUS_ZOMBIE
    except Exception:
        return False


def start(command: str, cwd: str, name: str = "", expect_minutes: float = 0, meta: dict | None = None,
          python: str | None = None) -> dict:
    """Write the job folder and start the job detached; returns job.json. meta: who started it (session, run, plan,
    step, machine)."""
    command = str(command or "").strip()
    if not command:
        raise ValueError("job_start needs a command")
    if not cwd or not Path(cwd).is_dir():
        raise ValueError(f"no such folder: {cwd}")
    jid = uuid.uuid4().hex[:12]
    d = jobs_dir() / jid
    d.mkdir(parents=True)
    job = {"id": jid, "name": " ".join(str(name or command).split())[:120], "command": command, "cwd": str(cwd),
           "expectMinutes": float(expect_minutes or 0), "startedAt": now_iso(), "dir": str(d),
           "out": str(d / "out.log"), "progress": str(d / "progress.json"), "doneMarker": str(d / "done.json"),
           **(meta or {})}
    _write(d / "job.json", job)
    env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}
    env["PYTHONPATH"] = os.pathsep.join([str(Path(__file__).resolve().parent.parent), env.get("PYTHONPATH", "")])
    p = _detach([python or sys.executable, "-m", "agent_bridge.jobs", "spawn", str(d)], str(cwd), env)
    try:
        p.wait(timeout=20)  # the spawn stage only starts the runner and exits
    except subprocess.TimeoutExpired:
        pass
    for _ in range(50):  # the runner's first beat names its pid
        if (d / "progress.json").is_file():
            break
        time.sleep(0.1)
    return job


def _spawn(d: Path) -> int:
    """Stage 1: start the runner, then exit, so the runner has no living parent in the session's tree."""
    env = dict(os.environ)
    _detach([sys.executable, "-m", "agent_bridge.jobs", "run", str(d)], str(_read(d / "job.json")["cwd"]), env)
    return 0


def parse_progress(line: str) -> dict | None:
    m = PROGRESS.match(line)
    if not m:
        return None
    if m.group(1) is not None:
        done, total = int(m.group(1)), int(m.group(2))
        if total <= 0 or done < 0:
            return None
        return {"done": min(done, total), "total": total, "pct": round(100 * min(done, total) / total),
                "note": m.group(4).strip()[:200]}
    pct = max(0.0, min(100.0, float(m.group(3))))
    return {"pct": round(pct), "note": m.group(4).strip()[:200]}


def _run(d: Path) -> int:
    """Stage 2, the runner: run the command, keep progress.json fresh, write the done marker."""
    job = _read(d / "job.json") or {}
    shell = (["powershell", "-NoProfile", "-NonInteractive", "-Command", job["command"]] if os.name == "nt"
             else ["sh", "-c", job["command"]])
    env = {**os.environ, "JOB_ID": job["id"], "JOB_DIR": str(d), "PYTHONUNBUFFERED": "1"}
    t0 = time.time()
    state = {"id": job["id"], "state": "running", "runnerPid": os.getpid(), "childPid": None, "startedAt": now_iso(),
             "beatAt": now_iso(), "lines": 0, "outBytes": 0, "lastLine": ""}
    lock = threading.Lock()

    def beat():
        with lock:
            state["beatAt"] = now_iso()
            state["seconds"] = int(time.time() - t0)
            _write(d / "progress.json", state)

    beat()
    stop = threading.Event()

    def ticker():
        while not stop.wait(BEAT):
            beat()

    threading.Thread(target=ticker, daemon=True).start()
    code = -1
    with open(d / "out.log", "wb") as log:
        try:
            p = subprocess.Popen(shell, cwd=job["cwd"], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT)
            with lock:
                state["childPid"] = p.pid
            last = 0.0
            for raw in p.stdout:
                log.write(raw)
                log.flush()
                line = raw.decode("utf-8", "replace").rstrip("\r\n")
                with lock:
                    state["lines"] += 1
                    state["outBytes"] += len(raw)
                    if line.strip():
                        state["lastLine"] = line.strip()[:300]
                    got = parse_progress(line)
                    if got:
                        state["report"] = got
                if time.time() - last > 2:  # at most one write per 2 s while output pours
                    beat()
                    last = time.time()
            code = p.wait()
        except OSError as e:
            log.write(f"job could not start: {e}\n".encode())
    stop.set()
    with lock:
        state["state"] = "ended"
    beat()
    _write(d / "done.json", {"id": job["id"], "exit": code, "endedAt": now_iso(), "seconds": int(time.time() - t0),
                             "lastLine": state["lastLine"]})
    return 0


def read_job(d: Path, now: float | None = None, alive=pid_alive) -> dict | None:
    """One job as the Runs tab shows it: job.json + progress.json + done.json, and its state: running, done (exit 0),
    failed (other exit), lost (no done marker and the runner gone), starting (no beat yet)."""
    job = _read(d / "job.json")
    if not job:
        return None
    prog = _read(d / "progress.json") or {}
    done = _read(d / "done.json")
    now = time.time() if now is None else now
    row = {k: job.get(k) for k in ("id", "name", "command", "cwd", "startedAt", "expectMinutes", "dir", "out",
                                   "progress", "doneMarker", "sessionId", "runId", "planId", "stepId", "machine")}
    row.update({"beatAt": prog.get("beatAt"), "lastLine": prog.get("lastLine", ""), "lines": prog.get("lines", 0),
                "seconds": prog.get("seconds", 0), "report": prog.get("report"), "runnerPid": prog.get("runnerPid")})
    if done:
        row.update(state="done" if done.get("exit") == 0 else "failed", exit=done.get("exit"),
                   endedAt=done.get("endedAt"), seconds=done.get("seconds", row["seconds"]))
        return row
    beat = _ts(prog.get("beatAt")) or _ts(job.get("startedAt")) or now
    if not prog:
        row["state"] = "starting" if now - beat < STALE else "lost"
    elif alive(prog.get("runnerPid")) or (now - beat < STALE and prog.get("state") == "running"):
        row["state"] = "running"
    else:
        row["state"] = "lost"
    return row


def _ts(s) -> float | None:
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


class Jobs:
    """The bridge side: read the job folders every EVERY seconds and keep jobs/<id> in the store. A row is written only
    when it changed (a new beat alone is written at most once a minute)."""

    EVERY = 10

    def __init__(self, store, machine: str, root: Path | None = None, alive=pid_alive, clock=time.time):
        self.store, self.machine, self.root, self.alive, self.clock = store, machine, root, alive, clock
        self.sent: dict[str, tuple[str, float]] = {}
        self.last = 0.0

    def scan(self, force: bool = False) -> list[str]:
        now = self.clock()
        if not force and now - self.last < self.EVERY:
            return []
        self.last = now
        root = self.root or jobs_dir()
        log, writes = [], {}
        try:
            dirs = [d for d in root.iterdir() if d.is_dir()]
        except OSError:
            return []
        for d in dirs:
            if d.name in self.sent and self.sent[d.name][0].startswith("final:"):
                continue
            row = read_job(d, now, self.alive)
            if not row:
                continue
            if row["state"] in ("done", "failed", "lost") and now - (_ts(row.get("endedAt") or row.get("beatAt")
                                                                        or row.get("startedAt")) or now) > KEEP_DAYS * 86400:
                self.sent[d.name] = ("final:", now)
                continue
            row["machine"] = row.get("machine") or self.machine
            row["seenAt"] = now_iso()
            key = json.dumps({k: v for k, v in row.items() if k not in ("beatAt", "seenAt", "seconds")}, sort_keys=True)
            final = row["state"] in ("done", "failed", "lost")
            old = self.sent.get(d.name)
            if old and old[0] == key and (final or now - old[1] < 60):
                continue
            writes[f"jobs/{row['id']}"] = row
            if not old or old[0] != key:
                log.append(f"job {row['id']} {row['state']}: {row['name'][:60]}")
            self.sent[d.name] = (("final:" if final else "") + key, now)
        if writes:
            self.store.put_many(writes)
        return log


def main(argv: list[str]) -> int:
    if len(argv) == 2 and argv[0] in ("spawn", "run"):
        d = Path(argv[1])
        return _spawn(d) if argv[0] == "spawn" else _run(d)
    print("usage: python -m agent_bridge.jobs spawn|run <job folder>", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
