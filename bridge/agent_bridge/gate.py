"""s6 (plan 1c08f4c2) "Gate task set (score, no bar)": "Fixed tasks, 3 runs each; later tool tasks". The check:
"Table per model: pass rate, tokens/s". Rule: "no pass bar yet, show the score" (owner, round 2).

The same tasks for every model, run through the local runner's own code (gather, then LocalRun: the s4 budget,
chunks, log trimming, keep_alive and stop on repeat). The context is only the shipped fixtures (gate_fixtures/: two
files and a synthetic session log, no real session content), so every machine runs the same task set. No live
database is touched. Each model's score goes to <data>/local_models.json ("score"), which the bridge publishes with
the model list, so the Runs tab picker shows it. The score has no bar: nothing passes or fails a model.

Tool tasks come with stage 2 (s3b, agent tools); this set is prompt tasks only.

Usage: python -m agent_bridge.gate [model ...]   (no model: every chat model of this machine's Ollama)
"""
from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path

from .localrun import Budgets, LocalRun, gather, list_models, server_url, settings

FIXTURES = Path(__file__).resolve().parent.parent / "gate_fixtures"
RUNS = 3
LOG_ID = "00000000-0000-4000-8000-000000000006"  # gate_fixtures/gate-project/<id>.jsonl, the synthetic session log


def style_ok(answer: str) -> bool:
    """The h9 measure (rules_sync.py measure): at least 80% of the lines are bullets and no line is a header."""
    lines = [x for x in answer.splitlines() if x.strip()]
    bullets = [x for x in lines if re.match(r"\s*([-*•]|\d+\.)\s", x)]
    return bool(lines) and len(bullets) / len(lines) >= 0.8 and not any(x.lstrip().startswith("#") for x in lines)


# (id, what it measures, prompt, files, session id, pass test on the answer)
TASKS = [
    ("T1", "bullets, no headers (the h9 rule)", "What is a KV cache in LLM inference and why does it use memory?",
     [], "", style_ok),
    ("T2", "a fact from a small file", "What port does the Lab server listen on?", ["lab-notes.md"], "",
     lambda a: "8471" in a),
    ("T3", "a fact in an 84,554-character file", "In this file, what is the value of LIMIT_MARGIN, in seconds?",
     ["runs_copy.py.txt"], "", lambda a: re.search(r"\b120\b", a) is not None),
    ("T4", "the plan title from a 130,930-character session log", "What is the title of the plan 7e3a created in "
     "this session?", [], LOG_ID, lambda a: "backup" in a.lower() and "restore" in a.lower()),
]


def run_task(url: str, model: str, task, out_dir: Path, budgets: Budgets, st: dict, i: int, opener=None) -> dict:
    tid, _, prompt, files, sid, ok = task
    roots = [("gate", str(FIXTURES))]
    pieces, why = gather([str(FIXTURES / f) for f in files], sid, roots, FIXTURES)
    row = {"task": tid, "run": i}
    if why:
        return {**row, "pass": False, "error": why}
    out = out_dir / f"{model.replace(':', '_').replace('/', '_')}-{tid}-r{i}.out"
    run = LocalRun(f"gate-{tid}-{i}", url, model, prompt, pieces, out, budgets, st["num_ctx"], st["keep_alive"], opener)
    run.thread.join()
    res = next((json.loads(x) for x in reversed(out.read_text(encoding="utf-8").splitlines())
                if '"type": "result"' in x), {})
    answer = res.get("result") or "" if not res.get("is_error") else ""
    return {**row, "pass": bool(answer) and ok(answer), "seconds": round((res.get("duration_ms") or 0) / 1000, 1),
            "promptTokens": res.get("promptTokens"), "outputTokens": res.get("outputTokens"),
            "tokensPerSec": res.get("tokensPerSec"), "firstTokenMs": res.get("firstTokenMs"),
            "error": res.get("result") if res.get("is_error") else None, "answer": answer[:600]}


def score(rows: list[dict]) -> dict:
    """Pass count over runs, and tokens/s as all output tokens over all generation time (each run's out / rate)."""
    out = sum(r.get("outputTokens") or 0 for r in rows if r.get("tokensPerSec"))
    secs = sum((r.get("outputTokens") or 0) / r["tokensPerSec"] for r in rows if r.get("tokensPerSec"))
    per = {}
    for r in rows:
        p = per.setdefault(r["task"], {"pass": 0, "runs": 0, "seconds": 0.0})
        p["pass"] += bool(r["pass"])
        p["runs"] += 1
        p["seconds"] += r.get("seconds") or 0
    for p in per.values():
        p["seconds"] = round(p["seconds"] / p["runs"], 1)
    return {"pass": sum(bool(r["pass"]) for r in rows), "runs": len(rows),
            "tokensPerSec": round(out / secs, 2) if secs else None, "tasks": per,
            "at": time.strftime("%Y-%m-%d %H:%M:%S"), "from": f"gate task set, {len(TASKS)} tasks x {RUNS} runs"}


def gate(model: str, url: str, data: Path, env_path: Path | None = None, opener=None, log=print) -> dict:
    budgets = Budgets(data / "local_models.json", opener)
    st = settings(env_path)
    out_dir = data / "gate" / time.strftime("%Y%m%d-%H%M%S")
    out_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    for task in TASKS:
        for i in range(RUNS):
            rows.append(run_task(url, model, task, out_dir, budgets, st, i, opener))
            log(json.dumps({k: rows[-1].get(k) for k in ("task", "run", "pass", "seconds", "tokensPerSec", "error")}))
    s = score(rows)
    (out_dir / f"{model.replace(':', '_').replace('/', '_')}.json").write_text(
        json.dumps({"model": model, "score": s, "rows": rows}, indent=1, ensure_ascii=False), encoding="utf-8")
    with budgets.lock:
        budgets._save(model, {"score": s})
    return s


def main(argv: list[str]) -> int:
    from .config import REPO, data_dir

    env = REPO / ".env"
    url = server_url(env)
    models = argv or [m["name"] for m in list_models(url)]
    data = data_dir()
    for m in models:
        s = gate(m, url, data, env)
        print(f"{m}: {s['pass']}/{s['runs']} pass, {s['tokensPerSec']} tok/s")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
