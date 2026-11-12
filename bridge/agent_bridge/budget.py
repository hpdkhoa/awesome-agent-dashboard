"""Budget guard for a plan from a session (step i5; the owner's words in the plan: "Estimate pages x cost vs remaining
window; pause before the limit"; the owner's choice, 2026-11-12: "Page by page").

Before each page's notes run and before the plan write, the bridge reads the 5-hour window live (usage.claude_usage, the
same read as the Spend panel) and compares the next run's cost with what is left. When it does not fit, the plan pauses
before the run (runs.Runs._pause, the same pause as a usage limit cut: reset time, auto continue, finished pages kept).

Every number is measured and kept in budget.json (data_dir) with its source:
- pageUsd: the largest list-price cost of the last 50 page runs (their .out files, claude's total_cost_usd; a page
  run keeps no session, so that total is the run's own);
- writeUsd: the list-price cost of the last plan writes (their command's costUsd, from the session log);
- pctPerUsd: window percent per list-price dollar. First from one full window: 34% used for $30.18 logged between
  03:30 and 07:39 UTC on 2026-11-12 (1.1265 %/$); then from each page run: the window's percent after minus before,
  over the page's cost, summed over the last 50 pages.
The next run needs cost x pctPerUsd percent. It fits when used + need <= 100.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

SEED_PCT_PER_USD = {"value": 1.1265, "source": "5-hour window 2026-11-12 03:30-07:39 UTC: 34% used, $30.18 logged"}
KEEP = 50


class Budget:
    def __init__(self, path: Path, read, plans_dir: Path | None = None):
        self.path, self.read, self.plans_dir = path, read, plans_dir

    def load(self) -> dict:
        try:
            d = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            d = {}
        d.setdefault("pctPerUsd", dict(SEED_PCT_PER_USD))
        d.setdefault("samples", [])
        d.setdefault("writes", [2.775258])  # plan fd1f8a7c (64 pages, 2026-11-09): its write cost $2.78, from the log
        return d

    def save(self, d: dict) -> None:
        side = self.path.with_name(self.path.name + ".new")
        side.write_text(json.dumps(d, indent=1), encoding="utf-8")
        side.replace(self.path)

    def page_usd(self) -> float | None:
        """The largest cost of the last KEEP page runs, from their .out files."""
        if not self.plans_dir or not self.plans_dir.is_dir():
            return None
        outs = sorted(self.plans_dir.glob("*/notes-*.out"), key=lambda p: p.stat().st_mtime)[-KEEP:]
        costs = []
        for p in outs:
            try:
                r = json.loads(p.read_text(encoding="utf-8", errors="replace"))
            except ValueError:
                continue
            if isinstance(r, dict) and not r.get("is_error") and r.get("total_cost_usd"):
                costs.append(float(r["total_cost_usd"]))
        return max(costs) if costs else None

    def window(self) -> dict | None:
        """The 5-hour window now: {"percent", "resetsAt"}; None when it can't be read."""
        try:
            u = self.read()
        except Exception:
            return None
        w = next((x for x in u.get("windows") or [] if x.get("key") == "five_hour"), None)
        if not w or w.get("percent") is None:
            return None
        return {"percent": float(w["percent"]), "resetsAt": w.get("resetsAt")}

    def check(self, what: str) -> dict:
        """what: "page" or "write". {"ok", "need", "used", "left", "resetsAt", "usd", "pctPerUsd"}; ok with "off" when
        a number is missing (the guard can't judge: the run goes, and a real cut still pauses as before)."""
        d = self.load()
        usd = self.page_usd() if what == "page" else (max(d["writes"][-KEEP:]) if d["writes"] else None)
        frm = "largest of the last page runs" if what == "page" else "largest of the last plan writes"
        w = self.window()
        if usd is None or w is None:
            return {"ok": True, "off": "no page cost measured yet" if usd is None else "window not readable"}
        rate = float(d["pctPerUsd"]["value"])
        need = round(usd * rate, 2)
        used = w["percent"]
        return {"ok": used + need <= 100, "need": need, "used": used, "left": round(100 - used, 2),
                "resetsAt": w["resetsAt"], "usd": round(usd, 4), "usdFrom": frm, "pctPerUsd": round(rate, 4)}

    def learn(self, before: float | None, after: float | None, usd: float | None) -> None:
        """One page run's window rise over its cost. A reset between the two reads (after < before) is skipped."""
        if before is None or after is None or not usd or after < before:
            return
        d = self.load()
        d["samples"] = (d["samples"] + [{"pct": after - before, "usd": usd, "at": time.strftime("%Y-%m-%dT%H:%M:%S")}])[-KEEP:]
        pct, cost = sum(s["pct"] for s in d["samples"]), sum(s["usd"] for s in d["samples"])
        if cost > 0 and pct > 0:
            d["pctPerUsd"] = {"value": pct / cost, "source": f"{len(d['samples'])} page runs: window rise over their cost"}
        self.save(d)

    def wrote(self, usd: float | None) -> None:
        if usd:
            d = self.load()
            d["writes"] = (d["writes"] + [usd])[-KEEP:]
            self.save(d)
