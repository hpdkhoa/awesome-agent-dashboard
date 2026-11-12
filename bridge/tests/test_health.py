import json
import time
import urllib.error
import urllib.request

from agent_bridge.files import Files, serve
from agent_bridge.health import Health, commit_of, log_errors


def verify(token):
    if token != "owner":
        raise PermissionError("not the owner")


def repo_at(tmp_path, sha):
    g = tmp_path / "repo" / ".git" / "refs" / "heads"
    g.mkdir(parents=True, exist_ok=True)
    (tmp_path / "repo" / ".git" / "HEAD").write_text("ref: refs/heads/main\n")
    (g / "main").write_text(sha + "\n")
    return tmp_path / "repo"


def post(base, path, body, token="owner"):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(), method="POST",
                                 headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def test_commit_of_reads_head_ref_and_packed_refs(tmp_path):
    repo = repo_at(tmp_path, "63b88d4aaaaaaaa")
    assert commit_of(repo) == "63b88d4"
    (repo / ".git" / "refs" / "heads" / "main").unlink()
    (repo / ".git" / "packed-refs").write_text("# pack\n9ced7b6bbbbbbbb refs/heads/main\n")
    assert commit_of(repo) == "9ced7b6"
    assert commit_of(tmp_path / "none") == ""


def test_log_errors_counts_the_last_day_only(tmp_path):
    now = time.time()
    old = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now - 2 * 86400))
    new = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now - 60))
    (tmp_path / "bridge.log").write_text(
        f"{old} failed, retrying: old\n{new} sessions 94, tokens 1\n{new} failed, retrying: 429 quota\n"
        f"{new} run r1: done; chain p1: stopped, step i9: the session reported it failed\n", encoding="utf-8")
    e = log_errors(tmp_path / "bridge.log", now)
    assert e["count"] == 1 and e["last"][0]["line"] == "failed, retrying: 429 quota"


def test_health_and_restart_over_the_signed_port(tmp_path):
    repo = repo_at(tmp_path, "9ced7b6aaaa")
    data = tmp_path / "data"
    data.mkdir()
    gone = []
    h = Health(repo, data, "PC", exit_fn=lambda: gone.append(1))
    srv = serve(Files([], verify), ["https://agent.example.com"], 0, health=h)
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    assert post(base, "/health", {}, token="stranger")[0] == 401  # owner only
    code, a = post(base, "/health", {})
    assert code == 200 and a["alive"] and a["runningCommit"] == "9ced7b6" and not a["newCode"]
    repo_at(tmp_path, "63b88d4aaaa")  # a new commit after the bridge started: Update shows
    h.synced()
    a = post(base, "/health", {})[1]
    assert a["newCode"] and a["repoCommit"] == "63b88d4" and a["lastSync"]
    assert post(base, "/restart", {"why": "update"})[0] == 400  # no confirm tap, no restart
    assert not gone
    code, r = post(base, "/restart", {"confirm": True, "why": "update"})
    assert code == 200 and r["why"] == "update"
    line = (data / "restarts.log").read_text(encoding="utf-8")
    assert "update asked by the owner on the page; running 9ced7b6, repo 63b88d4" in line
    time.sleep(2)
    assert gone == [1]  # the process exits; the task watchdog starts it again
    srv.shutdown()
