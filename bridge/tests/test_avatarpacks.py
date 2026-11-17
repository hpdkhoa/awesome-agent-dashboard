"""hayaku avatar packs (the owner's picks 2026-11-17: "B+file", "only pictures", "Local only"): a .hayaku file goes in,
comes out the same, the list and the pick are in the database, the pictures are files on this PC only."""
import base64
import io
import json
import zipfile

import pytest

from agent_bridge.avatarpacks import COLL, CURRENT, Packs, read_zip, write_zip
from agent_bridge.files import Files, serve
from agent_bridge.localdb import LocalStore
from test_files import call, verify

GIF = b"GIF89a" + b"\x00" * 20
PNG = b"\x89PNG\r\n\x1a\n" + b"\x01" * 20


def b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode()


def zip_of(meta, files):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        if meta is not None:
            z.writestr("pack.json", json.dumps(meta))
        for n, d in files.items():
            z.writestr(n, d)
    return buf.getvalue()


@pytest.fixture
def packs(tmp_path):
    return Packs(LocalStore(tmp_path / "data.sqlite"), tmp_path / "avatar-packs", clock=lambda: 100.0)


def test_a_pack_goes_in_and_comes_out_the_same(packs, tmp_path):
    raw = write_zip("Cats", {"done": ("gif", GIF), "in_progress": ("png", PNG)})
    i = packs.answer({"op": "put", "zip": b64(raw)})["id"]
    lst = packs.answer({"op": "list"})
    assert lst["packs"][0]["name"] == "Cats" and lst["packs"][0]["statuses"] == {"done": {"ext": "gif", "size": len(GIF)}, "in_progress": {"ext": "png", "size": len(PNG)}}
    assert lst["current"] is None
    name, pics = read_zip(base64.b64decode(packs.answer({"op": "get", "id": i})["zip"]))
    assert name == "Cats" and pics == {"done": ("gif", GIF), "in_progress": ("png", PNG)}
    p = packs.answer({"op": "pictures", "id": i})["pictures"]
    assert p["done"] == "data:image/gif;base64," + b64(GIF) and set(p) == {"done", "in_progress"}
    # pictures only on disk, by content: the database holds names and sizes, never the bytes
    assert len(list((tmp_path / "avatar-packs").iterdir())) == 2
    assert b64(GIF) not in json.dumps(packs.store.get(f"{COLL}/{i}"))


def test_same_picture_is_kept_once_and_removed_with_its_last_pack(packs, tmp_path):
    raw = write_zip("A", {"done": ("gif", GIF)})
    a = packs.answer({"op": "put", "zip": b64(raw)})["id"]
    b = packs.answer({"op": "put", "zip": b64(raw), "name": "B"})["id"]
    folder = tmp_path / "avatar-packs"
    assert len(list(folder.iterdir())) == 1
    packs.answer({"op": "delete", "id": a})
    assert len(list(folder.iterdir())) == 1
    packs.answer({"op": "delete", "id": b})
    assert list(folder.iterdir()) == []


def test_rename_select_and_delete_clears_the_pick(packs):
    i = packs.answer({"op": "put", "zip": b64(write_zip("A", {"done": ("gif", GIF)}))})["id"]
    packs.answer({"op": "rename", "id": i, "name": "  Night\n set "})
    assert packs.answer({"op": "list"})["packs"][0]["name"] == "Night set"
    packs.answer({"op": "select", "id": i})
    assert packs.store.get(CURRENT) == {"id": i, "at": 100.0}
    packs.answer({"op": "delete", "id": i})
    assert packs.store.get(CURRENT)["id"] is None
    packs.answer({"op": "select", "id": None})


@pytest.mark.parametrize("raw,why", [
    (b"not a zip", "not a .hayaku file"),
    (zip_of(None, {"done.gif": GIF}), "no pack.json"),
    (zip_of({"name": "x", "statuses": {"sleeping": "a.gif"}}, {"a.gif": GIF}), "unknown status"),
    (zip_of({"name": "x", "statuses": {"done": "../a.gif"}}, {}), "no folder"),
    (zip_of({"name": "x", "statuses": {"done": "a.exe"}}, {"a.exe": GIF}), "not a picture type"),
    (zip_of({"name": "x", "statuses": {"done": "a.gif"}}, {"a.gif": b"hello"}), "not a gif file"),
    (zip_of({"name": "x", "statuses": {"done": "a.gif"}}, {}), "not in the .hayaku file"),
    (zip_of({"name": "x", "statuses": {}}, {}), "no picture"),
])
def test_a_bad_file_is_refused_with_its_reason(packs, raw, why):
    with pytest.raises(ValueError, match=why):
        packs.answer({"op": "put", "zip": b64(raw)})
    assert packs.answer({"op": "list"})["packs"] == []


def test_bad_ids_and_ops_are_refused(packs):
    for body in [{"op": "get", "id": "../x"}, {"op": "get", "id": "nope"}, {"op": "rename", "id": "nope", "name": "a"},
                 {"op": "select", "id": "nope"}, {"op": "drop"}, {"op": "put", "zip": "!!"}]:
        with pytest.raises(ValueError):
            packs.answer(body)


def test_the_route_needs_the_owner_and_answers(tmp_path):
    p = Packs(LocalStore(tmp_path / "data.sqlite"), tmp_path / "ap")
    srv = serve(Files([("work", str(tmp_path))], verify), ["https://agent.example.com"], 0, packs=p)
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    try:
        st, _, _ = call(base, "/packs", {"op": "list"}, token="stranger")
        assert st == 401
        st, _, body = call(base, "/packs", {"op": "put", "zip": b64(write_zip("A", {"done": ("gif", GIF)}))})
        assert st == 200 and json.loads(body)["name"] == "A"
        st, _, body = call(base, "/packs", {"op": "list"})
        assert st == 200 and len(json.loads(body)["packs"]) == 1
        st, _, body = call(base, "/packs", {"op": "get", "id": "nope"})
        assert st == 400 and json.loads(body)["error"] == "no such pack"
    finally:
        srv.shutdown()
