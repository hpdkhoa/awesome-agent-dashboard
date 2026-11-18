"""Records with ids: the knowledge base for the computer and for the owner (plan bf73af63 step F1; the owner, 2026-11-18,
on the KB mockup: "good add this to plan"; on Better vs Best: "I pick best"; "yes this plan will used to build the best
version directly, not build better then transver to best"; F3 inside it: "Best takes F3").

What the approved mockup (mockup-kb-better-best.svg, plan v4) asks, and where it is built:
- one records table with ids (dec, att, les, rule, find): `records/<type>:<n>`; sessions write and read with the inbox
  tools record_add, record_query (and record_edit for a new version);
- KB first as a gate: the matching records (Ollama search) go into every run (gate_for_run, called by runs.py before a
  run starts), the run must cite them (check_cites, called by step_update), a rejected attempt is refused without a new
  reason (add: type att), --duplicate-of for the same fact, --new otherwise (add: duplicate_of / new);
- versions per record with the owner's words per version (edit); links: supersedes, duplicate-of, applies to
  plan/step/file (links); F3: the owner's CLAUDE.md sections are rule records, a changed section makes v(n+1) with the
  owner's words in it (sync_rules), and each run keeps the rule versions it ran under;
- human: the Records tab and graph on the page (web/src/Records.tsx); a generated human copy per area (human_copy);
- the one-time import of the md feedback logs, the plans' lessons and CLAUDE.md (import_*).

The same-fact line (DUP) and the matching line (MATCH) are measured, not set by hand: see calibrate() and
docs/records-calibration.json (what they were measured from).
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import time
from datetime import datetime, timezone
from pathlib import Path

TYPES = {"dec": "decision", "att": "attempt", "les": "lesson", "rule": "rule", "find": "finding"}
ID = re.compile(r"\b(dec|att|les|rule|find):(\d+)\b")
OUTCOMES = ("open", "accepted", "rejected")
WORD = re.compile(r"\w{3,}")
RRF = 60
# Measured 2026-11-18 on the 546 imported records, nomic-embed-text cosine (docs/records-calibration.json):
DUP = 0.90    # same fact: 95% of 60 paraphrases (same fact, conditions, outcome) are at 0.9025 or more; no random pair of
#               records reached it (max 0.8568 of 4,000)
MATCH = 0.73  # matches a run: the 99th percentile (0.7262) of 43,680 cosines between 80 plan-step messages and every
#               record; under it a record is no closer to the run than 99% of all records are
GIVE = 6      # at most this many go into one run: 1% of 546 records pass MATCH on average, 5.5 per run
WORDS_ONLY = "words only (Ollama did not answer)"
PAGE = 500  # the data API's most per read (dataapi.py MAX_LIMIT)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def words(text: str) -> set[str]:
    return set(WORD.findall((text or "").lower()))


def unit(v: list[float]) -> list[float]:
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [round(x / n, 5) for x in v]


def dot(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


def key_of(*parts: str) -> str:
    return hashlib.sha1("\x1f".join(parts).encode("utf-8")).hexdigest()[:16]


def cited_ids(text: str) -> list[str]:
    return list(dict.fromkeys(f"{t}:{n}" for t, n in ID.findall(text or "")))


def ollama_embed(texts: list[str], kind: str = "document", timeout: float = 120) -> list[list[float]]:
    from .localsearch import _post, EMBED_MODEL

    prefix = "search_query: " if kind == "query" else "search_document: "
    out = _post("/api/embed", {"model": EMBED_MODEL, "input": [prefix + t[:1500] for t in texts]}, timeout=timeout)
    return [unit(v) for v in out["embeddings"]]


class Refused(ValueError):
    """A write the KB refuses: the message says why and names the record ids."""


class Records:
    """The records on any store with get, put_many, update, find (the local database, or a fake in tests).
    embed(texts, kind) -> unit vectors; it may raise OSError (Ollama down): then search is by words only."""

    def __init__(self, store, embed=ollama_embed, by: str = ""):
        self.store, self.embed, self.by = store, embed, by

    # -- reading ----------------------------------------------------------------------------------------------------
    def get(self, rid: str) -> dict | None:
        return self.store.get(f"records/{rid}")

    def _every(self, coll: str, filters=None, order: str = "n") -> list[dict]:
        """Every document, in pages of PAGE: a read through another box's data API returns at most 500
        (dataapi.py MAX_LIMIT), so one find would cut the records short there."""
        out, after = [], None
        while True:
            got = self.store.find(coll, filters, order, False, PAGE, *([after] if after else []), with_id=True)
            out += got
            if len(got) < PAGE:
                return out
            after = [got[-1][order], got[-1]["__id"]]

    def all(self, type_: str = "") -> list[dict]:
        rows = self._every("records", [("type", "EQUAL", type_)] if type_ else None)
        return sorted(({k: v for k, v in r.items() if k != "__id"} for r in rows), key=lambda r: (r["type"], r["n"]))

    def _vecs(self) -> dict[str, list[float]]:
        return {d["__id"]: d["v"] for d in self._every("recordVecs", order="hash") if d.get("v")}

    def search(self, about: str, type_: str = "", k: int = 10, status: str = "", only: list[dict] | None = None) -> dict:
        """Records ranked by meaning (cosine of the embedded text) and by words (the share of the query's words the
        record holds), fused by reciprocal rank, as localsearch.py ranks sessions. {"how", "results": [...]}."""
        rows = only if only is not None else self.all(type_)
        if status:
            rows = [r for r in rows if r.get("status") == status]
        rows = [r for r in rows if r.get("status") != "duplicate"]
        if not rows or not (about or "").strip():
            return {"how": "none", "results": [{**r, "meaning": None} for r in rows[:k]] if not about else []}
        qw = words(about) or {about.lower()}
        how, sims = "meaning+words", {}
        try:
            q = self.embed([about[:2000]], "query")[0]
            vecs = self._vecs()
            sims = {r["id"]: dot(q, vecs[r["id"]]) for r in rows if r["id"] in vecs}
        except OSError:
            how = WORDS_ONLY
        lex = {r["id"]: len(qw & words(r.get("text", "") + " " + r.get("words", ""))) / len(qw) for r in rows}
        by_sem = {rid: i for i, rid in enumerate(sorted(sims, key=lambda x: -sims[x]))}
        by_lex = {rid: i for i, rid in enumerate(sorted(lex, key=lambda x: -lex[x]))}
        def fuse(rid):
            return (1 / (RRF + by_sem[rid] + 1) if rid in by_sem else 0) + 1 / (RRF + by_lex[rid] + 1)
        ranked = sorted(rows, key=lambda r: -fuse(r["id"]))[:k]
        return {"how": how, "results": [{**r, "meaning": round(sims[r["id"]], 4) if r["id"] in sims else None,
                                         "wordShare": round(lex[r["id"]], 3)} for r in ranked]}

    def nearest(self, text: str, type_: str) -> list[tuple[float, dict]]:
        """Same-type records by cosine to text, strongest first; [] when Ollama is down (then only an exact text
        counts as the same)."""
        rows = [r for r in self.all(type_) if r.get("status") != "duplicate"]
        exact = [(1.0, r) for r in rows if " ".join(r.get("text", "").split()).lower() == " ".join(text.split()).lower()]
        try:
            v = self.embed([text], "document")[0]
        except OSError:
            return exact
        vecs = self._vecs()
        got = sorted(((dot(v, vecs[r["id"]]), r) for r in rows if r["id"] in vecs), key=lambda x: -x[0])
        return exact + [g for g in got if g[1] not in [e[1] for e in exact]]

    # -- writing ----------------------------------------------------------------------------------------------------
    def _next_id(self, type_: str) -> str:
        n = max([r.get("n", 0) for r in self.store.find("records", [("type", "EQUAL", type_)])] or [0]) + 1
        while self.store.get(f"records/{type_}:{n}"):
            n += 1
        return f"{type_}:{n}"

    def _vec(self, rid: str, text: str) -> None:
        try:
            self.store.put_many({f"recordVecs/{rid}": {"v": self.embed([text], "document")[0], "hash": key_of(text)}}, log=False)
        except OSError:
            pass  # embedded later by reindex(); search falls back to words for it

    def add(self, type_: str, text: str, *, words_: str = "", why: str = "", outcome: str = "", source: str = "",
            area: str = "", plan: str = "", step: str = "", files: list[str] | None = None, supersedes: list[str] | None = None,
            duplicate_of: str = "", new: bool = False, new_reason: str = "", check: bool = True, extra: dict | None = None) -> str:
        """A new record. Refused (Refused, with the ids) when:
        - type att and a rejected attempt says the same (cosine >= DUP) and no new_reason is given;
        - a record of the same type says the same and neither duplicate_of (the same fact) nor new (a distinct one)."""
        if type_ not in TYPES:
            raise ValueError(f"type is one of {', '.join(TYPES)}")
        text = " ".join(str(text or "").split()) if "\n" not in (text or "") else str(text).strip()
        if not text:
            raise ValueError("a record needs its text")
        if type_ == "att" and outcome and outcome not in OUTCOMES:
            raise ValueError(f"outcome is one of {', '.join(OUTCOMES)}")
        if duplicate_of and not self.get(duplicate_of):
            raise ValueError(f"no record {duplicate_of}")
        for s in supersedes or []:
            if not self.get(s):
                raise ValueError(f"no record {s} to supersede")
        retry = ""
        if check and not duplicate_of:
            near = [(s, r) for s, r in self.nearest(text, type_) if s >= DUP]
            if type_ == "att":
                rejected = [(s, r) for s, r in near if r.get("status") == "rejected"]
                if rejected and not new_reason.strip():
                    s, r = rejected[0]
                    raise Refused(f"Refused: repeat of rejected attempt {r['id']} ({r.get('text', '')[:120]}; why rejected: "
                                  f"{r.get('why') or 'not said'}; same at {s:.2f}). Give new_reason to try it again.")
                if rejected:
                    retry = rejected[0][1]["id"]
                    near = [x for x in near if x[1]["id"] != retry]
            if near and not new:
                ids = ", ".join(f"{r['id']} ({s:.2f})" for s, r in near[:3])
                raise Refused(f"Refused: near-duplicate of {ids}. Read them first; pass duplicate_of=<id> when it is the "
                              f"same fact, conditions and outcome, or new=true when it is distinct.")
        rid = self._next_id(type_)
        at = now_iso()
        doc = {"id": rid, "type": type_, "n": int(rid.split(":")[1]), "text": text, "title": text.split("\n")[0][:200],
               "words": words_, "why": why, "source": source, "area": area or "general", "plan": plan, "step": step,
               "files": files or [], "status": (outcome or "open") if type_ == "att" else "active",
               "versions": [{"v": 1, "text": text, "words": words_, "at": at, "by": self.by, "note": "made"}],
               "links": {"supersedes": supersedes or [], "supersededBy": [], "duplicateOf": duplicate_of,
                         "duplicates": [], "retryOf": retry, "newReason": new_reason.strip() if retry else ""},
               "cited": 0, "createdAt": at, "updatedAt": at, "by": self.by, **(extra or {})}
        if duplicate_of:
            doc["status"] = "duplicate"
        self.store.put_many({f"records/{rid}": doc})
        self._vec(rid, text)
        if duplicate_of:
            old = self.get(duplicate_of)
            self.store.update(f"records/{duplicate_of}", {"links": {**old["links"], "duplicates": old["links"].get("duplicates", []) + [rid]},
                                                          "updatedAt": at})
        for s in supersedes or []:
            old = self.get(s)
            self.store.update(f"records/{s}", {"status": "superseded", "updatedAt": at,
                                               "links": {**old["links"], "supersededBy": old["links"].get("supersededBy", []) + [rid]}})
        return rid

    def edit(self, rid: str, text: str = "", words_: str = "", note: str = "", outcome: str = "", why: str = "") -> int:
        """A new version v(n+1). A rule or a decision needs the owner's words for it (the owner's words are the
        record); an attempt may only change its outcome (accepted, rejected) with why."""
        r = self.get(rid)
        if not r:
            raise ValueError(f"no record {rid}")
        if r.get("heading"):
            raise ValueError(f"{rid} is the owner's CLAUDE.md section \"{r['heading']}\": it changes only there; the next run "
                             f"makes its next version from the file")
        if r["type"] in ("rule", "dec") and not words_.strip():
            raise ValueError(f"{rid} is a {TYPES[r['type']]}: a new version needs the owner's words for it (words=...)")
        if outcome and (r["type"] != "att" or outcome not in OUTCOMES):
            raise ValueError("only an attempt has an outcome: open, accepted or rejected")
        text = (text or "").strip() or r["text"]
        n = len(r.get("versions") or []) + 1
        at = now_iso()
        ver = {"v": n, "text": text, "words": words_, "at": at, "by": self.by, "note": note or ("outcome " + outcome if outcome else "edited")}
        fields = {"versions": (r.get("versions") or []) + [ver], "text": text, "title": text.split("\n")[0][:200],
                  "words": words_ or r.get("words", ""), "updatedAt": at}
        if outcome:
            fields.update(status=outcome, why=why or r.get("why", ""))
        self.store.update(f"records/{rid}", fields)
        if text != r["text"]:
            self._vec(rid, text)
        return n

    def link(self, rid: str, plan: str = "", step: str = "", files: list[str] | None = None) -> None:
        r = self.get(rid)
        if not r:
            raise ValueError(f"no record {rid}")
        self.store.update(f"records/{rid}", {"plan": plan or r.get("plan", ""), "step": step or r.get("step", ""),
                                             "files": list(dict.fromkeys((r.get("files") or []) + (files or []))), "updatedAt": now_iso()})

    def reindex(self) -> int:
        """Embeds every record whose vector is missing or older than its text. Returns how many."""
        have = {d["__id"]: d.get("hash") for d in self._every("recordVecs", order="hash")}
        todo = [r for r in self.all() if have.get(r["id"]) != key_of(r["text"])]
        for i in range(0, len(todo), 32):
            part = todo[i:i + 32]
            vecs = self.embed([r["text"] for r in part], "document")
            self.store.put_many({f"recordVecs/{r['id']}": {"v": v, "hash": key_of(r["text"])} for r, v in zip(part, vecs)}, log=False)
        return len(todo)

    # -- KB first: the gate on every run ----------------------------------------------------------------------------
    def gate_for_run(self, text: str, plan: str = "", step: str = "") -> dict:
        """The records a run gets before it starts: every record that applies to its plan step, then the strongest
        matches of its message (cosine >= MATCH, at most GIVE in all). {"ids", "how", "block"}; no ids, no block."""
        rows = [r for r in self.all() if r.get("status") not in ("duplicate", "superseded")]
        pinned = [r for r in rows if plan and r.get("plan") == plan and (not r.get("step") or r.get("step") == step)]
        got = self.search(text, k=GIVE * 3, only=[r for r in rows if r not in pinned])
        strong = [r for r in got["results"] if r.get("meaning") is not None and r["meaning"] >= MATCH]
        if got["how"] == WORDS_ONLY:
            strong = [r for r in got["results"] if r.get("wordShare", 0) >= 0.5]
        give = (pinned + strong)[:GIVE]
        if not give:
            return {"ids": [], "how": got["how"], "block": ""}
        lines = []
        for r in give:
            extra = f"; outcome {r['status']}" + (f", why: {r['why']}" if r.get("why") else "") if r["type"] == "att" else ""
            ver = f" v{len(r.get('versions') or [1])}" if len(r.get("versions") or []) > 1 else ""
            lines.append(f"- {r['id']}{ver} [{TYPES[r['type']]}{extra}] {r['title'][:300]}" + (f" (source: {r['source']})" if r.get("source") else ""))
        block = ("<kb-records>\nKB first: these records match this run (the dashboard's knowledge base). Read them before "
                 "you design or build. Never repeat a rejected attempt without a new reason. In your step_update reply, "
                 "cite each id: how you used it, or why it does not apply. Add what you decide, try or find with "
                 "record_add; look up more with record_query.\n" + "\n".join(lines) + "\n</kb-records>")
        return {"ids": [r["id"] for r in give], "how": got["how"], "block": block}

    def check_cites(self, given: list[str], text: str) -> list[str]:
        """The given ids the text does not cite (empty: all cited)."""
        have = set(cited_ids(text))
        return [g for g in given if g not in have]

    def count_cites(self, ids: list[str]) -> None:
        for rid in ids:
            r = self.get(rid)
            if r:
                self.store.update(f"records/{rid}", {"cited": int(r.get("cited") or 0) + 1})

    # -- F3: the owner's CLAUDE.md sections as versioned rule records ------------------------------------------------
    def sync_rules(self, claude_md: Path, area: str = "global rules") -> dict:
        """Each "## " section of the owner's CLAUDE.md is one rule record (keyed by its heading). A section whose text
        changed makes v(n+1); its owner's words are the section's quoted "The owner's words" lines. Returns
        {"versions": {rule id: n}, "changed": [ids], "new": [ids]}."""
        try:
            md = Path(claude_md).read_text(encoding="utf-8")
        except OSError:
            return {"versions": {}, "changed": [], "new": []}
        have = {r.get("heading"): r for r in self.all("rule") if r.get("heading")}
        out = {"versions": {}, "changed": [], "new": []}
        for head, body in sections(md):
            text = f"{head}\n\n{body}".strip()
            ow = owner_words(body)
            r = have.get(head)
            if r is None:
                rid = self.add("rule", text, words_=ow, source=f"{claude_md} ## {head}", area=area, check=False,
                               extra={"heading": head})
                out["new"].append(rid)
                out["versions"][rid] = 1
                continue
            if r["text"] != text:
                n = len(r.get("versions") or []) + 1
                at = now_iso()
                self.store.update(f"records/{r['id']}", {
                    "versions": (r.get("versions") or []) + [{"v": n, "text": text, "words": ow, "at": at, "by": "CLAUDE.md",
                                                             "note": "section edited in CLAUDE.md"}],
                    "text": text, "title": head, "words": ow, "updatedAt": at})
                self._vec(r["id"], text)
                out["changed"].append(r["id"])
            out["versions"][r["id"]] = len(r.get("versions") or []) + (1 if r["text"] != text else 0)
        return out

    # -- the human copy --------------------------------------------------------------------------------------------
    def human_copy(self, area: str = "") -> str:
        """One markdown page per area, like the BW/VR rules-review.md: every live record by type, its id, version,
        source and the owner's words; superseded and duplicate ones left out."""
        rows = [r for r in self.all() if (not area or r.get("area") == area) and r.get("status") not in ("duplicate", "superseded")]
        out = [f"# Records: {area or 'all areas'} (human copy, {now_iso()[:10]})", "",
               "> Made from the records table; the records are the source. Ids: dec decision, att attempt, les lesson, "
               "rule rule, find finding.", ""]
        for t, name in TYPES.items():
            part = [r for r in rows if r["type"] == t]
            if not part:
                continue
            out += [f"## {name.capitalize()}s ({len(part)})", ""]
            for r in part:
                v = len(r.get("versions") or [1])
                state = f", {r['status']}" if t == "att" else ""
                first = r["text"].split("\n")[0]
                out.append(f"- **{r['id']}** v{v}{state}: {first}" + (f" ({r['source']})" if r.get("source") else ""))
                if r.get("words"):
                    out.append(f"  - the owner: {r['words'][:400]}")
                if r.get("why"):
                    out.append(f"  - why: {r['why']}")
            out.append("")
        return "\n".join(out)

    def areas(self) -> list[str]:
        return sorted({r.get("area", "general") for r in self.all()})

    def answer(self, body: dict) -> dict:
        """The page's asks through the file viewer (POST /text): {"records": query, "type"} or {"recordsCopy": area}."""
        if "recordsCopy" in body:
            area = str(body.get("recordsCopy") or "")
            return {"area": area, "text": self.human_copy(area), "areas": self.areas()}
        got = self.search(str(body.get("records") or ""), str(body.get("type") or ""), 30)
        return {"how": got["how"], "results": [{k: r.get(k) for k in ("id", "meaning", "wordShare")} for r in got["results"]]}


