"""Full texts from this PC, sent to the page on request and never stored (the owner's words, 2026-11-08: "do option 3,
the dashboard only load the file stored on the PC and check if can clean up the storage on firstore or not if not then
ignore it. make sure the result is captured fully inside my PC so the file render completed result from each message
turn").

Two sources, both already written in full on the PC:
- a session's log, <logs>/<project>/<session>.jsonl, written by Claude Code itself: every turn's final reply, whole;
- a run's .out file, written by the bridge from `claude -p` (runs.STREAM): the run's whole result.

{"live": run id} is the running turn (step i3, the owner's choice, 2026-11-12: "Token stream"): the text claude has
streamed so far into the .out, with one line per tool it called, read from the PC on each ask and never stored. The
page asks every 2 s while the run is running; no Firestore write.

The page asks POST /text on the file viewer (files.py) with {"session": id, "turn": n} (no turn: the last one),
{"run": id}, or {"reply": {"session": id, "item": inbox item id, "k": n}} for the n-th (from 0) inbox_reply the session
made on that item, read from its inbox_reply tool call in the log (the owner's choice, 2026-11-08: "From the PC too").
Secrets are replaced as everywhere else (redact), with no length cap.
"""

from __future__ import annotations

import json
from pathlib import Path

from .redact import redact
from .runs import parse_result

NO_CAP = 1 << 30
PROMPT_PREVIEW = 160
NL, BR = chr(10), chr(10) * 2  # a line end; a blank line between a turn's steps
LIVE_TAIL = 8000  # the live view shows the last 8,000 chars; the whole result comes from {"run"} once it ends


def live_of(out: str) -> dict:
    """The running turn from a stream .out: the streamed text, a "- tool: <name>" line per tool call, whether claude
    has started and whether its result is in. A subagent's events (parent_tool_use_id) are left out. A line still
    being written (no newline yet, not JSON) is skipped and read on the next ask."""
    parts: list[str] = []
    started = done = False
    tools = 0
    for line in out.splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if not isinstance(e, dict) or e.get("parent_tool_use_id"):
            continue
        t = e.get("type")
        if t == "system" and e.get("subtype") == "init":
            started = True
        elif t == "result":
            done = True
        elif t == "stream_event":
            ev = e.get("event") or {}
            if ev.get("type") == "content_block_start" and (ev.get("content_block") or {}).get("type") == "tool_use":
                tools += 1
                parts.append(f"{BR}- tool: {ev['content_block'].get('name', '?')}{BR}")
            elif ev.get("type") == "content_block_delta" and (ev.get("delta") or {}).get("type") == "text_delta":
                parts.append(ev["delta"].get("text", ""))
            elif ev.get("type") == "message_start" and parts and not parts[-1].endswith(NL):
                parts.append(BR)
    text = "".join(parts).strip()
    return {"text": text[-LIVE_TAIL:], "chars": len(text), "cut": len(text) > LIVE_TAIL, "tools": tools,
            "started": started, "done": done}


