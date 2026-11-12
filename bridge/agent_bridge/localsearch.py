"""Local search and daily digest over the session logs on this PC (step i6; the plan: "Ollama index of session logs;
search box; daily digest"; the owner's choice, 2026-11-12: "Ollama on this PC").

Nothing goes to Firestore or to Claude. Ollama runs on this PC (127.0.0.1:11434, OLLAMA_URL to change it):
- the index: every prompt of every session log (texts.turns_of), whole, cut in CHUNK-char pieces that overlap by
  OVERLAP, each embedded with EMBED_MODEL, kept in <data>/search/index.json; a session is embedded again only when its
  log changed (size or time). Measured 2026-11-12: 3,680 prompts, median 249 chars, 366 over 2,000, the longest 436,215.
- search: two rankings of the sessions, each by its best piece: meaning (cosine of the embedded query) and words (the
  share of the query's words the piece holds); fused by reciprocal rank (1/(60 + rank), the usual constant), so neither
  needs a hand-set weight. The first build (meaning only, prompts cut at 2,000 chars) put the right session first for
  2 of 10 known prompts.
- the digest: for one local day, each session active that day goes to DIGEST_MODEL with its prompts of that day; the
  answer is kept in <data>/search/digest-<day>.md. The bridge writes yesterday's digest once a day.
The page asks the file viewer (files.py) POST /text with {"search": text} or {"digest": "YYYY-MM-DD"}.
"""

from __future__ import annotations

import json
import math
import os
import re
import threading
import time
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

from .texts import NO_CAP, turns_of

OLLAMA = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
EMBED_MODEL = "nomic-embed-text"
DIGEST_MODEL = "qwen3:4b-instruct"  # the plain qwen3:4b tag thinks aloud into the answer (seen 2026-11-12)
PROMPT_CHARS = 2000  # the longest query taken
CHUNK, OVERLAP = 1500, 200  # nomic-embed-text reads 2,048 tokens; 1,500 chars stays well inside
BATCH = 32
TOP = 10
RRF = 60
WORD = re.compile(r"\w{3,}")


def words(text: str) -> set[str]:
    return set(WORD.findall(text.lower()))


def chunks(text: str) -> list[str]:
    return [text[i:i + CHUNK] for i in range(0, max(len(text) - OVERLAP, 1), CHUNK - OVERLAP)]


