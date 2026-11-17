"""hayaku avatar packs (the owner's picks, 2026-11-17: "B+file", "only pictures", "Local only"): named sets of the
four status pictures, kept by the bridge so the page can show, share and pick them and hayaku can load them.

A pack is pictures only: one picture per status (in_progress, done, offline, needs_you), a status without one shows
hayaku's built-in robot. The list lives in the local database (avatarPacks/<id>: name, statuses -> stored file), the
pictures as files in data_dir()/avatar-packs, named by their sha256 (one copy per picture, however many packs use
it). Pictures never go to Firestore (its 1 MB record cap; the owner's pick "Local only"): the backup is a .hayaku file.

A .hayaku file is a zip: pack.json {"format": 1, "name", "statuses": {status: file name in the zip}} and the pictures.
The same format is written and read by hayaku (avatar/src/avatar.rs).

POST /packs on the file viewer (files.py), the owner's sign-in checked there. One JSON body per call:
  {"op": "list"}                    -> {"packs": [{id, name, created, updated, statuses: {status: {ext, size}}}], "current": {id, at} | null}
  {"op": "pictures", "id"}          -> {"pictures": {status: data URL}}            the page's previews
  {"op": "get", "id"}               -> {"name", "zip": base64 of the .hayaku file}  download, and hayaku's load
  {"op": "put", "zip", "name"?}     -> {"id", "name"}                              upload a .hayaku file (a new pack)
  {"op": "rename", "id", "name"}    -> {"ok": true}
  {"op": "delete", "id"}            -> {"ok": true}                                pictures no pack uses are removed
  {"op": "select", "id" | null}     -> {"ok": true}                                "Use on hayaku": hayaku loads it
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import re
import secrets
import time
import zipfile
from pathlib import Path

STATUSES = ("in_progress", "done", "offline", "needs_you")
EXTS = {"gif": "image/gif", "png": "image/png", "apng": "image/png", "webp": "image/webp", "jpg": "image/jpeg",
        "jpeg": "image/jpeg", "svg": "image/svg+xml", "bmp": "image/bmp"}
MAX_PICTURE = 20 * 1024 * 1024   # hayaku's own cap per picture (avatar.rs MAX_BYTES)
MAX_ZIP = 4 * MAX_PICTURE + 64 * 1024
MAX_BODY = MAX_ZIP * 4 // 3 + 4096   # the zip as base64 in the JSON body
COLL = "avatarPacks"
CURRENT = "meta/avatarPack"
_ID = re.compile(r"[A-Za-z0-9]{1,40}")


def clean_name(name) -> str:
    n = re.sub(r"[\x00-\x1f\x7f]", "", str(name or "")).strip()[:60]
    if not n:
        raise ValueError("a pack needs a name")
    return n


def ext_of(name: str) -> str:
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext not in EXTS:
        raise ValueError(f"{name}: not a picture type ({', '.join(sorted(EXTS))})")
    return ext


def picture_ok(data: bytes, ext: str) -> None:
    """The bytes look like the type the name says (a renamed text file is refused)."""
    heads = {"gif": (b"GIF87a", b"GIF89a"), "png": (b"\x89PNG",), "apng": (b"\x89PNG",), "jpg": (b"\xff\xd8",),
             "jpeg": (b"\xff\xd8",), "bmp": (b"BM",)}
    if ext == "webp":
        good = data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    elif ext == "svg":
        good = b"<svg" in data[:4096].lower()
    else:
        good = data.startswith(heads[ext])
    if not good:
        raise ValueError(f"the {ext} picture is not a {ext} file")


def read_zip(raw: bytes) -> tuple[str, dict[str, tuple[str, bytes]]]:
    """A .hayaku file -> (name, {status: (ext, bytes)}). Refuses a broken zip, a missing or wrong pack.json, an unknown
    status, a picture over 20 MB or of the wrong type, a pack with no picture."""
    if len(raw) > MAX_ZIP:
        raise ValueError("the .hayaku file is over 80 MB")
    try:
        z = zipfile.ZipFile(io.BytesIO(raw))
        meta = json.loads(z.read("pack.json").decode("utf-8-sig"))
    except KeyError:
        raise ValueError("no pack.json in the .hayaku file")
    except Exception:
        raise ValueError("not a .hayaku file (a zip with pack.json)")
    if not isinstance(meta, dict) or not isinstance(meta.get("statuses"), dict):
        raise ValueError("pack.json needs statuses")
    out: dict[str, tuple[str, bytes]] = {}
    for st, fname in meta["statuses"].items():
        if st not in STATUSES:
            raise ValueError(f"unknown status {st} (only {', '.join(STATUSES)})")
        if not isinstance(fname, str) or "/" in fname or "\\" in fname or fname.startswith("."):
            raise ValueError(f"{st}: a picture name with no folder")
        ext = ext_of(fname)
        try:
            info = z.getinfo(fname)
        except KeyError:
            raise ValueError(f"{st}: {fname} is not in the .hayaku file")
        if info.file_size > MAX_PICTURE:
            raise ValueError(f"{st}: {fname} is over 20 MB")
        data = z.read(info)
        picture_ok(data, ext)
        out[st] = (ext, data)
    if not out:
        raise ValueError("the pack has no picture")
    return clean_name(meta.get("name") or "Pack"), out


def write_zip(name: str, pictures: dict[str, tuple[str, bytes]]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("pack.json", json.dumps({"format": 1, "name": name,
                                            "statuses": {st: f"{st}.{ext}" for st, (ext, _) in pictures.items()}}, indent=1))
        for st, (ext, data) in pictures.items():
            z.writestr(f"{st}.{ext}", data)
    return buf.getvalue()


class Packs:
    def __init__(self, store, folder: Path, clock=time.time):
        self.store, self.folder, self.clock = store, Path(folder), clock

    def _id(self, body: dict) -> str:
        i = str(body.get("id") or "")
        if not _ID.fullmatch(i):
            raise ValueError("not a pack id")
        return i

    def _pack(self, i: str) -> dict:
        p = self.store.get(f"{COLL}/{i}")
        if not p:
            raise ValueError("no such pack")
        return p

    def _pictures(self, pack: dict) -> dict[str, tuple[str, bytes]]:
        out = {}
        for st in STATUSES:
            s = (pack.get("statuses") or {}).get(st)
            if s:
                out[st] = (s["ext"], (self.folder / s["file"]).read_bytes())
        return out

    def _store_pictures(self, pictures: dict[str, tuple[str, bytes]]) -> dict:
        self.folder.mkdir(parents=True, exist_ok=True)
        out = {}
        for st, (ext, data) in pictures.items():
            fname = f"{hashlib.sha256(data).hexdigest()}.{ext}"
            dest = self.folder / fname
            if not dest.exists():
                tmp = dest.with_suffix(".part")
                tmp.write_bytes(data)
                tmp.replace(dest)
            out[st] = {"file": fname, "ext": ext, "size": len(data)}
        return out

    def _sweep(self) -> None:
        """Removes the picture files no pack names."""
        used = {s["file"] for p in self.store.find(COLL) for s in (p.get("statuses") or {}).values()}
        for f in self.folder.glob("*") if self.folder.exists() else []:
            if f.is_file() and f.name not in used:
                f.unlink(missing_ok=True)

    def answer(self, body: dict) -> dict:
        op = body.get("op")
        if op == "list":
            rows = self.store.find(COLL, order="updated", desc=True, limit=500, with_id=True)
            packs = [{"id": r["__id"], "name": r.get("name", ""), "created": r.get("created"), "updated": r.get("updated"),
                      "statuses": {st: {"ext": s["ext"], "size": s["size"]} for st, s in (r.get("statuses") or {}).items()}}
                     for r in rows]
            return {"packs": packs, "current": self.store.get(CURRENT)}
        if op == "pictures":
            pics = self._pictures(self._pack(self._id(body)))
            return {"pictures": {st: f"data:{EXTS[ext]};base64,{base64.b64encode(d).decode()}" for st, (ext, d) in pics.items()}}
        if op == "get":
            pack = self._pack(self._id(body))
            return {"name": pack["name"], "zip": base64.b64encode(write_zip(pack["name"], self._pictures(pack))).decode()}
        if op == "put":
            try:
                raw = base64.b64decode(str(body.get("zip") or ""), validate=True)
            except Exception:
                raise ValueError("the .hayaku file did not arrive whole")
            name, pictures = read_zip(raw)
            if body.get("name"):
                name = clean_name(body["name"])
            i, now = secrets.token_hex(8), self.clock()
            self.store.put_many({f"{COLL}/{i}": {"name": name, "created": now, "updated": now,
                                                  "statuses": self._store_pictures(pictures)}})
            return {"id": i, "name": name}
        if op == "rename":
            i = self._id(body)
            self._pack(i)
            self.store.merge(f"{COLL}/{i}", {"name": clean_name(body.get("name")), "updated": self.clock()})
            return {"ok": True}
        if op == "delete":
            i = self._id(body)
            self.store.delete(f"{COLL}/{i}")
            cur = self.store.get(CURRENT)
            if cur and cur.get("id") == i:
                self.store.put_many({CURRENT: {"id": None, "at": self.clock()}})
            self._sweep()
            return {"ok": True}
        if op == "select":
            i = body.get("id")
            if i is not None:
                self._pack(self._id(body))
            self.store.put_many({CURRENT: {"id": i, "at": self.clock()}})
            return {"ok": True}
        raise ValueError("unknown op")
