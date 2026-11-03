"""The real record of a session, read from its log on this PC, in pages a plan run can read (plan from a session).

The owner's words, 2026-11-03: "get all the data from the session, read all real execution to start a plan", then
"do 1 and 3": read everything, in pages of about 150k tokens with notes per page; a subagent gives only its final
report.

Kept, each as one numbered entry (#n, in log order):
- OWNER: the owner's prompts, word for word (a context summary is marked as written by Claude, not the owner);
- CLAUDE: Claude's replies;
- CALL <tool>: each tool call with its whole input;
- OUTPUT <tool>: each tool's whole output (an image is named, not copied);
- SUBAGENT: each subagent's task and its final report.
Left out: the app's own records (file history, API request copies, queue and title records) and thinking, which is
signed and mostly hidden.
"""

from __future__ import annotations

import json
from pathlib import Path

PAGE_BYTES = 600_000  # about 150k tokens at 4 bytes per token (an estimate; the owner's choice "do 1")


def find_log(logs: Path | None, session_id: str) -> Path | None:
    if logs is None or not session_id:
        return None
    return next(iter(logs.glob(f"*/{session_id}.jsonl")), None)


def _text(content) -> str:
    """A tool output as text: strings joined, an image named."""
    if isinstance(content, str):
        return content
    out = []
    for part in content or []:
        if isinstance(part, dict):
            out.append(part.get("text", "") if part.get("type") == "text" else f"[{part.get('type', 'part')}]")
    return "\n".join(out)


def _final_report(path: Path) -> str:
    last = ""
    for raw in path.open(encoding="utf-8", errors="replace"):
        try:
            e = json.loads(raw)
        except ValueError:
            continue
        if e.get("type") == "assistant":
            texts = [p.get("text", "") for p in (e.get("message") or {}).get("content") or [] if isinstance(p, dict) and p.get("type") == "text"]
            if any(t.strip() for t in texts):
                last = "\n".join(texts)
    return last


def records(log: Path) -> list[tuple[str, str, str]]:
    """(time, label, text) for each entry of the real record, in log order, then the subagents' final reports."""
    out: list[tuple[str, str, str]] = []
    tools: dict[str, str] = {}
    for raw in log.open(encoding="utf-8", errors="replace"):
        try:
            e = json.loads(raw)
        except ValueError:
            continue
        kind, at = e.get("type"), (e.get("timestamp") or "")[:19]
        if kind not in ("user", "assistant") or e.get("isSidechain"):
            continue
        content = (e.get("message") or {}).get("content")
        if isinstance(content, str):
            content = [{"type": "text", "text": content}]
        for part in content or []:
            if not isinstance(part, dict):
                continue
            t = part.get("type")
            if t == "text" and part.get("text", "").strip():
                if kind == "assistant":
                    out.append((at, "CLAUDE", part["text"]))
                elif e.get("isCompactSummary"):
                    out.append((at, "CONTEXT SUMMARY (written by Claude, not the owner)", part["text"]))
                elif part["text"].lstrip().startswith("<"):
                    continue  # hook output, reminders and slash-command records, not the owner's words
                else:
                    out.append((at, "OWNER", part["text"]))
            elif t == "image" and kind == "user":
                out.append((at, "OWNER", "[image]"))
            elif t == "tool_use":
                tools[part.get("id", "")] = part.get("name", "")
                out.append((at, f"CALL {part.get('name', '')}", json.dumps(part.get("input"), ensure_ascii=False, indent=1)))
            elif t == "tool_result":
                name = tools.get(part.get("tool_use_id", ""), "?")
                err = " (error)" if part.get("is_error") else ""
                out.append((at, f"OUTPUT {name}{err}", _text(part.get("content"))))
    sub = log.with_suffix("") / "subagents"
    for f in sorted(sub.glob("*.jsonl")) if sub.is_dir() else []:
        meta = f.with_name(f.stem + ".meta.json")
        try:
            task = json.loads(meta.read_text(encoding="utf-8")).get("description", "") if meta.exists() else ""
        except ValueError:
            task = ""
        report = _final_report(f)
        if report or task:
            out.append(("", f"SUBAGENT {f.stem}", f"Task: {task}\n\nFinal report:\n{report or '(none)'}"))
    return out


def write_pages(log: Path, folder: Path, page_bytes: int = PAGE_BYTES) -> list[dict]:
    """Writes page-NN.txt files to folder; returns [{file, first, last, bytes}] with the entry numbers each holds.

    An entry larger than a page is split across pages; nothing is cut.
    """
    folder.mkdir(parents=True, exist_ok=True)
    pages: list[dict] = []
    buf: list[str] = []
    size, first = 0, 1

    def flush(last: int) -> None:
        nonlocal buf, size
        if not buf:
            return
        name = f"page-{len(pages) + 1:02d}.txt"
        data = "".join(buf)
        (folder / name).write_text(data, encoding="utf-8")
        pages.append({"file": name, "first": first, "last": last, "bytes": len(data.encode("utf-8"))})
        buf, size = [], 0

    n = 0
    for n, (at, label, text) in enumerate(records(log), 1):
        block = f"\n#{n} {at} {label}\n{text}\n"
        b = len(block.encode("utf-8"))
        if size and size + b > page_bytes:
            flush(n - 1)
            first = n
        while b > page_bytes:  # one huge entry: split it, marked, across pages
            cut = block[: page_bytes // 4]  # characters, so a page stays under the cap even in 4-byte text
            buf.append(cut + f"\n[#{n} continues on the next page]\n")
            flush(n)
            first = n
            block = f"\n#{n} (continued)\n" + block[len(cut):]
            b = len(block.encode("utf-8"))
        buf.append(block)
        size += b
    flush(n)
    return pages
