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