def _text_of(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def turns_of(path: Path, prompt_chars: int = PROMPT_PREVIEW) -> list[dict]:
    """The turns of one log: each starts at a line the owner (or a dashboard message) typed and ends with the last
    assistant text before the next one. A response streams as several lines with one message id: the last line of an
    id holds its whole text, so the turn's reply is the last id's last line."""
    turns: list[dict] = []
    with open(path, "rb") as f:
        for raw in f:
            try:
                d = json.loads(raw)
            except (ValueError, UnicodeDecodeError):
                continue
            kind = d.get("type")
            m = d.get("message") or {}
            if kind == "user" and not d.get("isMeta"):
                text = _text_of(m.get("content"))
                if text.strip():
                    turns.append({"n": len(turns) + 1, "at": d.get("timestamp") or "", "prompt": text.strip(), "_ids": {}})
            elif kind == "assistant" and turns and m.get("model") != "<synthetic>":
                text = _text_of(m.get("content"))
                if text.strip():
                    ids = turns[-1]["_ids"]
                    mid = m.get("id") or f"line{len(ids)}"
                    ids.pop(mid, None)
                    ids[mid] = text  # the newest line of this id, in arrival order
                    turns[-1]["at"] = d.get("timestamp") or turns[-1]["at"]
    out = []
    for t in turns:
        text = next(reversed(t["_ids"].values()), "") if t["_ids"] else ""
        out.append({"n": t["n"], "at": t["at"], "prompt": redact(t["prompt"], prompt_chars), "text": redact(text, NO_CAP)})
    return out


def replies_of(path: Path, item_id: str) -> list[str]:
    """The texts of the session's inbox_reply calls on one inbox item, in order, from its log."""
    out = []
    with open(path, "rb") as f:
        for raw in f:
            try:
                d = json.loads(raw)
            except (ValueError, UnicodeDecodeError):
                continue
            if d.get("type") != "assistant":
                continue
            for b in (d.get("message") or {}).get("content") or []:
                if isinstance(b, dict) and b.get("type") == "tool_use" and str(b.get("name", "")).endswith("inbox_reply"):
                    inp = b.get("input") or {}
                    if inp.get("item_id") == item_id and b.get("id") not in [x[0] for x in out]:
                        out.append((b.get("id"), str(inp.get("text", ""))))
    return [t for _, t in out]


class Texts:
    def __init__(self, logs: Path | None, out_dir: Path | None, local=None):
        self.logs, self.out_dir = logs, out_dir
        self.local = local  # localsearch.LocalSearch (step i6), or None

    def log_of(self, session_id: str) -> Path | None:
        if not self.logs or not self.logs.is_dir() or not session_id or "/" in session_id or "\\" in session_id:
            return None
        files = list(self.logs.glob(f"*/{session_id}.jsonl"))
        return max(files, key=lambda p: p.stat().st_size) if files else None

    def session(self, session_id: str, turn: int | None) -> dict:
        path = self.log_of(session_id)
        if path is None:
            raise ValueError("no log for this session on this PC")
        turns = turns_of(path)
        if not turns:
            raise ValueError("no turn in this session's log yet")
        n = turn if turn and 1 <= turn <= len(turns) else len(turns)
        t = turns[n - 1]
        return {"n": n, "at": t["at"], "prompt": t["prompt"], "text": t["text"], "chars": len(t["text"]),
                "turns": [{"n": x["n"], "at": x["at"], "prompt": x["prompt"], "chars": len(x["text"])} for x in turns]}

    def run(self, run_id: str) -> dict:
        if not self.out_dir or not run_id or not run_id.isalnum():
            raise ValueError("no record of this run on this PC")
        path = self.out_dir / f"{run_id}.out"
        if not path.is_file():
            raise ValueError("no record of this run on this PC")
        r = parse_result(path.read_text(encoding="utf-8", errors="replace"))
        text = redact(str(r.get("result") or ""), NO_CAP)
        return {"text": text, "chars": len(text), "isError": bool(r.get("is_error"))}

    def live(self, run_id: str) -> dict:
        if not self.out_dir or not run_id or not run_id.isalnum():
            raise ValueError("no record of this run on this PC")
        path = self.out_dir / f"{run_id}.out"
        if not path.is_file():
            return {"text": "", "chars": 0, "cut": False, "tools": 0, "started": False, "done": False}
        r = live_of(path.read_text(encoding="utf-8", errors="replace"))
        r["text"] = redact(r["text"], NO_CAP)
        return r

    def reply(self, session_id: str, item_id: str, k: int) -> dict:
        path = self.log_of(session_id)
        if path is None:
            raise ValueError("no log for this session on this PC")
        texts = replies_of(path, str(item_id))
        if not 0 <= k < len(texts):
            raise ValueError("no such reply in this session's log")
        text = redact(texts[k], NO_CAP)
        return {"text": text, "chars": len(text), "k": k, "of": len(texts)}

    def answer(self, body: dict) -> dict:
        if isinstance(body.get("reply"), dict):
            r = body["reply"]
            k = r.get("k", 0)
            return self.reply(str(r.get("session", "")), str(r.get("item", "")), int(k) if isinstance(k, (int, float)) else 0)
        if body.get("session"):
            turn = body.get("turn")
            return self.session(str(body["session"]), int(turn) if isinstance(turn, (int, float)) else None)
        if body.get("live"):
            return self.live(str(body["live"]))
        if "search" in body or "digest" in body:  # step i6: local search and the daily digest (localsearch.py)
            if self.local is None:
                raise ValueError("local search is off on this PC")
            try:
                if "search" in body:
                    return self.local.search(str(body["search"]))
                return self.local.digest(str(body["digest"]))
            except OSError:
                raise ValueError("Ollama does not answer on this PC: is it running?") from None
        if body.get("run"):
            return self.run(str(body["run"]))
        raise ValueError("ask for a session or a run")
