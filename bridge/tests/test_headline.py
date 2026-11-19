"""F2 session headline (plan bf73af63): the session sets now / next, done/total (%), ETA on its running run row."""
import pytest

from agent_bridge.inbox import Inbox
from agent_bridge.localdb import LocalStore


@pytest.fixture
def ib(tmp_path):
    s = LocalStore(tmp_path / "db.sqlite")
    s.put_many({"commands/r1": {"id": "r1", "action": "message", "status": "running", "sessionId": "s1", "startedAt": "2026-11-19T01:00:00Z"},
                "commands/r0": {"id": "r0", "action": "message", "status": "done", "sessionId": "s1", "startedAt": "2026-11-19T00:00:00Z"}})
    return Inbox(s, "pc", [], "s1", ".")


def test_headline_lands_on_the_running_run(ib):
    h = ib.headline("building the Runs row", "the after picture", 3, 8, 12)
    row = ib.store.get("commands/r1")["headline"]
    assert h["run"] == "r1" and row["pct"] == 38 and row["done"] == 3 and row["total"] == 8
    assert row["now"] == "building the Runs row" and row["next"] == "the after picture" and row["eta"] > row["at"]
    assert "headline" not in ib.store.get("commands/r0")


def test_headline_light_work_and_refusals(ib):
    assert "pct" not in ib.headline("reading the code")
    with pytest.raises(ValueError):
        ib.headline("")
    with pytest.raises(ValueError):
        ib.headline("x", done=3)
    with pytest.raises(ValueError):
        ib.headline("x", done=9, total=8)
    ib.store.update("commands/r1", {"status": "done"})
    with pytest.raises(ValueError, match="No dashboard run"):
        ib.headline("x")
