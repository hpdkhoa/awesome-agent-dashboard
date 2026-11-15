"""The local command (plan 1c08f4c2 s3, stage 1): a prompt to a local model on this machine's Ollama, with picked
files or a session log as context, run by the bridge and kept as a run like any other. Not Claude Code.

The owner's words (2026-11-10): "No local model just need to work as best for local model and it run through bridge to
start its own command, not through Claude Code"; "First try with Ollama then come to vLLM." Plan choices: "Prompt first,
agent later" (stage 1: prompt in, answer out, no tools); "Both, picked per run" (the command names the machine, and that
machine's bridge calls its own Ollama); "WORK_ROOTS incl. session logs" (read only, never used for training).

commands/<id> with action "local": machine, model (one of this machine's Ollama models), prompt, and optionally files
(paths, each inside WORK_ROOTS and not a secret file) and sessionId (a Claude Code session whose log is read as
context). One file outside WORK_ROOTS, a secret file, a missing file or an unknown session refuses the whole run before
any call: nothing is sent. The bridge calls Ollama's /api/chat (streamed) and writes the answer into <id>.out in the
same stream-json lines `claude -p` writes (runs.STREAM), so the page's Live and Result views read it with no new reader.

Terms (s1): the runner never reads or passes a Claude sign-in or token; it calls only the Ollama HTTP API.
OLLAMA_URL in the bridge's .env (default http://127.0.0.1:11434) names the server, read again on every run.
"""

from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from .digest import find_log, records
from .files import inside, secret
from .redact import redact

DEFAULT_URL = "http://127.0.0.1:11434"
TIMEOUT = 300  # seconds without a byte from Ollama (a cold load of a split model took 5.7 s, s2)
MODELS_SECONDS = 300  # the model list is asked again at most every 5 minutes
# stage 1 bound on the context text sent (s4 sets the per-model context budget): a file or log past it is cut at its
# end and the cut is named in the prompt and on the run, never silent
MAX_CONTEXT_CHARS = 60_000
NO_SERVER = "No Ollama answered at {url} on this machine. Start Ollama, or set OLLAMA_URL in the bridge .env."


def server_url(env_path: Path | None) -> str:
    """OLLAMA_URL from the .env, read now (no restart); the process environment wins, as for the search key."""
    from .config import REPO, read_env

    env = {**read_env(env_path or REPO / ".env"), **os.environ}
    return (env.get("OLLAMA_URL") or DEFAULT_URL).strip().rstrip("/")


def list_models(url: str, opener=None, timeout: float = 3) -> list[dict]:
    """This machine's Ollama models: [{"name", "sizeBytes", "params", "quant"}], from /api/tags. Raises when no server."""
    opener = opener or urllib.request.urlopen
    with opener(urllib.request.Request(url + "/api/tags"), timeout=timeout) as r:
        tags = json.loads(r.read().decode("utf-8", "replace"))
    out = []
    for m in tags.get("models") or []:
        d = m.get("details") or {}
        if "embed" in (d.get("family") or "") or "bert" in (d.get("family") or ""):
            continue  # an embedding model (nomic-embed-text) cannot chat
        out.append({"name": m.get("name") or m.get("model"), "sizeBytes": m.get("size"),
                    "params": d.get("parameter_size") or "", "quant": d.get("quantization_level") or ""})
    return sorted(out, key=lambda x: x["name"] or "")


class LocalModels:
    """The model list a bridge publishes on machines/<machine> (s3: "models listed per machine"), cached 5 minutes."""

    def __init__(self, env_path_of, opener=None, clock=time.monotonic):
        self.env_path_of, self.opener, self.clock = env_path_of, opener, clock
        self.at, self.value = -1e9, {"server": "", "models": [], "error": None}
        self.lock = threading.Lock()

    def current(self, force: bool = False) -> dict:
        with self.lock:
            if not force and self.clock() - self.at < MODELS_SECONDS:
                return self.value
            url = server_url(self.env_path_of())
            try:
                self.value = {"server": "ollama", "models": list_models(url, self.opener), "error": None}
            except Exception:
                self.value = {"server": "ollama", "models": [], "error": "no Ollama answered"}
            self.at = self.clock()
            return self.value


def _session_text(log: Path) -> str:
    """The session's record as plain lines: who said it, then the text (digest.records, the same reader as Plan from a
    session). Read only."""
    return "\n\n".join(f"[{at}] {label}:\n{text}" for at, label, text in records(log))


