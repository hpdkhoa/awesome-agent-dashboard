"""F6 round budget: a run past its round budget pauses with a round report; only the owner opens the next round."""
from types import SimpleNamespace as NS

from agent_bridge.rounds import Rounds, _iso
from test_runs import setup


class Proc:
    pid, returncode = 4242, None

    def poll(self):
        return self.returncode


def go(tmp_path, monkeypatch, pct=None):
    store, runs, work = setup(tmp_path, monkeypatch)
    t = [1_800_000_000.0]
    killed = []

    def kill(p):
        p.returncode = 1
        killed.append(p)

    runs.rounds = Rounds(runs, clock=lambda: t[0], kill=kill)
    if pct is not None:
        runs.budget = NS(window=lambda: {"percent": pct[0], "resetsAt": ""})
    store.put_many({"plans/p": {"id": "p", "title": "T", "cwd": str(work), "machine": runs.machine},
                    "planSteps/p_s1": {"planId": "p", "stepId": "s1", "state": "now"},
                    "commands/on": {"id": "on"}})
    runs.rounds.command({"id": "on", "planId": "p", "op": "on"})
    store.put_many({"commands/r": {"id": "r", "machine": runs.machine, "action": "message", "status": "running", "planId": "p",
                                   "stepId": "s1", "sessionId": "x", "startedAt": _iso(t[0]), "prompt": "go"}})
    p = Proc()
    runs.procs["r"] = p
    (runs.out_dir / "r.out").write_text("", encoding="utf-8")
    return store, runs, t, p, killed


def test_hours_limit_pauses_reports_and_only_next_round_continues(tmp_path, monkeypatch):
    store, runs, t, p, killed = go(tmp_path, monkeypatch)
    t[0] += 5.9 * 3600
    assert runs.rounds.scan(force=True) == [] and not killed
    assert store.get("planRounds/p")["hoursUsed"] == 5.9
    t[0] += 0.2 * 3600
    assert "round 1 over" in runs.rounds.scan(force=True)[0] and killed == [p]
    d = store.get("planRounds/p")
    assert d["state"] == "over" and d["reports"][0]["paused"] == ["r"] and d["reports"][0]["stepsOpen"] == ["s1"]
    assert "round budget" in runs._finish("r", p)
    c = store.get("commands/r")
    assert c["status"] == "paused" and c["roundPaused"] and not c["autoContinue"]
    assert any(i.get("kind") == "result" and "Round 1 report" in i.get("title", "") for i in store.where("inbox", "planId", "p"))
    assert runs.rounds.blocked({"planId": "p"})
    store.put_many({"commands/n": {"id": "n"}})
    runs.rounds.command({"id": "n", "planId": "p", "op": "next"})
    d = store.get("planRounds/p")
    assert d["round"] == 2 and d["state"] == "open" and d["hoursUsed"] == 0 and len(d["reports"]) == 1
    assert store.get("commands/r")["continuedBy"] and not runs.rounds.blocked({"planId": "p"})


def test_window_share_limit_splits_the_rise_between_running_plans(tmp_path, monkeypatch):
    pct = [10.0]
    store, runs, t, p, killed = go(tmp_path, monkeypatch, pct)
    store.put_many({"commands/other": {"id": "other", "action": "message", "status": "running", "planId": "q"}})
    runs.procs["other"] = Proc()
    runs.rounds.scan(force=True)
    pct[0] = 50.0
    t[0] += 60
    runs.rounds.scan(force=True)
    assert store.get("planRounds/p")["windowPct"] == 20.0 and not killed
    pct[0] = 72.0
    t[0] += 60
    assert "window" in runs.rounds.scan(force=True)[0] and killed == [p] and not runs.procs["other"].returncode


def test_a_plan_with_rounds_off_is_never_paused(tmp_path, monkeypatch):
    store, runs, t, p, killed = go(tmp_path, monkeypatch)
    store.put_many({"commands/o": {"id": "o"}})
    runs.rounds.command({"id": "o", "planId": "p", "op": "off"})
    t[0] += 20 * 3600
    assert runs.rounds.scan(force=True) == [] and not killed and not runs.rounds.blocked({"planId": "p"})
