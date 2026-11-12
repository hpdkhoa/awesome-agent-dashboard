"""Step i5, Budget guard (the plan: "Estimate pages x cost vs remaining window; pause before the limit"; the owner's
choices, 2026-11-12: "Page by page", check "Replay + 1 real").

The replay: 5 plans from a session, 64 pages each, started with the 5-hour window at 60, 70, 80, 90 and 98% used. Each
page costs what one of the last 64 real page runs cost (their .out files on the PC, 2026-11-09). The fake claude moves
the window by cost x the window's true percent per dollar and cuts the run at 100%, as the real limit does; the window
reads back whole percents, as the real endpoint does. The check: 0 runs cut by the limit; every stop is the guard's."""

import json
import sys

import pytest

import agent_bridge.runs as runs_mod
from agent_bridge.budget import SEED_PCT_PER_USD, Budget
from test_planfrom import entry
from test_runs import cmd, setup, wait_done

REAL_PAGE_USD = [1.3113, 2.7456, 2.8016, 2.8278, 2.9028, 2.7921, 2.8328, 2.7627, 2.7215, 2.7606, 2.7369, 2.7769, 2.7506,
                 2.502, 2.8259, 2.8105, 2.7238, 2.8032, 2.8432, 2.7669, 2.8131, 2.8242, 2.7454, 2.7788, 2.6366, 2.6541,
                 2.6953, 2.6486, 2.836, 2.6254, 2.6318, 2.7088, 2.6859, 2.6427, 2.4942, 2.419, 2.5659, 2.6368, 2.4617,
                 2.5026, 2.5482, 2.405, 2.4396, 2.4118, 2.3716, 2.5046, 2.5956, 2.5387, 2.3385, 2.4205, 2.4733, 2.6218,
                 2.5878, 2.5882, 2.5724, 2.5892, 2.5732, 2.6108, 2.4374, 2.4051, 2.0065, 2.2198, 2.4464, 2.1952]
WRITE_USD = 2.775258  # plan fd1f8a7c's write, from its session log

FAKE = r'''
import json, os, sys
state_path = os.environ["FAKE_WINDOW"]
s = json.load(open(state_path))
plan_write = "--session-id" in sys.argv
cost = s["write"] if plan_write else s["costs"][s["i"] % len(s["costs"])]
s["i"] += 0 if plan_write else 1
rise = cost * s["rate"]
if s["percent"] + rise > 100:
    s["cuts"] += 1
    json.dump(s, open(state_path, "w"))
    print(json.dumps({"type": "result", "is_error": True, "api_error": "usage_limit_reached",
                      "result": "You've hit your 5-hour limit · resets 5:30pm (Asia/Ho_Chi_Minh)"}))
    sys.exit(1)
s["percent"] += rise
s["runs"] += 1
json.dump(s, open(state_path, "w"))
print(json.dumps({"type": "result", "result": "- notes", "total_cost_usd": cost, "session_id": "x"}))
'''


def fake_runs(tmp_path, monkeypatch, used, rate):
    store, runs, work = setup(tmp_path, monkeypatch)
    fake = tmp_path / "fake_window_claude.py"
    fake.write_text(FAKE)
    runs.popen = lambda cmd_, **kw: __import__("subprocess").Popen([sys.executable, str(fake), *cmd_[1:]], **kw)
    state = tmp_path / "window.json"
    state.write_text(json.dumps({"percent": used, "rate": rate, "costs": REAL_PAGE_USD, "write": WRITE_USD, "i": 0,
                                 "cuts": 0, "runs": 0}))
    monkeypatch.setenv("FAKE_WINDOW", str(state))
    # the past page runs on the PC, as the guard finds them
    past = tmp_path / "out" / "plans" / "old"
    past.mkdir(parents=True)
    for i, usd in enumerate(REAL_PAGE_USD, 1):
        (past / f"notes-{i:02d}.out").write_text(json.dumps({"result": "x", "total_cost_usd": usd}))

    def read():
        s = json.loads(state.read_text())
        return {"windows": [{"key": "five_hour", "percent": float(round(s["percent"])), "resetsAt": "2026-11-12T13:29:59+00:00"}]}

    runs.budget = Budget(tmp_path / "budget.json", read, tmp_path / "out" / "plans")
    log = tmp_path / "logs2" / "proj" / "s1.jsonl"
    log.parent.mkdir(parents=True)
    log.write_text("\n".join(entry("user", f"page {i} " + "x" * 150) for i in range(64)), encoding="utf-8")
    runs.logs = tmp_path / "logs2"
    orig = runs_mod.write_pages
    monkeypatch.setattr(runs_mod, "write_pages", lambda lg, folder: orig(lg, folder, page_bytes=200))
    return store, runs, work, state