def _post(path: str, body: dict, timeout: float = 600) -> dict:
    req = urllib.request.Request(OLLAMA + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def embed(texts: list[str], post=_post) -> list[list[float]]:
    # nomic-embed-text wants a task prefix: documents and queries are embedded with their own
    return post("/api/embed", {"model": EMBED_MODEL, "input": texts})["embeddings"]


def _unit(v: list[float]) -> list[float]:
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [round(x / n, 6) for x in v]


def _dot(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


def _local_day(ts: str) -> str:
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone().strftime("%Y-%m-%d")
    except ValueError:
        return ""


class LocalSearch:
    def __init__(self, logs: Path | None, folder: Path, post=_post):
        self.logs, self.folder, self.post = logs, folder, post
        self.folder.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.index: dict[str, dict] = self._load()
        self.words: dict[str, list[set[str]]] = {sid: [words(t["c"]) for t in s["turns"]] for sid, s in self.index.items()}

    # -- the index --------------------------------------------------------------------------------------------------
    def _load(self) -> dict:
        try:
            d = json.loads((self.folder / "index.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return d if all("c" in t for s in d.values() for t in s["turns"]) else {}  # an index from before the pieces

    def _save(self) -> None:
        side = self.folder / "index.json.new"
        side.write_text(json.dumps(self.index), encoding="utf-8")
        side.replace(self.folder / "index.json")

    def refresh(self) -> dict:
        """Embeds the sessions whose log changed. {"sessions", "embedded", "prompts", "pieces", "seconds"}."""
        t, done, prompts, npieces = time.time(), 0, 0, 0
        files = {p.stem: p for p in self.logs.glob("*/*.jsonl")} if self.logs and self.logs.is_dir() else {}
        for sid, path in sorted(files.items(), key=lambda kv: kv[1].stat().st_mtime):
            st = path.stat()
            old = self.index.get(sid)
            if old and old.get("size") == st.st_size and old.get("mtime") == int(st.st_mtime):
                continue
            turns = [x for x in turns_of(path, NO_CAP) if x["prompt"].strip()]
            pieces = [{"n": x["n"], "at": x["at"], "c": c} for x in turns for c in chunks(x["prompt"])]
            vecs: list[list[float]] = []
            for i in range(0, len(pieces), BATCH):
                vecs += [_unit(v) for v in embed(["search_document: " + x["c"] for x in pieces[i:i + BATCH]], self.post)]
            with self.lock:
                self.index[sid] = {"cwd": path.parent.name, "size": st.st_size, "mtime": int(st.st_mtime),
                                   "prompts": len(turns), "turns": [{**x, "v": v} for x, v in zip(pieces, vecs)]}
                self.words[sid] = [words(x["c"]) for x in pieces]
                if done % 10 == 9:  # the file is tens of MB: written every 10 sessions and at the end
                    self._save()
            done, prompts, npieces = done + 1, prompts + len(turns), npieces + len(pieces)
        with self.lock:
            for gone in set(self.index) - set(files):
                del self.index[gone]
                self.words.pop(gone, None)
            self._save()
        return {"sessions": len(self.index), "embedded": done, "prompts": prompts, "pieces": npieces,
                "seconds": round(time.time() - t, 1)}

    def search(self, query: str, k: int = TOP) -> dict:
        query = (query or "").strip()[:PROMPT_CHARS]
        if not query:
            raise ValueError("type something to search")
        q = _unit(embed(["search_query: " + query], self.post)[0])
        qw = words(query) or {query.lower()}
        phrase = " ".join(query.lower().split())
        rows = []  # (session, best meaning, its piece, best words share, its piece, holds the words in that order)
        with self.lock:
            for sid, s in self.index.items():
                if not s["turns"]:
                    continue
                sims = [_dot(q, t["v"]) for t in s["turns"]]
                si = max(range(len(sims)), key=sims.__getitem__)
                ws = self.words.get(sid) or [set() for _ in s["turns"]]
                hits = [len(qw & w) + (len(qw) + 1 if phrase in " ".join(t["c"].lower().split()) else 0)
                        for w, t in zip(ws, s["turns"])]
                li = max(range(len(hits)), key=hits.__getitem__)
                exact = hits[li] > len(qw)
                rows.append((sid, sims[si], si, (hits[li] - (len(qw) + 1 if exact else 0)) / len(qw), li, exact))
        # words ranking: a session that holds the query word for word first, then the share of its words
        by_sem = {r[0]: i for i, r in enumerate(sorted(rows, key=lambda r: -r[1]))}
        by_lex = {r[0]: i for i, r in enumerate(sorted(rows, key=lambda r: (not r[5], -r[3], -r[1])))}
        fuse = lambda sid: 1 / (RRF + by_sem[sid] + 1) + 1 / (RRF + by_lex[sid] + 1)
        out = []
        # a session that holds the query word for word comes first: the fused rank alone let a near meaning beat it
        # (check run 2: 5 of 20 known prompts held by one session only were not first)
        for sid, sem, si, lex, li, exact in sorted(rows, key=lambda r: (not r[5], -fuse(r[0])))[:k]:
            s = self.index[sid]
            t = s["turns"][li if lex >= 0.5 or exact else si]  # the piece that matched the words when most of them did
            out.append({"session": sid, "score": round(fuse(sid), 5), "meaning": round(sem, 4), "words": round(lex, 3), "exact": exact,
                        "turn": t["n"], "at": t["at"], "prompt": t["c"][:300], "project": s["cwd"],
                        "turns": s.get("prompts", len(s["turns"]))})
        return {"query": query, "results": out}

    # -- the digest -------------------------------------------------------------------------------------------------
    def digest_path(self, day: str) -> Path:
        return self.folder / f"digest-{day}.md"

    def write_digest(self, day: str) -> str:
        """One local day's digest, written by DIGEST_MODEL from that day's prompts, one section per session."""
        parts = []
        with self.lock:
            items = [(sid, s, [t for t in s["turns"] if _local_day(t["at"]) == day]) for sid, s in self.index.items()]
        for sid, s, turns in sorted(((a, b, c) for a, b, c in items if c), key=lambda x: x[2][0]["at"]):
            firsts = [t for i, t in enumerate(turns) if i == 0 or t["n"] != turns[i - 1]["n"]]  # each prompt's first piece
            asks = "\n".join(f"- {t['c'][:600]}" for t in firsts[:40])
            prompt = ("Summarize what the owner worked on in this Claude Code session, from the owner's messages below. "
                      "Answer in 2 to 4 bullet points, one short line each, plain words, no preamble.\n\n" + asks)
            r = self.post("/api/generate", {"model": DIGEST_MODEL, "prompt": prompt, "stream": False, "think": False,
                                            "options": {"temperature": 0.2, "num_predict": 300}})
            text = (r.get("response") or "").strip()
            parts.append(f"## {s['cwd']} · {sid[:8]} · {len(firsts)} prompts\n\n{text}\n")
        body = f"# Digest {day}\n\n" + ("\n".join(parts) if parts else "No session was active this day.\n")
        body += f"\n_Written by {DIGEST_MODEL} on this PC from the owner's prompts; {len(parts)} sessions._\n"
        self.digest_path(day).write_text(body, encoding="utf-8")
        return body

    def digest(self, day: str) -> dict:
        datetime.strptime(day, "%Y-%m-%d")  # ValueError for anything else
        p = self.digest_path(day)
        days = sorted(x.stem[7:] for x in self.folder.glob("digest-*.md"))
        if not p.is_file():
            return {"day": day, "text": "", "days": days, "missing": True}
        return {"day": day, "text": p.read_text(encoding="utf-8"), "days": days}

    def daily(self) -> list[str]:
        """Refresh the index and write yesterday's digest when it is not there yet. Log lines."""
        log = []
        r = self.refresh()
        if r["embedded"]:
            log.append(f"search index: {r['embedded']} sessions embedded ({r['prompts']} prompts, {r['pieces']} pieces) "
                       f"in {r['seconds']} s")
        y = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
        if not self.digest_path(y).is_file():
            t = time.time()
            self.write_digest(y)
            log.append(f"digest {y} written in {round(time.time() - t, 1)} s")
        return log
