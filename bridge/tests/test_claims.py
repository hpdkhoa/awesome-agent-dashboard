"""F8, claims across boxes (plan bf73af63; the step's check: "two boxes on one step: second refused")."""
import time

import pytest

from agent_bridge.claims import LOCAL, Claims, folder_key, step_key
from test_inbox import FakeStore
from test_runs import cmd, setup


class Control(FakeStore):
    """The control plane every box shares (Firestore), with its atomic create."""

    def create(self, path, fields):
        if path in self.docs:
            return False
        self.put_many({path: fields})
        return True


def wait(runs, cid, store, seconds=20):
    end = time.time() + seconds
    while time.time() < end:
        runs.step()
        if store.get(f"commands/{cid}")["status"] not in ("new", "running", "stopping"):
            return store.get(f"commands/{cid}")
        time.sleep(0.2)
    raise AssertionError("run did not finish")


def test_two_boxes_on_one_step_the_second_is_refused_and_never_starts(tmp_path, monkeypatch):
    control = Control()
    a_store, a_runs, work = setup(tmp_path / "a", monkeypatch) if (tmp_path / "a").mkdir() is None else None
    b_store, b_runs, b_work = setup(tmp_path / "b", monkeypatch) if (tmp_path / "b").mkdir() is None else None
    b_runs.machine = "BOX-B"
    a_runs.claims, b_runs.claims = Claims(control, a_store, "PC"), Claims(control, b_store, "BOX-B")
    cmd(a_store, "a1", action="message", sessionId="sa", cwd=str(work), prompt="sleep", planId="p1", stepId="F8")
    a_runs.step()
    assert a_store.get("commands/a1")["status"] == "running"
    held = control.get(f"claims/{step_key('p1', 'F8')}")
    assert held["machine"] == "PC" and held["runId"] == "a1" and a_store.get(f"{LOCAL}/{held['key']}")["stepId"] == "F8"
    b_store.put_many({"commands/b1": {"id": "b1", "machine": "BOX-B", "status": "new", "action": "message", "sessionId": "sb",
                                      "cwd": str(b_work), "prompt": "work", "planId": "p1", "stepId": "F8"}})
    b_runs.step()
    b = b_store.get("commands/b1")
    assert b["status"] == "failed" and "claimed by box PC" in b["error"] and b["claim"]["refusedBy"] == "PC"
    assert "b1" not in b_runs.procs and b_store.where(LOCAL, "machine", "BOX-B") == []
    # box A's run ends: its claim goes, and box B can take the step
    a_runs.procs["a1"].kill()
    a_runs.procs["a1"].wait()
    a_runs.step()
    assert control.get(f"claims/{held['key']}") is None and a_store.get(f"{LOCAL}/{held['key']}") is None
    b_store.put_many({"commands/b2": {"id": "b2", "machine": "BOX-B", "status": "new", "action": "message", "sessionId": "sb",
                                      "cwd": str(b_work), "prompt": "work", "planId": "p1", "stepId": "F8"}})
    assert wait(b_runs, "b2", b_store)["status"] == "done"
    assert control.get(f"claims/{held['key']}") is None  # released again at its end


def test_the_same_box_claims_again_and_a_run_without_a_step_claims_nothing(tmp_path, monkeypatch):
    control = Control()
    store, runs, work = setup(tmp_path, monkeypatch)
    runs.claims = Claims(control, store, "PC")
    ok, first = runs.claims.take("step", "s0", "old", "session", plan_id="p1", step_id="F8")
    cmd(store, "m1", action="message", sessionId="s1", cwd=str(work), prompt="hi", planId="p1", stepId="F8")
    assert wait(runs, "m1", store)["status"] == "done" and ok
    cmd(store, "m2", action="message", sessionId="s1", cwd=str(work), prompt="hi")
    assert wait(runs, "m2", store)["status"] == "done" and "claim" not in store.get("commands/m2")
    assert [k for k in control.docs if k.startswith("claims/")] == []


def test_session_claims_on_a_folder_and_release_only_their_own(tmp_path):
    control = Control()
    a, b = Claims(control, FakeStore(), "PC"), Claims(control, FakeStore(), "BOX-B")
    ok, c = a.take("folder", "s1", by="session", folder=str(tmp_path))
    assert ok and c["key"] == folder_key(str(tmp_path) + "/.")
    ok, held = b.take("folder", "s2", by="session", folder=str(tmp_path))
    assert not ok and held["machine"] == "PC"
    assert b.release(c["key"]) is False and control.get(f"claims/{c['key']}")  # box B cannot drop box A's claim
    assert a.release_run("", "s1") == [c["key"]] and control.get(f"claims/{c['key']}") is None
    with pytest.raises(ValueError):
        a.take("step", "s1")
    with pytest.raises(ValueError):
        a.take("gpu", "s1")


def test_a_control_plane_error_never_blocks_the_run(tmp_path, monkeypatch):
    class Down(Control):
        def create(self, path, fields):
            raise SystemExit("Firestore refused (503): down")

    store, runs, work = setup(tmp_path, monkeypatch)
    runs.claims = Claims(Down(), store, "PC")
    cmd(store, "m1", action="message", sessionId="s1", cwd=str(work), prompt="hi", planId="p1", stepId="F8")
    c = wait(runs, "m1", store)
    assert c["status"] == "done" and "503" in c["claim"]["error"]


def test_a_dead_box_claim_expires_after_two_missed_heartbeats(tmp_path):
    # the owner, 2026-11-19: "dead box need both expiry and button"
    from datetime import datetime, timezone
    control = Control()
    now = datetime(2026, 11, 19, 12, 0, tzinfo=timezone.utc).timestamp()
    iso = lambda minutes_ago: datetime.fromtimestamp(now - minutes_ago * 60, timezone.utc).isoformat()
    a, b = Claims(control, FakeStore(), "PC", clock=lambda: now), Claims(control, FakeStore(), "BOX-B", clock=lambda: now)
    a.take("step", "sa", "r1", plan_id="p1", step_id="F8")
    control.put_many({"bridges/PC": {"seenAt": iso(29)}})
    ok, held = b.take("step", "sb", "r2", plan_id="p1", step_id="F8")
    assert not ok and held["machine"] == "PC"  # 29 minutes: still alive
    control.put_many({"bridges/PC": {"seenAt": iso(31)}})
    ok, mine = b.take("step", "sb", "r2", plan_id="p1", step_id="F8")
    assert ok and mine["tookOver"] == {"machine": "PC", "sessionId": "sa", "silentMinutes": 31}
    assert control.get(f"claims/{step_key('p1', 'F8')}")["machine"] == "BOX-B"
    control.docs.pop("bridges/BOX-B", None)
    ok, held = a.take("step", "sa", "r3", plan_id="p1", step_id="F8")
    assert not ok  # BOX-B has no registry entry: never expires, the page's Release frees it