def gather(files: list[str], session_id: str, roots: list[tuple[str, str]], logs: Path | None) -> tuple[list[dict], str]:
    """The context pieces [{"name", "text", "chars", "cut"}] or ("", why) when one is refused. Every check runs
    before anything is read: a refused run reads and sends nothing."""
    paths = []
    for f in files:
        full = os.path.realpath(str(f))
        if not os.path.isabs(str(f)):
            return [], f"{f}: not a full path"
        if not any(inside(full, r) for _, r in roots if r):
            return [], f"{f}: outside WORK_ROOTS"
        if secret(full):
            return [], f"{f}: a secret file is never sent"
        if not os.path.isfile(full):
            return [], f"{f}: no such file"
        paths.append(full)
    log = None
    if session_id:
        log = find_log(logs, session_id)
        if log is None:
            return [], f"session {session_id}: no log on this machine"
    pieces = [{"name": p, "text": Path(p).read_text(encoding="utf-8", errors="replace")} for p in paths]
    if log is not None:
        pieces.append({"name": f"session log {session_id}", "text": _session_text(log)})
    left = MAX_CONTEXT_CHARS
    for p in pieces:
        p["chars"] = len(p["text"])
        p["cut"] = max(0, p["chars"] - left)
        p["text"] = p["text"][:left]
        left -= len(p["text"])
    return pieces, ""


def user_message(prompt: str, pieces: list[dict]) -> str:
    """The prompt, then each context piece between named markers; a cut piece says how much was left out."""
    parts = []
    for p in pieces:
        cut = f"\n[cut: the last {p['cut']:,} of {p['chars']:,} characters were left out]" if p["cut"] else ""
        parts.append(f"<<<FILE {p['name']}>>>\n{p['text']}{cut}\n<<<END FILE>>>")
    return (("\n\n".join(parts) + "\n\n") if parts else "") + prompt


def _line(f, obj: dict) -> None:
    f.write(json.dumps(obj, ensure_ascii=False) + "\n")
    f.flush()


class LocalRun:
    """A local prompt in a thread, standing in for a run's process (poll, returncode, pid, kill), like search.SearchRun:
    runs.py follows it and finishes it from the result line in the .out."""

    pid = 0

    def __init__(self, cid: str, url: str, model: str, message: str, out: Path, opener=None):
        self.cid, self.url, self.model, self.message, self.out = cid, url, model, message, out
        self.opener = opener or urllib.request.urlopen
        self.returncode: int | None = None
        self.stopped = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True, name=f"local-{cid}")
        self.thread.start()

    def poll(self):
        return self.returncode

    def kill(self) -> None:
        self.stopped.set()

    def _run(self) -> None:
        t0 = time.monotonic()
        text, first_ms, err, last = [], None, "", {}
        with open(self.out, "w", encoding="utf-8") as f:
            _line(f, {"type": "system", "subtype": "init", "engine": "ollama", "model": self.model})
            _line(f, {"type": "stream_event", "event": {"type": "message_start"}})
            body = {"model": self.model, "stream": True, "messages": [{"role": "user", "content": self.message}]}
            req = urllib.request.Request(self.url + "/api/chat", data=json.dumps(body).encode("utf-8"), method="POST",
                                         headers={"Content-Type": "application/json"})
            try:
                with self.opener(req, timeout=TIMEOUT) as resp:
                    for raw in resp:
                        if self.stopped.is_set():
                            err = "Stopped on the page."
                            break
                        try:
                            ev = json.loads(raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw)
                        except ValueError:
                            continue
                        if ev.get("error"):
                            err = f"Ollama said: {ev['error']}"
                            break
                        t = (ev.get("message") or {}).get("content") or ""
                        if t:
                            if first_ms is None:
                                first_ms = round((time.monotonic() - t0) * 1000)
                            text.append(t)
                            _line(f, {"type": "stream_event", "event": {"type": "content_block_delta",
                                                                        "delta": {"type": "text_delta", "text": t}}})
                        if ev.get("done"):
                            last = ev
                            break
            except urllib.error.HTTPError as e:
                try:
                    msg = json.loads(e.read().decode("utf-8", "replace")).get("error") or e.reason
                except Exception:
                    msg = e.reason
                err = f"Ollama said {e.code}: {msg}"
            except Exception as e:  # no server, timeout
                err = f"Ollama not reached at {self.url}: {e}"
            answer = "".join(text).strip()
            is_error = bool(err) or not answer
            err = err or ("" if not is_error else "Ollama sent no text.")
            ns = lambda k: last.get(k) or 0
            out_tokens, gen_ns = ns("eval_count"), ns("eval_duration")
            _line(f, {"type": "result", "subtype": "error" if is_error else "success", "is_error": is_error,
                      "result": redact(err, 800) if is_error else answer, "engine": "ollama", "model": self.model,
                      "duration_ms": round((time.monotonic() - t0) * 1000), "firstTokenMs": first_ms,
                      "loadMs": round(ns("load_duration") / 1e6) if last else None,
                      "promptTokens": ns("prompt_eval_count") if last else None,
                      "outputTokens": out_tokens if last else None,
                      "tokensPerSec": round(out_tokens / (gen_ns / 1e9), 2) if gen_ns else None})
        self.returncode = 1 if is_error else 0