# -- the one-time import ------------------------------------------------------------------------------------------
_SEC = re.compile(r"^## (.+)$", re.M)
_OWNER = re.compile(r"The owner's words \(([^)]*)\):\s*(.+?)(?=\n\n|\n\d+\. |\Z)", re.S)


def sections(md: str) -> list[tuple[str, str]]:
    marks = list(_SEC.finditer(md))
    return [(m.group(1).strip(), md[m.end():(marks[i + 1].start() if i + 1 < len(marks) else len(md))].strip())
            for i, m in enumerate(marks)]


def owner_words(body: str) -> str:
    return " / ".join(f"({d}) {' '.join(w.split())}" for d, w in _OWNER.findall(body))


def _cells(line: str) -> list[str]:
    return [c.strip() for c in line.strip().strip("|").split("|")]


def feedback_rows(path: Path) -> list[dict]:
    """The rows of an owner feedback log, any of the three forms on this PC:
    a table | Date | Owner's words | Good/bad | What it means |; dated "## YYYY-MM-DD" headings over a table
    | Owner's words | Good/bad | What it means |; or paragraphs "YYYY-MM-DD, the owner: "..." / What it means: ...".
    Each: {date, words, kind, means, line}."""
    lines = Path(path).read_text(encoding="utf-8").splitlines()
    out, day = [], ""
    for i, line in enumerate(lines, 1):
        h = re.match(r"^## (\d{4}-\d{2}-\d{2})", line)
        if h:
            day = h.group(1)
            continue
        if line.startswith("|") and not re.match(r"^\|\s*-", line):
            c = _cells(line)
            if re.match(r"\d{4}-\d{2}-\d{2}", c[0]) and len(c) >= 4:
                out.append({"date": c[0][:10], "words": c[1], "kind": c[2], "means": " | ".join(c[3:]), "line": i})
            elif day and len(c) >= 3 and c[0] not in ("Owner's words", "Date"):
                out.append({"date": day, "words": c[0], "kind": c[1], "means": " | ".join(c[2:]), "line": i})
            continue
        p = re.match(r"^(\d{4}-\d{2}-\d{2}), the owner: (.+)$", line)
        if p:
            means = ""
            for nxt in lines[i:i + 4]:
                if nxt.startswith("What it means:") or nxt.startswith("Done:"):
                    means = (means + " " + nxt).strip()
            out.append({"date": p.group(1), "words": p.group(2).strip(), "kind": "feedback", "means": means, "line": i})
    return out


