"""Records with ids (plan bf73af63 step F1). Its check: record_add then record_query finds it; a run on a plan step gets
its matching records and cites them; a repeat of a rejected attempt without a new reason is refused with its id; a rule
edit makes v(n+1) with the owner's words."""

import pytest

from agent_bridge.localdb import LocalStore
from agent_bridge.records import (DUP, Records, Refused, cited_ids, feedback_rows, import_feedback, owner_words, sections,
                                  unit)


def fake_embed(texts, kind="document"):
    """A bag-of-letters vector: the same words give the same vector, other words a different one."""
    out = []
    for t in texts:
        v = [0.0] * 64
        for w in t.lower().split():
            v[hash(w) % 64] += 1.0
        out.append(unit(v))
    return out


def down(texts, kind="document"):
    raise OSError("Ollama down")


@pytest.fixture
def rec(tmp_path):
    return Records(LocalStore(tmp_path / "db.sqlite"), fake_embed, by="s1")


def test_add_then_query_finds_it(rec):
    rid = rec.add("dec", "Health keeps the watchdog only", words_='(2026-11-12) "keep the watchdog only"', area="dashboard")
    assert rid == "dec:1"
    got = rec.search("watchdog health")["results"]
    assert got[0]["id"] == "dec:1" and got[0]["meaning"] is not None
    assert rec.add("dec", "Bridge restarts only on the owner's word", new=True) == "dec:2"


def test_repeat_of_rejected_attempt_is_refused_with_its_id(rec):
    a = rec.add("att", "Detached bridge restart through a scheduled task", outcome="rejected", why="0 of 4 ran")
    with pytest.raises(Refused) as e:
        rec.add("att", "Detached bridge restart through a scheduled task")
    assert a in str(e.value) and "0 of 4 ran" in str(e.value)
    b = rec.add("att", "Detached bridge restart through a scheduled task", new_reason="the task now runs as the owner")
    assert rec.get(b)["links"]["retryOf"] == a


def test_near_duplicate_needs_duplicate_of_or_new(rec):
    a = rec.add("find", "7 of 40 done steps have pictures")
    with pytest.raises(Refused) as e:
        rec.add("find", "7 of 40 done steps have pictures")
    assert a in str(e.value)
    d = rec.add("find", "7 of 40 done steps have pictures", duplicate_of=a)
    assert rec.get(d)["status"] == "duplicate" and rec.get(a)["links"]["duplicates"] == [d]
    assert rec.add("find", "7 of 40 done steps have pictures", new=True) != a


def test_edit_makes_next_version_with_owner_words(rec):
    r = rec.add("rule", "Least verbose", words_="(10-29) do least verbose")
    with pytest.raises(ValueError):
        rec.edit(r, "Least verbose, bullet points")  # no owner's words
    assert rec.edit(r, "Least verbose, bullet points", words_="(11-08) all response must be bullet points") == 2
    got = rec.get(r)
    assert [v["v"] for v in got["versions"]] == [1, 2] and got["versions"][1]["words"].startswith("(11-08)")


def test_supersedes_and_links(rec):
    old = rec.add("dec", "Sync every 15 minutes")
    new = rec.add("dec", "Sync by hand only for this POC", supersedes=[old])
    assert rec.get(old)["status"] == "superseded" and rec.get(old)["links"]["supersededBy"] == [new]
    rec.link(new, plan="p1", step="F1", files=["bridge/agent_bridge/sync.py"])
    assert rec.get(new)["files"] == ["bridge/agent_bridge/sync.py"]


def test_gate_gives_matching_and_pinned_records_and_checks_cites(rec):
    pin = rec.add("les", "Send the whole harness in every plan_version", plan="p1", step="F8")
    hit = rec.add("dec", "claims boxes refuse a second box", new=True)
    rec.add("dec", "gold price typed by hand", new=True)
    g = rec.gate_for_run("step F8: claims boxes refuse a second box", "p1", "F8")
    assert g["ids"][0] == pin and hit in g["ids"] and "<kb-records>" in g["block"]
    assert rec.check_cites(g["ids"], f"used {pin}") == [x for x in g["ids"] if x != pin]
    assert rec.check_cites(g["ids"], " ".join(g["ids"])) == []
    assert cited_ids("per dec:41, att:9 and dec:41") == ["dec:41", "att:9"]


