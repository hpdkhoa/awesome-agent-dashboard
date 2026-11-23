"""F6 round budget per plan (plan bf73af63; the step: "hours and window share per round, round report, owner opens the
next round"; its check: "a run past its round budget pauses with a round report"; the owner's picks 2026-11-23:
"Lift Hold, build F6", "6 h + 30% window", "At once, resumable"; the source, rules-review.md 4a: "The user reads the
round report and decides on a follow-up round").

planRounds/<plan> holds the round. Rounds are off until the owner turns them on for a plan on its page.
- hours: the agent-hours of the plan's runs since the round started (two runs at once count twice);
- window: the 5-hour window's rise while the plan's runs went, read once a minute; a rise is shared by the number of
  runs going on this bridge, so another plan's work is not charged to this one;
- past either limit: the plan's running runs are killed and marked paused (Continue goes on from their session), a
  round report goes to the owner's inbox and phone, new messages on the plan wait, and only the owner opens the next
  round, which continues the paused runs.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone

HOURS, WINDOW_PCT = 6.0, 30.0
EVERY, WINDOW_EVERY = 20, 60
AGENT = ("start", "message", "plan")


def _iso(t: float) -> str:
    return datetime.fromtimestamp(t, timezone.utc).isoformat(timespec="seconds")


def _ts(s) -> float | None:
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _kill(p) -> None:
    from .runs import _kill_tree

    _kill_tree(p)


class Rounds:
    def __init__(self, runs, clock=time.time, kill=_kill):
        self.runs, self.clock, self.kill = runs, clock, kill
        self.counting: set[str] = set()  # plans with an open round: read on the bridge's start (load), then kept here
        self.last, self.last_window, self.pct = 0.0, 0.0, None
        self.over: dict[str, bool] = {}  # plan -> round over: read once per plan, then kept by this class (only it writes)

    def load(self) -> None:
        """On the bridge's start: the plans whose round is open, so the 5 s step needs no query."""
        self.counting = {d["planId"] for d in self.runs.store.where("planRounds", "state", "open") if d.get("on")}

    def path(self, pid: str) -> str:
        return f"planRounds/{pid}"

    def blocked(self, c: dict) -> bool:
        pid = str(c.get("planId") or "")
        if not pid:
            return False
        if pid not in self.over:
            r = self.runs.store.get(self.path(pid))
            self.over[pid] = bool(r and r.get("on") and r.get("state") == "over")
        return self.over[pid]

    def hours(self, pid: str, since: float, now: float) -> tuple[float, list[dict]]:
        total, rows = 0.0, []
        for c in self.runs.store.where("commands", "planId", pid):
            if c.get("action") not in AGENT or not c.get("startedAt"):
                continue
            a = _ts(c["startedAt"])
            b = _ts(c["endedAt"]) if c.get("endedAt") else (now if c["id"] in self.runs.procs else None)
            if a is None or b is None or b <= since:
                continue
            sec = max(0.0, b - max(a, since))
            total += sec
            rows.append({"id": c["id"], "step": c.get("stepId") or "", "minutes": round(sec / 60, 1),
                         "usd": c.get("costUsd"), "status": c.get("status")})
        return total / 3600, rows

    def _window_shares(self, going: dict[str, list[str]], now: float, force: bool) -> dict[str, float]:
        budget = getattr(self.runs, "budget", None)
        if budget is None or (not force and now - self.last_window < WINDOW_EVERY):
            return {}
        self.last_window = now
        w = budget.window()
        if not w:
            return {}
        pct, old = float(w["percent"]), self.pct
        self.pct = pct
        if old is None:
            return {}
        rise = pct if pct < old else pct - old  # the window reset in between: all of its percent is new
        n = max(len(self.runs.procs), sum(len(v) for v in going.values()))  # every run going on this bridge shares the rise
        return {p: rise * len(v) / n for p, v in going.items()} if rise > 0 and n else {}

    def scan(self, force: bool = False) -> list[str]:
        now = self.clock()
        if not force and now - self.last < EVERY:
            return []
        self.last = now
        r = self.runs
        if not self.counting or not r.procs:
            self.pct = None  # no plan is counting: the next count starts from a fresh reading
            return []
        rows, going = {}, {}
        for p in list(self.counting):
            d = r.store.get(self.path(p))
            if not d or not d.get("on") or d.get("state") != "open":
                self.counting.discard(p)
                continue
            cids = [c["id"] for c in r.store.where("commands", "planId", p) if c["id"] in r.procs and c.get("action") in AGENT]
            if cids:
                rows[p], going[p] = d, cids
        if not rows:
            self.pct = None
            return []
        shares = self._window_shares(going, now, force)
        log = []
        for pid, d in rows.items():
            hours, runs_ = self.hours(pid, _ts(d["startedAt"]) or now, now)
            win = float(d.get("windowPct") or 0) + shares.get(pid, 0.0)
            fields = {"hoursUsed": round(hours, 3), "windowPct": round(win, 2), "updatedAt": _iso(now)}
            why = []
            max_h, max_w = float(d.get("budgetHours") or HOURS), float(d.get("budgetWindowPct") or WINDOW_PCT)
            if hours >= max_h:
                why.append(f"{hours:.2f} agent-hours of {max_h:g}")
            if win >= max_w:
                why.append(f"{win:.1f}% of the window, limit {max_w:g}%")
            if not why:
                r.store.update(self.path(pid), fields)
                continue
            log.append(self._over(pid, {**d, **fields}, why, runs_, going[pid], now))
        return log

    def _over(self, pid: str, d: dict, why: list[str], rows: list[dict], cids: list[str], now: float) -> str:
        r = self.runs
        plan = r.store.get(f"plans/{pid}") or {}
        states = {s.get("stepId"): s.get("state") for s in r.store.where("planSteps", "planId", pid)}
        v = r.store.get(f"planVersions/{pid}_v{plan.get('current', 0)}") or {}
        ids = [str(x.get("id")) for x in (v.get("parts") or {}).get("steps") or []] or sorted(states, key=str)
        open_ = [k for k in ids if states.get(k) != "done"]  # a step never reported counts as not done
        usd = sum(float(x["usd"]) for x in rows if x.get("usd"))
        report = {"round": d.get("round", 1), "startedAt": d["startedAt"], "endedAt": _iso(now), "why": "; ".join(why),
                  "hoursUsed": d["hoursUsed"], "windowPct": d["windowPct"], "budgetHours": d.get("budgetHours", HOURS),
                  "budgetWindowPct": d.get("budgetWindowPct", WINDOW_PCT), "usd": round(usd, 2), "runs": rows[-30:],
                  "paused": cids, "stepsOpen": open_}
        r.store.update(self.path(pid), {"hoursUsed": d["hoursUsed"], "windowPct": d["windowPct"], "state": "over",
                                        "updatedAt": _iso(now), "reports": [*(d.get("reports") or []), report]})
        self.over[pid] = True
        self.counting.discard(pid)
        for cid in cids:  # the state is written first, so no new message of this plan starts meanwhile
            r.store.update(f"commands/{cid}", {"roundPausing": True})
            p = r.procs.get(cid)
            if p is not None and p.poll() is None:
                self.kill(p)
        text = "\n".join([f"- Stopped: {report['why']}",
                          f"- Spent: {report['hoursUsed']:.2f} of {float(report['budgetHours']):g} h, {report['windowPct']:.1f} of "
                          f"{float(report['budgetWindowPct']):g}% window, ${report['usd']:.2f}, {len(rows)} runs",
                          f"- Paused runs: {len(cids)}; they go on when you open the next round",
                          f"- Steps not done: {', '.join(open_) or 'none'}",
                          f"- Next: press Open round {int(report['round']) + 1} on the plan page"])
        try:
            from .inbox import Inbox

            Inbox(r.store, r.machine, r.roots, "", plan.get("cwd") or "", push=r.push).result(
                f"Round {report['round']} report: {plan.get('title') or pid}", text, plan_id=pid)
        except Exception as e:  # noqa: BLE001: the pause stands; the report stays on the plan page
            r.store.update(self.path(pid), {"reportError": f"{type(e).__name__}: {str(e)[:200]}"})
        return f"plan {pid}: round {report['round']} over ({report['why']}), {len(cids)} runs paused"

    def command(self, c: dict) -> str:
        """The owner's buttons on the plan page: op on, off or next."""
        path, pid, op = f"commands/{c['id']}", str(c.get("planId") or ""), c.get("op")
        now = self.clock()
        store = self.runs.store
        d = store.get(self.path(pid)) if pid else None
        why = ("No plan." if not pid or not store.get(f"plans/{pid}")
               else "Unknown round action." if op not in ("on", "off", "next")
               else "Rounds are not on." if op in ("off", "next") and not (d and d.get("on"))
               else "This round is not over." if op == "next" and d.get("state") != "over"
               else "")
        if why:
            store.update(path, {"status": "failed", "error": why, "endedAt": _iso(now)})
            return f"{c['id']}: round refused, {why}"
        fresh = {"state": "open", "startedAt": _iso(now), "hoursUsed": 0, "windowPct": 0, "updatedAt": _iso(now)}
        n = 0
        self.over[pid] = False  # on, off and next all leave the plan's round not over
        if op == "on" and not (d and d.get("on")):
            store.put_many({self.path(pid): {**(d or {}), "planId": pid, "on": True, "round": int((d or {}).get("round") or 0) + 1,
                                             "budgetHours": HOURS, "budgetWindowPct": WINDOW_PCT, **fresh}})
        elif op == "off":
            store.update(self.path(pid), {"on": False, "updatedAt": _iso(now)})
        elif op == "next":
            store.update(self.path(pid), {"round": int(d.get("round") or 1) + 1, "reportError": None, **fresh})
        if op in ("off", "next"):
            for x in store.where("commands", "planId", pid):
                if x.get("roundPaused") and x.get("status") == "paused" and not x.get("continuedBy"):
                    nid, _ = self.runs.continue_run(x["id"])
                    n += 1 if nid else 0
        (self.counting.discard if op == "off" else self.counting.add)(pid)
        store.update(path, {"status": "done", "endedAt": _iso(now)})
        return f"{c['id']}: round {op} on plan {pid}, {n} paused runs continue"
