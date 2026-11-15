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
import math
import os
import re
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from .digest import find_log, records
from .files import inside, secret
from .planfrom import STYLE
from .redact import redact

DEFAULT_URL = "http://127.0.0.1:11434"
TIMEOUT = 300  # seconds without a byte from Ollama (a cold load of a split model took 5.7 s, s2)
MODELS_SECONDS = 300  # the model list is asked again at most every 5 minutes
# the most text read from one run's files and log; the per-model budget (s4) then picks what is sent
MAX_CONTEXT_CHARS = 2_000_000

# s4 (plan 1c08f4c2) "Short system prompt, context budget per model, chunks and log trimming, keep_alive, stop on repeat"
# The short system prompt: the owner's reply style every dashboard run gets (planfrom.STYLE), plus how context is marked.
SYSTEM = STYLE + (" Context files come between <<<FILE name>>> and <<<END FILE>>> lines; answer from them, and say so "
                  "when they do not hold the answer.")
NUM_CTX = 8192  # the context window asked of Ollama (LOCAL_NUM_CTX in .env), capped by the model's own length
ANSWER_TOKENS = 1024  # tokens kept free for the answer; also the answer's cap (num_predict)
KEEP_ALIVE = "30m"  # the model stays loaded between runs (LOCAL_KEEP_ALIVE); a cold load took 5.9 s (s3)
CHUNK = 1500  # characters per context chunk, cut at a line end
TOOL_CHARS = 300  # log trimming: a tool call's input and a tool's output keep their first 300 characters
REPEAT = re.compile(r"(?s)(.{40,400}?)\1{2,}$")  # stop on repeat: one block of 40+ characters three times at the end
WORD = re.compile(r"\w{3,}")  # the same word rule as localsearch.words (imported there, it would loop)
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

    def __init__(self, env_path_of, opener=None, clock=time.monotonic, cache: Path | None = None):
        self.env_path_of, self.opener, self.clock, self.cache = env_path_of, opener, clock, cache
        self.at, self.value = -1e9, {"server": "", "models": [], "error": None}
        self.lock = threading.Lock()

    def current(self, force: bool = False) -> dict:
        with self.lock:
            if not force and self.clock() - self.at < MODELS_SECONDS:
                return self.value
            url = server_url(self.env_path_of())
            try:
                models = list_models(url, self.opener)
                scores = self._scores()
                for m in models:  # s6: the gate task set's score, kept in local_models.json by gate.py
                    if m["name"] in scores:
                        m["score"] = scores[m["name"]]
                self.value = {"server": "ollama", "models": models, "error": None}
            except Exception:
                self.value = {"server": "ollama", "models": [], "error": "no Ollama answered"}
            self.at = self.clock()
            return self.value


    def _scores(self) -> dict:
        try:
            cache = json.loads(self.cache.read_text(encoding="utf-8")) if self.cache else {}
        except (OSError, ValueError):
            return {}
        keep = ("pass", "runs", "tokensPerSec", "at")
        return {k: {f: v["score"].get(f) for f in keep} for k, v in cache.items() if isinstance(v, dict) and v.get("score")}


def _session_text(log: Path) -> str:
    """The session's record as plain lines: who said it, then the text (digest.records, the same reader as Plan from a
    session). Read only. Log trimming (s4): a tool call's input and a tool's output keep their first TOOL_CHARS
    characters; the owner's and Claude's words stay whole."""
    out = []
    for at, label, text in records(log):
        if label.startswith(("CALL ", "OUTPUT ")) and len(text) > TOOL_CHARS:
            text = text[:TOOL_CHARS] + f" [trimmed {len(text) - TOOL_CHARS:,} chars]"
        out.append(f"[{at}] {label}:\n{text}")
    return "\n\n".join(out)


def words(text: str) -> set[str]:
    return set(WORD.findall(text.lower()))