@pytest.mark.parametrize("used,rate", [(60, SEED_PCT_PER_USD["value"]), (70, SEED_PCT_PER_USD["value"]), (80, 1.3),
                                       (90, 1.0), (98, 1.4)])
def test_replay_no_plan_run_is_cut_by_the_limit(tmp_path, monkeypatch, used, rate):
    store, runs, work, state = fake_runs(tmp_path, monkeypatch, used, rate)
    cmd(store, "p1", action="plan", sourceSessionId="s1", cwd=str(work), createdAt="1")
    runs.step()
    target, done, rounds = "p1", None, 0
    while rounds < 12:  # one round per 5-hour window
        c = wait_done(runs, target, store, seconds=120)
        s = json.loads(state.read_text())
        assert s["cuts"] == 0, f"cut by the limit at {s['percent']:.2f}% (round {rounds}, {c.get('stage')})"
        if c["status"] == "done":
            done = c
            break
        assert c["status"] == "paused" and "budget guard" in c["stage"], c
        g = c["budget"]
        assert g["used"] + g["need"] > 100 and g["resetsAt"] and c["autoContinue"]
        s["percent"] = 0.0  # the reset
        state.write_text(json.dumps(s))
        target, _ = runs.continue_run(target)
        runs.step()
        rounds += 1
    assert done is not None, "the plan never finished"
    s = json.loads(state.read_text())
    assert s["cuts"] == 0 and s["i"] == 64  # every page ran once: no page lost, none run twice
    print(f"start {used}% rate {rate}: {rounds} guard pauses, 0 cuts, 64 pages + write")


def test_guard_numbers(tmp_path):
    reads = {"p": 90.0}
    b = Budget(tmp_path / "b.json", lambda: {"windows": [{"key": "five_hour", "percent": reads["p"], "resetsAt": "r"}]}, None)
    assert b.check("page") == {"ok": True, "off": "no page cost measured yet"}
    g = b.check("write")
    assert g["usd"] == round(WRITE_USD, 4) and g["need"] == round(WRITE_USD * SEED_PCT_PER_USD["value"], 2) and g["ok"]
    reads["p"] = 97.0
    assert not b.check("write")["ok"]
    b.learn(10.0, 13.0, 2.0)
    assert b.load()["pctPerUsd"]["value"] == 1.5
    b.learn(13.0, 2.0, 2.0)  # a reset between the reads: skipped
    assert len(b.load()["samples"]) == 1
    broken = Budget(tmp_path / "c.json", lambda: (_ for _ in ()).throw(ValueError("offline")), None)
    assert broken.check("write") == {"ok": True, "off": "window not readable"}


def test_without_the_guard_the_same_replay_is_cut(tmp_path, monkeypatch):
    """The replay bites: with no guard, the plan started at 60% is cut by the limit."""
    store, runs, work, state = fake_runs(tmp_path, monkeypatch, 60, SEED_PCT_PER_USD["value"])
    runs.budget = None
    cmd(store, "p1", action="plan", sourceSessionId="s1", cwd=str(work), createdAt="1")
    runs.step()
    c = wait_done(runs, "p1", store, seconds=120)
    assert c["status"] == "paused" and "usage limit" in c["stage"] and json.loads(state.read_text())["cuts"] == 1