def import_feedback(rec: Records, path: Path, area: str) -> tuple[int, int]:
    """Each row is a decision record (dec): the owner's words word for word, the kind and meaning as written. Rows
    already imported (same file and words) are skipped. (made, skipped)."""
    made = skipped = 0
    have = {r.get("importKey") for r in rec.all("dec")}
    for row in feedback_rows(path):
        k = key_of(str(path), row["words"], row["date"])
        if k in have:
            skipped += 1
            continue
        rec.add("dec", row["means"] or row["words"], words_=f"({row['date']}) {row['words']}", source=f"{path}:{row['line']}",
                area=area, check=False, extra={"importKey": k, "kind": row["kind"], "date": row["date"]})
        have.add(k)
        made += 1
    return made, skipped


def import_lessons(rec: Records, store) -> tuple[int, int]:
    """Each plan's current lessons (part 4) as lesson records, applying to that plan."""
    made = skipped = 0
    have = {r.get("importKey") for r in rec.all("les")}
    for plan in store.find("plans"):
        pid = plan.get("id")
        v = store.get(f"planVersions/{pid}_v{plan.get('current', 0)}") or {}
        for x in (v.get("parts") or {}).get("lessons") or []:
            if not isinstance(x, dict) or not x.get("lesson"):
                continue
            k = key_of(pid, x["lesson"])
            if k in have:
                skipped += 1
                continue
            why = "taught by: " + str(x.get("taughtBy") or "") + (f"; applied in: {x['appliedIn']}" if x.get("appliedIn") else "")
            rec.add("les", x["lesson"], why=why, source=f"plan {pid} v{plan.get('current', 0)} lessons",
                    area=plan.get("workType") or "general", plan=pid, check=False, extra={"importKey": k})
            have.add(k)
            made += 1
    return made, skipped


# -- the measured lines ---------------------------------------------------------------------------------------------
def calibrate(rec: Records, same_pairs: list[tuple[str, str]], sample: int = 4000, seed: int = 7) -> dict:
    """The cosine of labelled same-fact pairs, and of random pairs of different records (the unrelated base). DUP
    must sit above the unrelated pairs and at or below the same-fact pairs; MATCH is the unrelated 95th percentile."""
    import random

    vecs = rec._vecs()
    same = [round(dot(vecs[a], vecs[b]), 4) for a, b in same_pairs if a in vecs and b in vecs]
    ids = sorted(vecs)
    rnd = random.Random(seed)
    base = []
    for _ in range(sample):
        a, b = rnd.sample(ids, 2)
        base.append(dot(vecs[a], vecs[b]))
    base.sort()
    pct = lambda p: round(base[min(len(base) - 1, int(p * len(base)))], 4)
    return {"records": len(ids), "samePairs": len(same), "same": same, "sameMin": min(same) if same else None,
            "unrelatedPairs": len(base), "unrelatedP50": pct(0.5), "unrelatedP95": pct(0.95), "unrelatedP99": pct(0.99),
            "unrelatedP999": pct(0.999), "unrelatedMax": round(base[-1], 4)}
