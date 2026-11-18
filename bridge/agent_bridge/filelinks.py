"""The file links in a plan's text, found the way the page finds them (web/src/Markdown.tsx with FileView.tsx isLocal and
looksLikeFile), and the ones the page cannot open (the owner, 2026-11-10: "do as suggested": "when a plan version is
saved, the bridge refuses a file it can't find and asks the session for the full path"; the audit found 74 dead links
from bare names such as `2_solve3.png`)."""
from __future__ import annotations

import os
import re

from .files import clean, inside, secret

FENCE = re.compile(r"^(```|~~~).*?^\1", re.S | re.M)
LINK = re.compile(r"!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+\"[^\"]*\")?\s*\)")
CODE = re.compile(r"(?<!`)`([^`\n]+)`(?!`)")
FILE_RE = re.compile(r"^[\w.\-\\/:~ ]+\.(png|jpe?g|gif|webp|svg|avif|html?|pdf|md|mp4|webm|mov|txt|log|json|csv|py|ts|tsx|go)(:\d+)?$", re.I)
SCHEME = re.compile(r"^[a-z][a-z0-9+.\-]*:", re.I)


def is_local(href: str) -> bool:
    return bool(href) and not href.startswith("#") and (bool(re.match(r"^[a-zA-Z]:[\\/]", href))
                                                        or href.startswith("file:") or not SCHEME.match(href))


def looks_like_file(s: str) -> bool:
    return bool(FILE_RE.match(s)) and bool(re.search(r"[\\/.]", s))


def file_refs(text: str) -> list[str]:
    """Every link, image or `code` the page turns into a file link, in order, once each."""
    body = FENCE.sub("", text or "")
    out: list[str] = []
    for href in LINK.findall(body):
        if is_local(href) and href not in out:
            out.append(href)
    for code in CODE.findall(body):
        if looks_like_file(code) and code not in out:
            out.append(code)
    return out


def why_not(ref: str, cwd: str, roots: list[str]) -> str | None:
    """Why the page's file viewer cannot open ref from the plan folder cwd, or None when it can (files.py resolve)."""
    p = clean(ref)
    full = p if os.path.isabs(p) else os.path.join(cwd or "", p)
    if not os.path.isfile(full):
        return "not found"
    if not any(inside(full, r) for r in roots):
        return "outside the folders the viewer serves"
    if secret(full):
        return "a secret file"
    return None


def dead_links(text: str, cwd: str, roots: list[str]) -> list[str]:
    return [f"{r} ({why})" for r in file_refs(text) if (why := why_not(r, cwd, roots))]


def refuse_dead_links(text: str, cwd: str, roots: list[str]) -> None:
    dead = dead_links(text, cwd, roots)
    if dead:
        raise ValueError(
            "These file links cannot be opened on the dashboard: " + "; ".join(dead[:20])
            + (f"; and {len(dead) - 20} more" if len(dead) > 20 else "")
            + f". Give each its full path (K:\\...) or a path from the plan folder {cwd}; a file under a work folder "
            "only. A file that does not exist yet goes without backticks or a link.")


def _strings(x):
    if isinstance(x, str):
        yield x
    elif isinstance(x, dict):
        for v in x.values():
            yield from _strings(v)
    elif isinstance(x, (list, tuple)):
        for v in x:
            yield from _strings(v)


_DRIVE = re.compile(r"""(?:^|(?<=[\s(\["']))([A-Za-z]:[\\/][^\s`"'<>|*?()\[\]]+)""")


def attached_paths(store):
    """The files the reports point to, absolute, for the file viewer's outside-WORK_ROOTS case (the owner's pick
    2026-11-16 "Phục vụ đúng ảnh đã đính kèm"; 2026-11-17 every file kind, then "cover this too" for the links written
    in a report's text): evidence pictures, a result's files, and every file link the page shows in a result's text or
    a step report (reply and report fields). A relative link is read from the folder of the item that wrote it."""
    def ab(ref: str, cwd: str) -> str | None:
        p = clean(str(ref or ""))
        if not p:
            return None
        full = p if os.path.isabs(p) else (os.path.join(cwd, p) if cwd else "")
        return full or None

    for e in store.query("planEvidence"):
        for st in e.get("sets") or []:
            yield from st.get("pictures") or []
    # every inbox ask, not only results (the owner, 2026-11-18: "yes widen it"): its files, and the file links and the
    # plain drive paths written in its text, its option details and its thread (what hayaku's FILES + LINKS lists)
    for it in store.query("inbox"):
        cwd = it.get("cwd") or ""
        for f in it.get("files") or []:
            if (a := ab(f, cwd)):
                yield a
        texts = [it.get("text") or ""] + [str(o.get("detail") or "") for o in it.get("options") or [] if isinstance(o, dict)]
        texts += [str(x.get("text") or "") for x in it.get("thread") or [] if isinstance(x, dict)]
        for t in texts:
            for r in file_refs(t) + _DRIVE.findall(t):
                if (a := ab(r.rstrip(".,;:"), cwd)):
                    yield a
    # the materials a plan's board lists (the owner, 2026-11-17: "Add material section in report board")
    for plan in store.query("plans"):
        pid, cur = plan.get("id") or plan.get("__id") or "", plan.get("current")
        board = ((store.get(f"planVersions/{pid}_v{cur}") or {}).get("parts") or {}).get("board") or {} if pid else {}
        for m in board.get("materials") or []:
            if (a := ab(m.get("path") or "", plan.get("cwd") or "")):
                yield a
    cwds: dict[str, str] = {}
    for sv in store.query("planSteps"):
        pid = sv.get("planId") or str(sv.get("id", "")).split("_")[0]
        if pid not in cwds:
            cwds[pid] = (store.get(f"plans/{pid}") or {}).get("cwd", "") if pid else ""
        for v in sv.get("versions") or []:
            for t in _strings([v.get("reply"), v.get("report")]):
                for r in file_refs(t):
                    if (a := ab(r, cwds[pid])):
                        yield a