def split_chunks(text: str, size: int = CHUNK) -> list[str]:
    """Chunks of at most `size` characters, cut at a line end when one is in the chunk's second half."""
    out, i = [], 0
    while i < len(text):
        end = min(len(text), i + size)
        if end < len(text):
            nl = text.rfind("\n", i + size // 2, end)
            end = nl + 1 if nl != -1 else end
        out.append(text[i:end])
        i = end
    return out


def fit(prompt: str, pieces: list[dict], budget_chars: int) -> list[dict]:
    """The context sent within the model's budget. All of it when it fits; else the pieces are cut into chunks, each
    chunk scored by the prompt's words it holds (a rarer word counts more: log(chunks / chunks holding the word)), and
    the best chunks are kept, back in file order, with a marker where text was left out. Each piece records the
    characters sent and the chunks kept, so a cut is never silent."""
    for p in pieces:
        p["sent"], p["chunks"] = len(p["text"]), None
    if sum(len(p["text"]) for p in pieces) <= budget_chars:
        return pieces
    all_chunks = [(pi, c) for pi, p in enumerate(pieces) for c in split_chunks(p["text"])]
    sets = [words(c) for _, c in all_chunks]
    n, q = len(all_chunks), words(prompt)
    df = {w: sum(1 for s in sets if w in s) for w in q}
    score = [sum(math.log(n / df[w]) for w in q if df[w] and w in s) for s in sets]
    keep, used = set(), 0
    for k in sorted(range(n), key=lambda k: (-score[k], k)):
        size = len(all_chunks[k][1])
        if used + size <= budget_chars:
            keep.add(k)
            used += size
    for pi, p in enumerate(pieces):
        mine = [k for k in range(n) if all_chunks[k][0] == pi]
        parts, gap = [], 0
        for k in mine:
            if k in keep:
                if gap:
                    parts.append(f"[... {gap:,} chars left out ...]\n")
                    gap = 0
                parts.append(all_chunks[k][1])
            else:
                gap += len(all_chunks[k][1])
        if gap:
            parts.append(f"[... {gap:,} chars left out ...]")
        p["text"] = "".join(parts)
        p["sent"] = sum(len(all_chunks[k][1]) for k in mine if k in keep)
        p["chunks"] = f"{sum(1 for k in mine if k in keep)} of {len(mine)}"
    return pieces


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
    """Each context piece between named markers, then the prompt; a cut piece says how much was left out."""
    parts = []
    for p in pieces:
        cut = f"\n[cut: the last {p['cut']:,} of {p['chars']:,} characters were left out]" if p["cut"] else ""
        parts.append(f"<<<FILE {p['name']}>>>\n{p['text']}{cut}\n<<<END FILE>>>")
    return (("\n\n".join(parts) + "\n\n") if parts else "") + prompt


def settings(env_path: Path | None) -> dict:
    """LOCAL_NUM_CTX and LOCAL_KEEP_ALIVE from the .env, read on every run (no restart)."""
    from .config import REPO, read_env

    env = {**read_env(env_path or REPO / ".env"), **os.environ}
    try:
        num_ctx = int(env.get("LOCAL_NUM_CTX") or NUM_CTX)
    except ValueError:
        num_ctx = NUM_CTX
    return {"num_ctx": num_ctx, "keep_alive": (env.get("LOCAL_KEEP_ALIVE") or KEEP_ALIVE).strip()}


def _post(url: str, path: str, body: dict, opener, timeout: float = TIMEOUT) -> dict:
    req = urllib.request.Request(url + path, data=json.dumps(body).encode("utf-8"), method="POST",
                                 headers={"Content-Type": "application/json"})
    with opener(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


class Budgets:
    """Each model's measured numbers, kept in <data>/local_models.json with what they were measured from, so a run reads
    them instead of guessing: its context length (Ollama /api/show) and the characters per token of its last counted
    message (the first guess of the next run; the real count of each run's own message decides)."""

    def __init__(self, path: Path, opener=None):
        self.path, self.opener, self.lock = path, opener, threading.Lock()

    def _load(self) -> dict:
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def _save(self, model: str, fields: dict) -> dict:
        cache = self._load()
        cache[model] = {**(cache.get(model) or {}), **fields}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(cache, indent=1), encoding="utf-8")
        return cache[model]

    def get(self, url: str, model: str) -> dict:
        with self.lock:
            m = self._load().get(model) or {}
            if m.get("contextLength"):
                return m
            info = _post(url, "/api/show", {"model": model}, self.opener or urllib.request.urlopen, 30).get("model_info") or {}
            length = next((int(v) for k, v in info.items() if k.endswith(".context_length")), 0)
            return self._save(model, {"contextLength": length, "lengthFrom": "Ollama /api/show model_info"})

    def count(self, url: str, model: str, messages: list[dict], num_ctx: int, keep_alive: str) -> int:
        """The prompt tokens of these messages, counted by the model itself: a chat call with num_predict 1. A message
        over num_ctx is refused with its count in the error ("request (N tokens) exceeds ..."), read from there."""
        body = {"model": model, "stream": False, "keep_alive": keep_alive, "messages": messages,
                "options": {"num_predict": 1, "num_ctx": num_ctx}}
        try:
            return int(_post(url, "/api/chat", body, self.opener or urllib.request.urlopen).get("prompt_eval_count") or 0)
        except urllib.error.HTTPError as e:
            m = re.search(r"request \((\d+) tokens\)", e.read().decode("utf-8", "replace"))
            if m:
                return int(m.group(1))
            raise

    def note(self, model: str, chars: int, tokens: int) -> None:
        if chars and tokens:
            with self.lock:
                self._save(model, {"charsPerToken": round(chars / tokens, 3),
                                   "measuredFrom": f"a run's message: {chars} chars = {tokens} tokens",
                                   "at": time.strftime("%Y-%m-%d %H:%M:%S")})


def messages_of(prompt: str, pieces: list[dict]) -> list[dict]:
    return [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user_message(prompt, pieces)}]


