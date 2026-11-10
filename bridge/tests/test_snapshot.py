"""A decision's pictures are kept as they were at the answer (snapshot.py; the owner's words, 2026-11-10: "yes do the
snapshot")."""
import os
import time

from agent_bridge.snapshot import backfill, needs, take
from test_inbox import FakeStore


def item(cwd, at="2026-11-10T10:00:00+00:00", **f):
    return {"id": "q1", "machine": "PC", "planId": "p1", "cwd": str(cwd), "kind": "question",
            "options": [{"label": "Approve", "example": {"type": "image", "before": "a/old.png", "after": "a/new.png"}},
                        {"label": "Back", "example": {"type": "image", "before": "a/new.png", "after": str(cwd / "a" / "old.png")}},
                        {"label": "Text", "example": {"type": "text", "draft": "x"}}],
            "answer": {"choice": "Approve", "text": "", "at": at}, **f}


def setup(tmp_path):
    (tmp_path / "a").mkdir()
    (tmp_path / "a" / "old.png").write_bytes(b"v1")
    (tmp_path / "a" / "new.png").write_bytes(b"v2")
    store = FakeStore()
    return store


def test_copies_each_file_once_into_the_plan_folder_and_keeps_it_when_the_source_changes(tmp_path):
    store = setup(tmp_path)
    it = item(tmp_path, at="2099-01-01T00:00:00+00:00")
    store.put_many({"inbox/q1": it})
    snap = take(store, it)
    assert snap["files"]["Approve"] == {"before": ".plan_data/p1/decisions/q1/1-before-old.png",
                                        "after": ".plan_data/p1/decisions/q1/1-after-new.png"}
    assert snap["files"]["Back"]["before"] == snap["files"]["Approve"]["after"]  # one copy per source file
    assert snap["changed"] == [] and snap["missing"] == [] and "Text" not in snap["files"]
    (tmp_path / "a" / "new.png").write_bytes(b"v3")  # a later preview overwrites the source
    assert (tmp_path / snap["files"]["Approve"]["after"]).read_bytes() == b"v2"
    assert store.get("inbox/q1")["snapshot"]["at"] == it["answer"]["at"]
    assert not needs(store.get("inbox/q1")) and take(store, store.get("inbox/q1")) is None  # once per answer


def test_a_file_written_after_the_answer_is_marked_and_a_missing_one_listed(tmp_path):
    store = setup(tmp_path)
    it = item(tmp_path, at="2000-01-01T00:00:00+00:00")
    it["options"][0]["example"]["before"] = "a/gone.png"
    store.put_many({"inbox/q1": it})
    snap = take(store, it)
    assert snap["missing"] == ["a/gone.png"] and "a/new.png" in snap["changed"]


def test_a_changed_answer_takes_a_new_snapshot_and_nothing_without_answer_plan_or_images(tmp_path):
    store = setup(tmp_path)
    it = item(tmp_path)
    store.put_many({"inbox/q1": it})
    take(store, it)
    again = {**store.get("inbox/q1"), "answer": {"choice": "Back", "text": "", "at": "2026-11-10T11:00:00+00:00"}}
    assert needs(again) and take(store, again)["at"] == "2026-11-10T11:00:00+00:00"
    assert not needs({**it, "answer": None}) and not needs({**it, "planId": None})
    assert not needs({**it, "options": [it["options"][2]]})


def test_backfill_takes_the_answered_plan_questions_of_this_machine(tmp_path):
    store = setup(tmp_path)
    store.put_many({"inbox/q1": item(tmp_path), "inbox/q2": {**item(tmp_path), "id": "q2", "machine": "OTHER"}})
    assert len(backfill(store, "PC")) == 1 and backfill(store, "PC") == []
    assert "snapshot" not in store.get("inbox/q2")


def test_the_live_answer_takes_the_snapshot(tmp_path):
    from agent_bridge.inbox import Inbox

    store = setup(tmp_path)
    store.put_many({"inbox/q1": {**item(tmp_path), "status": "answered", "sessionId": "s1"}})
    inbox = Inbox(store, "PC", [("cc", str(tmp_path))], "s1", str(tmp_path))
    assert inbox.take_answer("q1") and store.get("inbox/q1")["snapshot"]["files"]["Approve"]
