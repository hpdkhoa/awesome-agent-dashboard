"""Reads Claude Code's own session logs, read-only.

Layout on disk: <logs>/<project>/<session>.jsonl, and that session's subagents in
<logs>/<project>/<session>/subagents/*.jsonl (their tokens count to the session).

Facts the parsing rests on (checked on the owner's logs, 2026-11-01):
- One API response is written as several "assistant" lines with the same message.id; output_tokens grows from line to
  line while the response streams, so a message counts once, with the largest value of each token field.
- A resumed session's file repeats messages of the session it continued, and those lines keep the old session's
  sessionId, so a message.id is counted once: in the session its line names, else the earliest session holding it.
- A prompt the person typed is a "user" line whose origin.kind is "human".
- "custom-title" lines carry the session title.
- Messages with model "<synthetic>" are written by Claude Code itself, not by a model, and carry no tokens: skipped.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from .redact import redact


@dataclass
class FileState:
    """Everything one log file has said so far, built by reading it from offset 0 or from where the last read stopped."""

    offset: int = 0
    msgs: dict[str, list] = field(default_factory=dict)  # message.id -> [day, model, sessionId, in, out, w5, w1h, read]
    first_ts: str = ""
    last_ts: str = ""
    cwd: str = ""
    title: str = ""
    first_prompt: str = ""
    last_prompt: str = ""
    last_reply: str = ""
    prompts: int = 0
    remote_id: str = ""  # the Remote Control session id ("cse_..."), the newest one the log names

    def to_json(self) -> dict:
        return self.__dict__.copy()

    @classmethod
    def from_json(cls, d: dict) -> FileState:
        return cls(**d)


def local_day(ts: str) -> str:
    """The machine's local calendar day of an ISO timestamp, so daily spend matches the owner's day."""
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone().strftime("%Y-%m-%d")


def _text_of(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def is_prompt(d: dict) -> bool:
    """A user line the owner wrote: typed in the app or a terminal (origin human), or sent by the bridge through
    `claude -p` (entrypoint sdk-*, a promptId). A dashboard message is a prompt too (the owner's words, 2026-11-10:
    "Count -p prompts as prompts"). Tool results have no text and never count."""
    if (d.get("origin") or {}).get("kind") == "human":
        return True
    return bool(d.get("promptId")) or str(d.get("entrypoint") or "").startswith("sdk")


def read_lines(path: Path, st: FileState) -> FileState:
    """Reads the complete lines after st.offset and folds them into st. A half-written last line is left for next time."""
    with open(path, "rb") as f:
        f.seek(st.offset)
        data = f.read()
    end = data.rfind(b"\n")
    if end < 0:
        return st
    for raw in data[: end + 1].splitlines():
        try:
            d = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            continue
        _fold(d, st)
    st.offset += end + 1
    return st


def _fold(d: dict, st: FileState) -> None:
    ts = d.get("timestamp") or ""
    if ts:
        st.first_ts = min(st.first_ts or ts, ts)
        st.last_ts = max(st.last_ts, ts)
    if not st.cwd and d.get("cwd"):
        st.cwd = d["cwd"]
    if d.get("bridgeSessionId"):
        st.remote_id = d["bridgeSessionId"]
    kind = d.get("type")
    if kind == "custom-title" and d.get("customTitle"):
        st.title = redact(d["customTitle"], 120)
    elif kind == "user" and not d.get("isMeta") and is_prompt(d):
        text = _text_of((d.get("message") or {}).get("content"))
        if text.strip():
            st.prompts += 1
            st.last_prompt = redact(text, 1500)
            if not st.first_prompt:
                st.first_prompt = redact(text, 1500)
    elif kind == "assistant":
        m = d.get("message") or {}
        u = m.get("usage") or {}
        mid = m.get("id")
        if mid and u and ts and m.get("model") != "<synthetic>":
            cc = u.get("cache_creation") or {}
            w5 = cc.get("ephemeral_5m_input_tokens")
            w1h = cc.get("ephemeral_1h_input_tokens")
            if w5 is None and w1h is None:
                w5, w1h = u.get("cache_creation_input_tokens", 0), 0
            new = [
                local_day(ts),
                m.get("model") or "unknown",
                d.get("sessionId") or "",
                u.get("input_tokens", 0) or 0,
                u.get("output_tokens", 0) or 0,
                w5 or 0,
                w1h or 0,
                u.get("cache_read_input_tokens", 0) or 0,
            ]
            old = st.msgs.get(mid)
            st.msgs[mid] = new if old is None else old[:3] + [max(a, b) for a, b in zip(old[3:], new[3:])]
        # the reply itself is not kept: the page reads any turn's whole text from the log through texts.py (the
        # owner's choice, 2026-11-08: "the dashboard only load the file stored on the PC"); last_reply stays "" so an
        # older saved state still loads


def session_files(logs: Path, max_age_days: float | None = None) -> dict[str, list[Path]]:
    """session id -> its log files (the main file first, then its subagents), for sessions touched within max_age_days."""
    out: dict[str, list[Path]] = {}
    now = datetime.now().timestamp()
    for project in sorted(p for p in logs.iterdir() if p.is_dir()):
        for main in sorted(project.glob("*.jsonl")):
            sid = main.stem
            files = [main] + sorted((project / sid / "subagents").glob("*.jsonl"))
            newest = max(os.path.getmtime(f) for f in files)
            if max_age_days is None or now - newest <= max_age_days * 86400:
                out[sid] = files
    return out