def budget_fit(budgets: Budgets, url: str, model: str, prompt: str, pieces: list[dict], num_ctx: int,
               keep_alive: str) -> tuple[int, list[dict], int, int]:
    """(num_ctx asked of Ollama, the pieces sent, their counted prompt tokens, the counts made). The window less the
    answer's tokens is the limit; the message is cut to the characters the last measured ratio allows, counted by the
    model, and cut again in proportion while it is over (up to 5 counts). A run with no context is not counted."""
    m = budgets.get(url, model)
    ctx = min(num_ctx, m.get("contextLength") or num_ctx)
    limit = ctx - ANSWER_TOKENS
    total = sum(len(p["text"]) for p in pieces)
    if not total:
        return ctx, fit(prompt, pieces, 0), 0, 0
    chars = min(total, int(limit * m["charsPerToken"])) if m.get("charsPerToken") else total
    for n in range(1, 6):
        sent = fit(prompt, [dict(p) for p in pieces], chars)
        msgs = messages_of(prompt, sent)
        tokens = budgets.count(url, model, msgs, ctx, keep_alive)
        budgets.note(model, sum(len(x["content"]) for x in msgs), tokens)
        if tokens <= limit:
            return ctx, sent, tokens, n
        chars = int(sum(p["sent"] for p in sent) * limit / tokens * 0.95)  # 0.95: one more count lands under the limit
    raise ValueError(f"the context could not be cut under {limit} tokens in 5 counts (last {tokens})")


def _line(f, obj: dict) -> None:
    f.write(json.dumps(obj, ensure_ascii=False) + "\n")
    f.flush()


class LocalRun:
    """A local prompt in a thread, standing in for a run's process (poll, returncode, pid, kill), like search.SearchRun:
    runs.py follows it and finishes it from the result line in the .out."""

    pid = 0

    def __init__(self, cid: str, url: str, model: str, prompt: str, pieces: list[dict], out: Path, budgets: Budgets,
                 num_ctx: int = NUM_CTX, keep_alive: str = KEEP_ALIVE, opener=None):
        self.cid, self.url, self.model, self.prompt, self.pieces, self.out = cid, url, model, prompt, pieces, out
        self.budgets, self.num_ctx, self.keep_alive = budgets, num_ctx, keep_alive
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
        text, first_ms, err, last, repeated, ctx, sent, counts = [], None, "", {}, "", None, [], 0
        with open(self.out, "w", encoding="utf-8") as f:
            _line(f, {"type": "system", "subtype": "init", "engine": "ollama", "model": self.model})
            _line(f, {"type": "stream_event", "event": {"type": "message_start"}})
            try:
                ctx, pieces, counted, counts = budget_fit(self.budgets, self.url, self.model, self.prompt, self.pieces,
                                                          self.num_ctx, self.keep_alive)
                sent = [{"name": p["name"], "chars": p["chars"], "sent": p["sent"], "chunks": p["chunks"]} for p in pieces]
                body = {"model": self.model, "stream": True, "keep_alive": self.keep_alive,
                        "options": {"num_ctx": ctx, "num_predict": ANSWER_TOKENS},
                        "messages": messages_of(self.prompt, pieces)}
                req = urllib.request.Request(self.url + "/api/chat", data=json.dumps(body).encode("utf-8"),
                                             method="POST", headers={"Content-Type": "application/json"})
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
                        if t and len(text) % 8 == 0:  # stop on repeat, checked every 8 pieces on the answer's end
                            if REPEAT.search("".join(text)[-2000:]):
                                repeated = "yes"
                                break
            except urllib.error.HTTPError as e:
                try:
                    msg = json.loads(e.read().decode("utf-8", "replace")).get("error") or e.reason
                except Exception:
                    msg = e.reason
                err = f"Ollama said {e.code}: {msg}"
            except ValueError as e:  # the budget could not fit the context
                err = f"Context too long for {self.model}: {e}"
            except Exception as e:  # no server, timeout
                err = f"Ollama not reached at {self.url}: {e}"
            answer = "".join(text)
            if repeated:  # keep the block once, drop its repeats, and say so
                m = REPEAT.search(answer[-2000:])
                if m:
                    answer = answer[:len(answer) - len(m.group(0)) + len(m.group(1))]
                answer += "\n\n[stopped: the answer repeated itself]"
            answer = answer.strip()
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
                      "tokensPerSec": round(out_tokens / (gen_ns / 1e9), 2) if gen_ns else None,
                      "stoppedOnRepeat": bool(repeated), "numCtx": ctx, "context": sent, "budgetCounts": counts})
        self.returncode = 1 if is_error else 0
