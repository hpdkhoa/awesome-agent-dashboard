"""A plan version whose file links the page cannot open is refused (filelinks.py; the owner, 2026-11-10: "do as
suggested": the bridge refuses a file it can't find and asks the session for the full path)."""
import pytest

from agent_bridge.filelinks import dead_links, file_refs
from test_inbox import FakeStore


def test_finds_the_links_the_page_makes():
    text = ("See `2_solve3.png`, ![a](pics/a.png), [doc](docs/X.md), [web](https://x.io/a.png), `npm run build`,\n"
            "```\n`inside.png`\n```\n`K:/w/b.svg:12` and `2_solve3.png` again")
    assert file_refs(text) == ["pics/a.png", "docs/X.md", "2_solve3.png", "K:/w/b.svg:12"]


def test_a_link_must_exist_inside_a_work_folder(tmp_path):
    (tmp_path / "labs").mkdir()
    (tmp_path / "labs" / "2_solve3.png").write_bytes(b"x")
    out = tmp_path.parent / "elsewhere.md"
    out.write_text("x")
    text = f"`2_solve3.png` `labs/2_solve3.png` `{tmp_path / 'labs' / '2_solve3.png'}` `{out}`"
    assert dead_links(text, str(tmp_path), [str(tmp_path)]) == [
        "2_solve3.png (not found)", f"{out} (outside the folders the viewer serves)"]


def test_plan_version_refuses_dead_links_but_a_plain_version_keeps_old_text(tmp_path):
    from agent_bridge.inbox import Inbox

    store = FakeStore()
    (tmp_path / "a.png").write_bytes(b"x")
    inbox = Inbox(store, "PC", [("cc", str(tmp_path))], "s1", str(tmp_path))
    store.put_many({"plans/p1": {"id": "p1", "cwd": str(tmp_path), "current": 1, "phase": "explore"},
                    "planVersions/p1_v1": {"text": "old `gone.png`"}})
    with pytest.raises(ValueError, match=r"gone\.png \(not found\).*full path"):
        inbox.plan_version("p1", "new text with `gone.png` and `a.png`")
    assert inbox.plan_version("p1", "new text with `a.png`") == 2
    assert inbox.plan_version("p1", "", phase="build", order="Move the plan to Build.") == 3  # copies v2: no check