def test_words_only_when_ollama_is_down(tmp_path):
    rec = Records(LocalStore(tmp_path / "db.sqlite"), down)
    rec.add("dec", "watchdog only for health", check=False)
    got = rec.search("health watchdog")
    assert got["how"].startswith("words only") and got["results"][0]["id"] == "dec:1"


def test_rules_from_claude_md_version_on_edit(rec, tmp_path):
    md = tmp_path / "CLAUDE.md"
    md.write_text("# Rules\n\n## Least verbose\n\nThe owner's words (2026-10-29): \"do least verbose\".\n\n1. bullets\n\n"
                  "## Walls\n\n1. never scored\n", encoding="utf-8")
    first = rec.sync_rules(md)
    assert len(first["new"]) == 2 and set(first["versions"].values()) == {1}
    md.write_text(md.read_text(encoding="utf-8").replace("1. bullets", "1. bullets\n\nThe owner's words (2026-11-10): \"apply it to every new messages\".\n"), encoding="utf-8")
    second = rec.sync_rules(md)
    rid = second["changed"][0]
    assert second["versions"][rid] == 2 and "apply it to every new messages" in rec.get(rid)["versions"][1]["words"]
    assert rec.sync_rules(md)["changed"] == []
    with pytest.raises(ValueError, match="CLAUDE.md"):
        rec.edit(rid, "x", words_="(11-18) y")  # a CLAUDE.md rule changes only in the file


def test_feedback_log_forms(tmp_path):
    a = tmp_path / "a.md"
    a.write_text("| Date | Owner's words | Good / bad | What it means |\n|---|---|---|---|\n"
                 "| 2026-11-16 | \"Board open, rest folded\" | decision | Report board opens on load. |\n", encoding="utf-8")
    b = tmp_path / "b.md"
    b.write_text("## 2026-10-22\n\n| Owner's words | Good / bad | What it means |\n|---|---|---|\n"
                 "| \"use 1\" | decision | Grip axis from the well line. |\n", encoding="utf-8")
    c = tmp_path / "c.md"
    c.write_text("2026-10-31, the owner: \"check usage term for me\"\nDone: T1 to T8.\n", encoding="utf-8")
    assert [r["date"] for r in feedback_rows(a) + feedback_rows(b) + feedback_rows(c)] == ["2026-11-16", "2026-10-22", "2026-10-31"]
    rec = Records(LocalStore(tmp_path / "db.sqlite"), fake_embed)
    assert import_feedback(rec, a, "dashboard") == (1, 0)
    assert import_feedback(rec, a, "dashboard") == (0, 1)
    assert rec.get("dec:1")["words"] == '(2026-11-16) "Board open, rest folded"'


def test_sections_and_owner_words():
    s = sections("## A\n\nThe owner's words (2026-11-03): \"x y\".\n\n## B\n\nz")
    assert [h for h, _ in s] == ["A", "B"] and owner_words(s[0][1]) == '(2026-11-03) "x y".'


def test_human_copy_lists_live_records(rec):
    a = rec.add("dec", "one", area="dashboard", check=False)
    rec.add("dec", "two", area="dashboard", supersedes=[a], check=False)
    text = rec.human_copy("dashboard")
    assert "dec:2" in text and "dec:1" not in text
    assert 0 < DUP <= 1


def test_reads_page_past_the_data_api_cap(rec, monkeypatch):
    import agent_bridge.records as R

    monkeypatch.setattr(R, "PAGE", 2)
    ids = [rec.add("dec", f"decision number {i} about topic {i * 7}", check=False) for i in range(5)]
    assert [r["id"] for r in rec.all("dec")] == ids and len(rec._vecs()) == 5
