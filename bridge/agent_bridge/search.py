"""The search command (plan c5cb9485 s9): a fast question answered by Gemini Flash with Google Search, run by the bridge
and kept as a run like any other.

The owner's words (2026-11-14): "if I want fast ask and short time to first token then claude or gemini is better for
fast search? if gemini is faster can we add gemini into a search box?"; then "I want to add this search step";
"Search box go to both send box and dashboard and count as a run"; "No need to measure just implement and I'll use the
config node to add the key and test search feature."

commands/<id> with action "search" (machine, prompt) comes from the avatar's SEND box (SEARCH) or the dashboard's
search box. The bridge calls Gemini's streamGenerateContent (SSE) with the google_search tool and writes the answer into
<id>.out in the same stream-json lines `claude -p` writes (runs.STREAM), so the page's Live and Result views and the
avatar's reply head read it with no new reader (texts.live_of, runs.parse_result). The command record gets the source
links and the first-token time; the answer text stays on this PC (the 2026-11-08 rule: the page reads it from the PC).

The key: GEMINI_API_KEY from the bridge's .env, read again on every search, so a key added later (s10, the Config
node) works with no restart. It goes to Google in the x-goog-api-key header only: never in a URL, the run record,
the .out, a log line or Firestore; any error text is redacted before it is stored. The question is sent to Google.
"""

from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from .redact import redact

KEY_NAME = "GEMINI_API_KEY"
DEFAULT_MODEL = "gemini-flash-latest"  # Google's alias for the newest Flash; GEMINI_MODEL in .env overrides it
API = "https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse"
NO_KEY = "No Gemini key: set GEMINI_API_KEY in Config (avatar node 5) on this box."
TIMEOUT = 60  # seconds without a byte from Google
MAX_SOURCES = 8


def settings(env_path: Path | None) -> tuple[str, str]:
    """(key, model) from the .env, read now (no restart after a new key); the process environment wins, as in Config."""
    from .config import REPO, read_env

    env = {**read_env(env_path or REPO / ".env"), **os.environ}
    return env.get(KEY_NAME, "").strip(), (env.get("GEMINI_MODEL") or DEFAULT_MODEL).strip()


def sse_events(lines):
    """The JSON objects of an SSE stream ("data: {...}" lines)."""
    for raw in lines:
        line = raw.decode("utf-8", "replace").strip() if isinstance(raw, bytes) else str(raw).strip()
        if not line.startswith("data:"):
            continue
        try:
            yield json.loads(line[5:].strip())
        except ValueError:
            continue


def chunk_text(ev: dict) -> str:
    c = (ev.get("candidates") or [{}])[0]
    return "".join(p.get("text", "") for p in ((c.get("content") or {}).get("parts") or []) if not p.get("thought"))


def chunk_sources(ev: dict) -> list[dict]:
    c = (ev.get("candidates") or [{}])[0]
    out = []
    for g in ((c.get("groundingMetadata") or {}).get("groundingChunks") or []):
        w = g.get("web") or {}
        if w.get("uri"):
            out.append({"title": str(w.get("title") or w["uri"])[:120], "url": str(w["uri"])[:600]})
    return out


def api_error(e: urllib.error.HTTPError) -> str:
    try:
        body = json.loads(e.read().decode("utf-8", "replace"))
        msg = (body.get("error") or {}).get("message") or str(body)[:300]
    except Exception:
        msg = e.reason or ""
    return f"Gemini said {e.code}: {msg}"


def _line(f, obj: dict) -> None:
    f.write(json.dumps(obj, ensure_ascii=False) + "\n")
    f.flush()


class SearchRun:
    """A search in a thread, standing in for a run's process (poll, returncode, pid, kill): runs.py follows it and
    finishes it like a claude run (_finish reads the result line in the .out, with the first-token time and the
    sources)."""

    pid = 0

    def __init__(self, cid: str, prompt: str, out: Path, key: str, model: str, opener=None):
        self.cid, self.prompt, self.out, self.key, self.model, self.opener = cid, prompt, out, key, model, opener or urllib.request.urlopen
        self.returncode: int | None = None
        self.stopped = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True, name=f"search-{cid}")
        self.thread.start()

    def poll(self):
        return self.returncode

    def kill(self) -> None:
        self.stopped.set()

    def _run(self) -> None:
        t0 = time.monotonic()
        text, sources, first_ms, err = [], [], None, ""
        with open(self.out, "w", encoding="utf-8") as f:
            _line(f, {"type": "system", "subtype": "init", "engine": "gemini", "model": self.model})
            _line(f, {"type": "stream_event", "event": {"type": "message_start"}})
            body = {"contents": [{"role": "user", "parts": [{"text": self.prompt}]}], "tools": [{"google_search": {}}]}
            req = urllib.request.Request(API.format(model=self.model), data=json.dumps(body).encode("utf-8"), method="POST",
                                         headers={"Content-Type": "application/json", "x-goog-api-key": self.key})
            try:
                with self.opener(req, timeout=TIMEOUT) as resp:
                    for ev in sse_events(resp):
                        if self.stopped.is_set():
                            err = "Stopped on the page."
                            break
                        t = chunk_text(ev)
                        if t:
                            if first_ms is None:
                                first_ms = round((time.monotonic() - t0) * 1000)
                            text.append(t)
                            _line(f, {"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": t}}})
                        for s in chunk_sources(ev):
                            if s["url"] not in {x["url"] for x in sources} and len(sources) < MAX_SOURCES:
                                sources.append(s)
            except urllib.error.HTTPError as e:
                err = api_error(e)
            except Exception as e:  # network, timeout
                err = f"Gemini not reached: {e}"
            answer = "".join(text).strip()
            if sources:
                answer += "\n\nSources:\n" + "\n".join(f"- [{s['title']}]({s['url']})" for s in sources)
            total_ms = round((time.monotonic() - t0) * 1000)
            is_error = bool(err) or not "".join(text).strip()
            err = err or ("" if not is_error else "Gemini sent no text.")
            _line(f, {"type": "result", "subtype": "error" if is_error else "success", "is_error": is_error,
                      "result": redact(err, 800) if is_error else answer, "duration_ms": total_ms, "engine": "gemini",
                      "model": self.model, "firstTokenMs": first_ms, "sources": sources})
        # the record gets these from the result line in runs._finish (one writer: the bridge loop, never this thread)
        self.returncode = 1 if is_error else 0
