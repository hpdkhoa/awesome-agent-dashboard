"""The inbox: sessions post questions, suggestions and results; the owner answers on the dashboard.

Delivery (the owner's choice, 2026-11-01, "option 1"):
- `inbox_ask` waits for the answer and returns it into the live session as the tool result.
- An answer the session cannot pick up live (it has closed) is delivered by the bridge with
  `claude -p --resume <session>` (deliver.py). The bridge never resumes a session that is still open: each open
  session's inbox server writes a heartbeat to liveSessions/<session> every minute.

Kinds: question, suggestion, result, approval (a tool call in a run started from the dashboard).
Item states: open -> answered (the owner, on the page) -> delivered (live or by resume), or closed (nothing to send).

Plans (the owner's choice, 2026-11-01, "do 2"): a session opens a plan (plans/<id>) and posts its versions
(planVersions/<id>_v<n>). Each question the session asks while the plan is open joins it, in the round of the version
it was asked on (round 0: before v1), so the page shows v1, its questions and answers, v2, and so on.
Each version keeps its parent and the answers that made it (madeBy). When the owner reopens an answer on the page, the
session posts a version whose parent is the version that question was asked on: a branch. Old branches stay.

Plan from a session (the owner's words, 2026-11-03, cc/dashboard/SESSION_PLAN.md): a plan made from a session's real
record has six parts, in the owner's order: goal, summary, rules, lessons (each with how it was applied), leftover and
steps. Two kinds of version (the owner's words: "The version I mention in this request is the plan version, the
previous 2026-11-01 version will be the step version, which in each step I can see the last reply like a normal
message"):
- plan version (planVersions): only when the plan's data changes, never when a step moves;
- step version (planSteps): each report on a step (step_update), its state and its reply; no plan version.
A message on the plan has a kind: qa, goal, step, rule, lesson or action. A Q&A or an Action run never changes the plan:
plan_version is refused in it until the owner confirms a switch to another kind (plan_switch). An Action run does the
work asked (step i11).
Every option of a question in a plan carries an example (the owner's words: "every choose will have an example"): a
picture pair, a code diff with a benchmark, or a draft. A plan question without one is refused.
"""


import json
import os
import re
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone

from .aggregate import work_type_of
from .boardrules import check_board
from .redact import redact
from .filelinks import refuse_dead_links
from .planfrom import check_parts

BEAT_SECONDS = 60
LIVE_SECONDS = 180  # a session whose heartbeat is older than this is treated as closed
POLL_SECONDS = 5
# how long one archiver_wait call blocks before it returns "nothing": measured 2026-11-07 on CLI 2.1.316, a tool call
# held 30, 330, 660 and 1260 s with no timeout; 1200 s stays under the longest measured. An ask returns at once anyway.
ARCHIVER_WAIT = 1200
MAX_WAIT_MINUTES = 25  # under Claude Code's 30-minute idle limit for a local MCP server
PUSH_TITLE = {"question": "Question", "suggestion": "Suggestion", "result": "Result to review"}
PARTS = ("goal", "summary", "rules", "lessons", "leftover", "steps")
KINDS = {"qa": "Q&A", "goal": "Shift goal", "step": "Add step", "rule": "Change rule", "lesson": "Audit lesson",
         "action": "Action"}
NO_PLAN_CHANGE = ("qa", "action")  # kinds that never post a plan version without a confirmed switch
STEP_STATES = ("next", "now", "done", "failed")
# The plan's phases (the owner's words, 2026-11-04: "In my mind having these phases: 1. Explore 2. Build 3. Verify
# 4. Remove 5. Optimize. Then in any phase can rollback to previous phases at any step"; "Every plan starts in Explore";
# "I will be the one who trigger the move in every phase, I give order and decisions, you note it down as a plain
# version to change the phase, and I want the version is included the phase"). 6. Done (the owner, 2026-11-20: "Done just
# a phase, I just want to categorize so keep it as separated like it is now": it never touches the Open/Closed status).
PHASES = ("explore", "build", "verify", "remove", "optimize", "done")
# The plan format number (the owner's words, 2026-11-07: "all plans will have to update to latest format when I resume
# the plan"). 0: text only. 1: the six parts. Raise it when the plan format changes; plans below it are rebuilt from
# their session when the owner resumes them (runs.py _upgrade_first).
PLAN_FORMAT = 1


def format_of(plan: dict) -> int:
    """A plan's format number; plans made before the number existed: 1 with the six parts, else 0."""
    return int(plan.get("format", 1 if plan.get("kind") == "parts" else 0))


def check_example(e) -> str | None:
    """Why an option's example is not enough, or None when it is. image: before and after files; code: a diff and at
    least one benchmark row that says whether it was measured; text: the draft."""
    if not isinstance(e, dict):
        return "no example"
    t = e.get("type")
    if t == "image":
        return None if e.get("before") and e.get("after") else "an image example needs before and after files"
    if t == "code":
        bench = e.get("bench") or []
        if not e.get("diff"):
            return "a code example needs the diff"
        if not bench or any(not isinstance(r, dict) or "measured" not in r for r in bench):
            return "a code example needs benchmark rows, each with measured true or false"
        return None
    if t == "text":
        return None if (e.get("draft") or "").strip() else "a text example needs the draft"
    if t == "visual":
        return None if clean_svg(e.get("svg")) else "a visual example needs an inline <svg> drawing"
    return "an example's type is visual, image, code or text"


# A drawn option (the owner's words, 2026-11-07: "consider anything can draw out then it is better to have the idea or
# choice draw out instead of text out"). The page shows it as an image, where no script runs; scripts, event handlers,
# foreign objects and outside links are still cut here.
def clean_svg(svg) -> str:
    s = str(svg or "").strip()
    if not s.lower().startswith("<svg") or len(s) > 30000:
        return ""
    s = re.sub(r"(?is)<(script|foreignObject)\b.*?</\1\s*>", "", s)
    s = re.sub(r"(?is)<(script|foreignObject)\b[^>]*/>", "", s)
    s = re.sub(r"(?i)\son\w+\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)", "", s)
    s = re.sub(r"(?i)((?:xlink:)?href\s*=\s*[\"'])(?!#)[^\"']*", r"\1#", s)
    return s


def clean_example(e: dict) -> dict:
    out = {"type": e["type"]}
    if e.get("type") == "visual":
        out["svg"] = clean_svg(e.get("svg"))
    for k, n in (("before", 300), ("after", 300), ("diff", 12000), ("draft", 6000), ("note", 400)):
        if e.get(k):
            out[k] = redact(str(e[k]), n)
    if e.get("bench"):
        out["bench"] = [{"name": redact(str(r.get("name", "")), 120), "before": redact(str(r.get("before", "")), 60),
                         "after": redact(str(r.get("after", "")), 60), "measured": bool(r.get("measured")),
                         "source": redact(str(r.get("source", "")), 200)} for r in e["bench"][:12]]
    return out


def _lines(v) -> str:
    if isinstance(v, str):
        return v
    out = []
    for x in v or []:
        if isinstance(x, dict):
            out.append("- " + " · ".join(f"{k}: {x[k]}" for k in x if x[k] not in ("", None)))
        else:
            out.append(f"- {x}")
    return "\n".join(out)


def parts_markdown(parts: dict) -> str:
    """The six parts as one markdown text, for the list and graph views and the push."""
    names = {"goal": "1. Goal", "summary": "2. Summary", "rules": "3. Rules", "lessons": "4. Lessons",
             "leftover": "5. Leftover", "steps": "6. Steps"}
    def shown(k):  # a new step (work the record does not hold) is marked in the text, so the graph's diff shows it
        if k != "steps":
            return parts.get(k)
        return [{**{x: y for x, y in st.items() if x != "new"}, "title": ("[new] " if st.get("new") else "") + str(st.get("title", ""))}
                if isinstance(st, dict) else st for st in parts.get(k) or []]
    out = "\n\n".join(f"## {names[k]}\n\n{_lines(shown(k))}" for k in PARTS)
    out = (f"## Board\n\n{board_markdown(parts['board'])}\n\n" if parts.get("board") else "") + out
    return out + (f"\n\n## Cite\n\n{parts['cite']}" if parts.get("cite") else "")


# The harness (the owner's words, 2026-11-04: "for the harness in here I need the list as a section in the plan so I can
# review and see the diff everytime the plan change what harness will be change, and at last I'll need to approve every
# single harness item"; harness = "Both": the tools and context each step needs, and each step's check). The list rides
# on every plan version, so versions diff it; the owner's ticks live in planHarness/<plan id> (the owner's choice:
# "Small approvals record"), written by the page.
HARNESS_KINDS = ("tool", "check")


def clean_harness(items) -> list[dict]:
    out, seen = [], set()
    for i, h in enumerate(items or [], 1):
        if not isinstance(h, dict) or not str(h.get("item", "")).strip():
            continue
        hid = str(h.get("id") or f"h{i}")[:20]
        if hid in seen:
            raise ValueError(f"two harness items have the id {hid}")
        seen.add(hid)
        kind = str(h.get("kind", "check")).lower()
        out.append({"id": hid, "item": redact(str(h["item"]), 400), "kind": kind if kind in HARNESS_KINDS else "check"})
    return out[:100]


def item_hash(h: dict) -> str:
    """FNV-1a, 32 bits, over the item's kind and text: the same as the page's harness.ts itemHash."""
    x = 0x811C9DC5
    for c in f"{h.get('kind', '')}:{h.get('item', '')}":
        x = ((x ^ ord(c)) * 0x01000193) & 0xFFFFFFFF
    return f"{x:08x}"


def harness_split(harness: list[dict], ticks: dict | None) -> dict:
    """Which items go into Build (the owner's words, 2026-11-04: "unticked harness items mean not approve that item to
    go through build so Move to Build button still be able to click but the unticked item won't be used or added into
    build phase"): an item is approved when its tick is on and its hash matches the item as it is now."""
    items = (ticks or {}).get("items") or {}
    ok = [h["id"] for h in harness if (items.get(h["id"]) or {}).get("ok") and items[h["id"]].get("hash") == item_hash(h)]
    return {"approved": ok, "notApproved": [h["id"] for h in harness if h["id"] not in ok]}


def clean_parts(parts: dict) -> dict:
    """The six parts, each kept; steps get ids. Raises ValueError when one is missing."""
    missing = [k for k in PARTS if k not in (parts or {})]
    if missing:
        raise ValueError("a plan needs all six parts; missing: " + ", ".join(missing))
    out = {k: redact(_lines(parts[k]), 12000) for k in ("goal", "summary")}
    # the cite (the owner's words, 2026-11-05: "move what the plan read (current inside the goal section) out into the
    # cite section like generated section"): the owner's quotes the plan reads; part 1 says what the plan is for
    if str(parts.get("cite") or "").strip():
        out["cite"] = redact(_lines(parts["cite"]), 12000)
    out["rules"] = [{"rule": redact(str(r.get("rule", "")), 400), "source": redact(str(r.get("source", "")), 200)}
                    for r in parts["rules"] or [] if isinstance(r, dict)]
    out["lessons"] = [{"lesson": redact(str(r.get("lesson", "")), 400),
                       "taughtBy": redact(str(r.get("taught_by", r.get("taughtBy", ""))), 400),
                       "appliedIn": redact(str(r.get("applied_in", r.get("appliedIn", ""))), 400)}
                      for r in parts["lessons"] or [] if isinstance(r, dict)]
    out["leftover"] = [redact(str(x), 400) for x in parts["leftover"] or []]
    out["steps"] = [{"id": str(st.get("id") or f"s{i}")[:20], "title": redact(str(st.get("title", "")), 200),
                     "does": redact(str(st.get("does", "")), 1000), "check": redact(str(st.get("check", "")), 600),
                     **({"new": True} if st.get("new") else {})}
                    for i, st in enumerate(parts["steps"] or [], 1) if isinstance(st, dict)]
    if parts.get("board"):
        out["board"] = clean_board(parts["board"], [st["id"] for st in out["steps"]])
    return out


# The plan's board (the owner's words, 2026-11-16: "Make this report become the main look where I can see what this
# plan used for (the meaning), the idea, what is the progress (means what is currently build and progress compare with
# the final product of the plan). Not redunant what I can look at the steps section"; pick "Product board, new
# fields"): what the plan is for in one line, the idea in a few lines, and the final product as features, each naming
# the steps that build it. The page colors each feature from its steps' states, so the board never goes stale.
BOARD_SHAPE = ('{"what_for": one line, "idea": [short lines], "product": [{"feature": short name, '
               '"steps": [the step ids that build it]}], "materials": [{"name", "path" (a full path; none for a material '
               'given as text), "kind": "story" | "material" | "file", "note"}] (optional), "step_cards": [{"step": step id, "for": what the '
               'step is for (its benefit), "how": how it does it, "src": [source ids]}] (one per step; the page adds its '
               'Result from the newest step report)}')

# Materials on the board (the owner's words, 2026-11-17: "Add material section in report board, in this section only
# keep the latest version of each file/material and stories"; pick "sửa web + bridge chọn session ghi"): the session
# lists the plan's files, materials and stories; one entry per family, the newest version kept (vN in the name).
MATERIAL_KINDS = ("story", "material", "file")
_VER = re.compile(r"[-_. ]?v(\d+)(?=\.[^.\\/]+$|$)", re.I)
_SEP = re.compile(r"[\\/]")


def material_family(m: dict) -> tuple[str, int]:
    """(the family key, the version number) of a material: its file name or name without its -vN, and N (0 when none)."""
    path = m.get("path") or ""
    base = _SEP.split(path)[-1] or m.get("name", "")
    hit = _VER.search(base)
    n = int(hit.group(1)) if hit else 0
    key = (base[:hit.start()] + base[hit.end():]) if hit else base
    folder = _SEP.split(path.lower())[:-1]
    folder = "/".join(folder)
    return folder + "|" + key.lower().strip(), n


def clean_materials(items) -> list[dict]:
    """The board's materials, cleaned: a name, a kind, an optional path and note; for each family only the newest
    version stays (the higher vN; the same N: the later entry)."""
    keep: dict[str, tuple[int, int, dict]] = {}
    for i, m in enumerate(items or []):
        if not isinstance(m, dict):
            continue
        path = str(m.get("path") or "").strip().strip("`")
        name = redact(str(m.get("name") or "").strip() or _SEP.split(path)[-1], 160)
        if not name:
            continue
        kind = str(m.get("kind") or "file").strip().lower()
        out = {"name": name, "kind": kind if kind in MATERIAL_KINDS else "file"}
        if path:
            out["path"] = redact(path, 400)
        if str(m.get("note") or "").strip():
            out["note"] = redact(str(m["note"]).strip(), 300)
        key, n = material_family(out)
        if key not in keep or (n, i) >= keep[key][:2]:
            keep[key] = (n, i, out)
    return [x[2] for x in sorted(keep.values(), key=lambda x: x[1])][:60]


# Sources on the board's lines (plan 44fc4979 s3; the owner's picks, 2026-11-19: "Source chip per line", truth "both a
# and c" = plan, KB, feedback log and project files, "Source field per line", "Red chip now, refuse after s6"): What for
# and each Idea line may come as {"text", "src": [ids]}. An id is a plan part (goal, summary, rules, lessons, leftover,
# steps), a step id (s3 or step:s3), a KB record (dec:470, att:1, les:2, rule:24, find:6) or a full file path, with
# #"quoted words" for the row that holds them (a feedback log row: the owner's pick, 2026-11-19, "Anchor by quoted
# text", since the log grows at the top and line numbers drift) or :line for one line. Each id must exist; a line with no id is kept and shows a red "no source"
# chip on the page (no refusal until s6 rolls every plan onto sources).
SRC_PARTS = ("goal", "summary", "rules", "lessons", "leftover", "steps")
SRC_RECORD = re.compile(r"^(dec|att|les|rule|find):\d+$")
SRC_FILE = re.compile(r"^(?P<path>[A-Za-z]:[\\/][^#]+?)(?::(?P<line>\d+)|#(?P<quote>.+))?$")


def src_quote(m) -> str:
    """The quoted words of a path#"words" id, without their quote marks."""
    return (m.group("quote") or "").strip().strip('"').strip()


def src_kind(sid: str) -> str:
    """part, step, record or file; '' for an id of no known form."""
    if sid in SRC_PARTS:
        return "part"
    if SRC_RECORD.match(sid):
        return "record"
    if SRC_FILE.match(sid):
        return "file"
    if re.match(r"^(step:)?s\w{0,18}$", sid):
        return "step"
    return ""


def board_line(x) -> tuple[str, list[str]]:
    """A board line as (text, source ids): a plain string, or {"text", "src"}."""
    if isinstance(x, dict):
        text = str(x.get("text", "") or "").strip()
        src = x.get("src") or []
        src = [src] if isinstance(src, str) else src
        return text, [str(s).strip().strip("`") for s in src if str(s).strip()][:8]
    return str(x or "").strip(), []


def check_sources(ids: list[str], step_ids: list[str]) -> list[str]:
    """The ids of no known form or naming a step the plan does not have (records and files are checked by the Inbox,
    which reads the store and the disk)."""
    bad = []
    for sid in ids:
        kind = src_kind(sid)
        if not kind or (kind == "step" and sid.removeprefix("step:") not in step_ids):
            bad.append(sid)
    return bad


def clean_board(board, step_ids: list[str]) -> dict:
    if not isinstance(board, dict):
        raise ValueError("board is " + BOARD_SHAPE)
    what, what_src = board_line(board.get("what_for", board.get("whatFor", "")))
    what = redact(what, 300)
    ideas = [board_line(x) for x in board.get("idea") or []]
    kept = board.get("src") if isinstance(board.get("src"), dict) else {}  # a board cleaned before (a plain version)
    if kept:
        what_src = what_src or [str(s) for s in kept.get("whatFor") or []]
        old = kept.get("idea") or []
        ideas = [(t, s or ([str(x) for x in old[i]] if i < len(old) else [])) for i, (t, s) in enumerate(ideas)]
    ideas = [(redact(t, 300), s) for t, s in ideas if t][:8]
    idea = [t for t, _ in ideas]
    src = {"whatFor": what_src, "idea": [s for _, s in ideas]}
    wrong = check_sources(what_src + [x for s in src["idea"] for x in s], step_ids)
    if wrong:
        raise ValueError("board source ids not understood or naming no step of this plan: " + ", ".join(wrong) + ". Use a "
                         "part (" + ", ".join(SRC_PARTS) + "), a step id, a record id (dec:N, rule:N, find:N ...) or a full "
                         "file path (path#\"quoted words\" for a log row, path:line for one line).")
    product, bad = [], []
    for f in board.get("product") or []:
        if not isinstance(f, dict) or not str(f.get("feature", "")).strip():
            continue
        ids = [str(x) for x in f.get("steps") or []]
        bad += [x for x in ids if x not in step_ids]
        product.append({"feature": redact(str(f["feature"]).strip(), 120), "steps": ids[:20]})
    if bad:
        raise ValueError("board.product names steps the plan does not have: " + ", ".join(sorted(set(bad))))
    # the owner's words, 2026-11-16: "Don't let the dashboard out of date in any kind": every step builds a feature
    left = [x for x in step_ids if not any(x in f["steps"] for f in product)]
    if left:
        raise ValueError("board.product leaves steps out: " + ", ".join(left) + ". Put each step under the feature it "
                         "builds (or a new feature), so the board follows the plan.")
    if not what or not product:
        raise ValueError("board needs what_for and product: " + BOARD_SHAPE)
    mats = clean_materials(board.get("materials"))
    has_src = bool(src["whatFor"]) or any(src["idea"])
    groups = clean_idea_groups(board.get("idea_groups", board.get("ideaGroups")))
    cards = clean_step_cards(board.get("step_cards", board.get("stepCards")), step_ids)
    return {"whatFor": what, "idea": idea, "product": product[:30], **({"materials": mats} if mats else {}),
            **({"src": src} if has_src else {}), **({"ideaGroups": groups} if groups else {}),
            **({"stepCards": cards} if cards else {})}


def clean_step_cards(cards, step_ids: list[str]) -> list[dict]:
    """Step cards (plan 44fc4979 s8, the owner's pick "A: step cards For / How / Result"; the owner's words 2026-11-21:
    "what the step for, how it will do, what is the result or outcome or benefit"): [{"step", "for", "how", "src"}].
    For and How are written short by the session with their sources; Result is not stored: the page reads it from the
    step's newest report, so it is never out of date."""
    out, bad = [], []
    for c in cards or []:
        if not isinstance(c, dict):
            continue
        sid = str(c.get("step", c.get("id", "")) or "").strip()
        fr = redact(str(c.get("for", "") or "").strip(), 160)
        how = redact(str(c.get("how", "") or "").strip(), 160)
        if not sid or not (fr or how):
            continue
        if sid not in step_ids:
            bad.append(sid); continue
        src = c.get("src") or []
        src = [src] if isinstance(src, str) else src
        src = [str(x).strip().strip("`") for x in src if str(x).strip()][:8]
        bad += check_sources(src, step_ids)
        out.append({"step": sid, "for": fr, "how": how, **({"src": src} if src else {})})
    if bad:
        raise ValueError("board.step_cards: steps or source ids not understood: " + ", ".join(bad))
    return out[:40]


def clean_idea_groups(groups) -> list[dict]:
    """Idea sub-groups (plan 44fc4979 s7, the owner's pick "By meaning"): [{"head", "count"}] in order. Kept as sent
    (shape only); a split that breaks B2 (a group over 4, counts not adding up) is flagged by the rule check, never
    refused (the owner's pick "Save + red flag")."""
    out = []
    for g in groups or []:
        if not isinstance(g, dict):
            continue
        head = redact(str(g.get("head", g.get("heading", "")) or "").strip(), 60)
        try:
            n = int(g.get("count", 0))
        except (TypeError, ValueError):
            n = 0
        if head and n > 0:
            out.append({"head": head, "count": n})
    return out[:8]


NO_BOARD = (" This plan has no board yet: add parts.board (what_for, idea, product with step ids) in the next "
            "version, so the page shows what the plan is for and its progress against the final product.")


def board_markdown(b: dict) -> str:
    src = b.get("src") or {}
    def tag(ids):  # the sources ride in the raw text too, so a session reading the plan sees them
        return f" [src: {', '.join(ids)}]" if ids else " [src: none]" if src else ""
    ideas = src.get("idea") or []
    lines = [f"- What for: {b['whatFor']}{tag(src.get('whatFor') or [])}"]
    heads, at = {}, 0
    for g in b.get("ideaGroups") or []:
        heads[at] = g["head"]; at += g["count"]
    for i, x in enumerate(b.get("idea", [])):
        if i in heads:
            lines.append(f"- Idea group: {heads[i]}")
        lines.append(f"- Idea: {x}{tag(ideas[i] if i < len(ideas) else [])}")
    lines += [f"- Step card {c['step']}: For {c['for']} · How {c['how']}{tag(c.get('src') or [])}" for c in b.get("stepCards") or []]
    lines += [f"- Feature: {f['feature']} (steps {', '.join(f['steps']) or 'none'})" for f in b.get("product", [])]
    return "\n".join(lines)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")



# The run report's fields (the owner's pick, 2026-11-15: "A + exact report fields"; the owner's words: "I want better
# report but not losing data"): what was built, the numbers with how each was measured, the tests with their result,
# and what is not done with its fix. The reply stays whole beside them.
REPORT_FIELDS = {"numbers": ("metric", "before", "after", "how"), "tests": ("method", "result"), "not_done": ("item", "fix")}


def clean_report(report: dict | None) -> dict:
    report = report or {}
    out: dict = {}
    built = [redact(str(x), 400) for x in report.get("built") or [] if str(x).strip()]
    if built:
        out["built"] = built[:30]
    for k, keys in REPORT_FIELDS.items():
        rows = []
        for r in report.get(k) or []:
            if not isinstance(r, dict):
                raise ValueError(f"{k}: each row is an object with " + ", ".join(keys))
            row = {key: redact(str(r.get(key) or ""), 400) for key in keys}
            if row[keys[0]].strip():
                rows.append(row)
        if rows:
            out[k] = rows[:40]
    return out


def report_text(rep: dict) -> str:
    """The report as short lines: the inbox result's text."""
    if not rep:
        return ""
    lines = [f"- Built: {b}" for b in rep.get("built", [])]
    lines += [f"- {r['metric']}: {r['before'] or '-'} -> {r['after']} ({r['how']})" for r in rep.get("numbers", [])]
    lines += [f"- Test: {r['method']}: {r['result']}" for r in rep.get("tests", [])]
    lines += [f"- Not done: {r['item']}" + (f" -> {r['fix']}" if r["fix"] else "") for r in rep.get("not_done", [])]
    return chr(10).join(lines)

class Inbox:
    """Inbox operations on any store with get, update, put_many and where (Firestore, or a fake in tests)."""

    def __init__(self, store, machine: str, roots: list[tuple[str, str]], session_id: str, cwd: str, push=None):
        self.store, self.machine, self.roots = store, machine, roots
        self.session_id, self.cwd = session_id or "unknown", cwd
        # a push.Pusher: tells the owner's phone about each question, suggestion, result and plan version (the owner's
        # choice, 2026-11-01, "do #1 and #2"); approvals push from inbox_approve with the call in the body
        self.push = push
        self.beats = 0  # the heartbeat is made once; after that it is only updated, so a deleted one stays deleted

    def open_plan(self) -> dict | None:
        """This session's plan: the newest, open or closed. Closed is only a label the owner sets on the page; it never
        stops work on the plan (the owner's words, 2026-11-09: "make the close plan is just a status, phase can be move
        back and forth by me so no blocking my action"; choice "Join the newest plan, any status"). A plan moved to the
        latest format (upgradedTo) is left out: its work goes on in the new plan."""
        if self.session_id == "unknown":
            return None
        plans = [p for p in self.store.where("plans", "sessionId", self.session_id) if not p.get("upgradedTo")]
        return max(plans, key=lambda p: p.get("createdAt", ""), default=None)

    def plan_get(self, plan_id: str, part: str = "") -> dict:
        """G2 (the owner, 2026-11-18: "all 5 gap, fix one by one"): the plan as it is now, read from the store, so a fresh
        session (a handoff, a Together step) reads the parts instead of guessing them: the current version's six parts,
        the harness with the owner's ticks (approved: ticked and the text unchanged) and each step's last state.
        part: one part only (goal, summary, rules, lessons, leftover, steps, board, harness), to keep the reply small."""
        plan = self.store.get(f"plans/{plan_id}")
        if not plan:
            raise ValueError(f"no plan {plan_id}")
        n = plan.get("current", 0)
        v = self.store.get(f"planVersions/{plan_id}_v{n}") or {}
        parts = v.get("parts") or {}
        ticks = (self.store.get(f"planHarness/{plan_id}") or {}).get("items") or {}
        harness = [{**h, "approved": bool((ticks.get(h["id"]) or {}).get("ok")) and ticks[h["id"]].get("hash") == item_hash(h)}
                   for h in v.get("harness") or []]
        states = {st["id"]: (self.store.get(f"planSteps/{plan_id}_{st['id']}") or {}).get("state", "next")
                  for st in parts.get("steps") or []}
        out = {"plan": plan_id, "title": plan.get("title", ""), "phase": plan.get("phase") or "explore", "version": n}
        if part:
            if part == "harness":
                return {**out, "harness": harness}
            if part not in parts:
                raise ValueError(f"no part {part}: the parts are {', '.join(parts) or 'none'}, or harness")
            return {**out, part: parts[part], **({"stepStates": states} if part == "steps" else {})}
        if not parts:
            out["text"] = v.get("text", "")
        return {**out, "parts": parts, "harness": harness, "stepStates": states}

    def refuse_bad_sources(self, parts: dict) -> None:
        """Each board source id points to something real (plan 44fc4979 s3): a KB record in the store, a file on this
        PC (with :line, a line it has). Nothing is saved when one does not."""
        src = ((parts or {}).get("board") or {}).get("src") or {}
        ids = list(dict.fromkeys([*(src.get("whatFor") or []), *[x for s in src.get("idea") or [] for x in s]]))
        bad = []
        for sid in ids:
            kind = src_kind(sid)
            if kind == "record" and not self.store.get(f"records/{sid}"):
                bad.append(f"{sid} (no such record)")
            elif kind == "file":
                m = SRC_FILE.match(sid)
                path, line, quote = m.group("path"), m.group("line"), src_quote(m)
                if not os.path.isfile(path):
                    bad.append(f"{sid} (no such file)")
                elif quote:
                    with open(path, encoding="utf-8", errors="replace") as fh:
                        if quote not in fh.read():
                            bad.append(f"{sid} (the file does not hold these words)")
                elif line:
                    with open(path, encoding="utf-8", errors="replace") as fh:
                        count = sum(1 for _ in fh)
                    if not 1 <= int(line) <= count:
                        bad.append(f"{sid} (the file has {count} lines)")
        if bad:
            raise ValueError("board sources that point to nothing: " + "; ".join(bad) + ". Nothing was saved.")

    def plan_start(self, title: str, text: str = "", note: str = "", parts: dict | None = None, source: str = "",
                   harness: list | None = None) -> str:
        """parts: the six parts of v1. source: the id of the dashboard command that read a session for this plan.
        A new plan starts in the latest format, the six parts (the owner's words, 2026-11-07: "make sure that any new
        plan will goes witb the latest version of plan"): a plan with text only is refused."""
        if parts is None:
            raise ValueError("A new plan starts in the latest format: give the six parts (goal, summary, rules, "
                             "lessons, leftover, steps). A plan with text only is no longer opened.")
        plan_id = uuid.uuid4().hex[:20]
        doc = {
            "id": plan_id, "title": redact(title, 200), "sessionId": self.session_id, "machine": self.machine,
            "cwd": self.cwd, "workType": work_type_of(self.cwd, self.roots), "status": "open", "current": 0,
            "createdAt": now_iso(), "updatedAt": now_iso(), "phase": PHASES[0], "format": PLAN_FORMAT,
        }
        if parts is not None:
            parts = clean_parts(parts)
            doc["kind"] = "parts"
        # every file link opens on the dashboard (filelinks.py); checked before the plan is made
        refuse_dead_links(text if text.strip() else parts_markdown(parts or {}), self.cwd, [r for _, r in self.roots])
        if source:
            c = self.store.get(f"commands/{source}") or {}
            if c.get("action") == "plan":
                doc.update(kind="parts", source={"sessionId": c.get("sourceSessionId", ""), "commandId": source,
                                                 "pagesDir": c.get("pagesDir", ""), "pages": c.get("pages") or []})
                self.store.update(f"commands/{source}", {"planId": plan_id})
        self.store.put_many({f"plans/{plan_id}": doc})
        if parts is not None or text.strip():
            self.plan_version(plan_id, text, note, parts=parts, harness=harness)
        return plan_id

    def running_command(self) -> dict | None:
        """The dashboard run working in this session now, if any."""
        if self.session_id == "unknown":
            return None
        rows = [c for c in self.store.where("commands", "sessionId", self.session_id)
                if c.get("status") == "running" and c.get("action") in ("message", "start", "plan")]
        return max(rows, key=lambda c: c.get("startedAt", ""), default=None)

    def headline(self, now: str, next_: str = "", done: int | None = None, total: int | None = None,
                 eta_minutes: float | None = None) -> dict:
        """F2 (plan bf73af63; the source rule, rules-review.md section 15: "Update the headline at least every 5 minutes:
        what you're doing now and next. Heavy work shows a percentage plus done/total units and an ETA"): the running
        dashboard run's headline, written by its session onto its run row. The percentage comes from done/total; the
        ETA is a clock time from the minutes the session gives."""
        now = " ".join(str(now or "").split())[:200]
        if not now:
            raise ValueError("headline needs now: what you are doing now")
        if (done is None) != (total is None):
            raise ValueError("give done and total together, or neither")
        if total is not None and (total <= 0 or done < 0 or done > total):
            raise ValueError("done and total: 0 <= done <= total, total > 0")
        run = self.running_command()
        if not run:
            raise ValueError("No dashboard run is going in this session: the headline shows on a run row only.")
        at = datetime.now(timezone.utc)
        h = {"now": redact(now, 200), "next": redact(" ".join(str(next_ or "").split())[:200], 200), "at": now_iso()}
        if total is not None:
            h.update(done=int(done), total=int(total), pct=round(100 * done / total))
        if eta_minutes is not None and eta_minutes >= 0:
            h["eta"] = (at + timedelta(minutes=float(eta_minutes))).isoformat(timespec="seconds").replace("+00:00", "Z")
        self.store.update(f"commands/{run['id']}", {"headline": h})
        return {"run": run["id"], **h}

    def plan_version(self, plan_id: str, text: str, note: str = "", parent: int | None = None,
                     answers: list[str] | None = None, parts: dict | None = None, change: str = "",
                     phase: str = "", order: str = "", harness: list | None = None) -> int:
        """Saves the next version of a plan and returns its number. Questions asked from now on are its round.

        parent: the version this one grows from (default: the current one; an older one makes a branch).
        answers: the inbox ids of the answers that made it (default: the answered questions asked on the parent).
        Each answer is kept as it was then, so a branch made before a reopen still shows the old answer.
        phase: a move to another phase, only on the owner's order: order is the owner's words (a dashboard message's
        own text is used when there is one). With no text and no parts, the version copies its parent's (a plain version).
        Every version carries the plan's phase. harness: the whole harness list; left out, the parent's list is kept.
        """
        plan = self.store.get(f"plans/{plan_id}")
        if not plan:
            raise ValueError(f"no plan {plan_id}")
        run = self.running_command()
        if run and run.get("kind") in NO_PLAN_CHANGE and not run.get("switchedTo"):
            raise ValueError(f"This is a {KINDS[run['kind']]} message: it never changes the plan. If the plan needs a "
                             "change, ask the owner with plan_switch first.")
        if run and run.get("kind") in KINDS and not change:
            change = run.get("switchedTo") or run["kind"]
        was = plan.get("phase") or PHASES[0]
        phase = (phase or "").strip().lower() or was
        if phase not in PHASES:
            raise ValueError(f"no phase {phase!r}; the phases are {', '.join(PHASES)}")
        order = (order or (run or {}).get("ownerText") or "").strip()
        if phase != was and not order:
            raise ValueError("Only the owner moves a phase. Move it when the owner orders it, and give the owner's "
                             "words as order.")
        current = int(plan.get("current", 0))
        parent = current if parent is None else parent
        if not 0 <= parent <= current:
            raise ValueError(f"plan {plan_id} has no version {parent}")
        given = parts is not None or bool(text.strip())  # the session's own data: its file links are checked
        if parts is None and not text.strip() and phase != was:  # a plain version: the parent's data, a new phase
            base = self.store.get(f"planVersions/{plan_id}_v{parent}") or {}
            parts, text = base.get("parts"), base.get("text", "")
        if harness is None:  # kept from the version it grows from, so a plain or a data version keeps the list
            harness = (self.store.get(f"planVersions/{plan_id}_v{parent}") or {}).get("harness") if current else None
        harness = clean_harness(harness)
        checks = None
        if parts is not None:
            parts = clean_parts(parts)
            self.refuse_bad_sources(parts)
            # a version never loses the board its parent had (the owner's words, 2026-11-12: "I don't want to meet
            # this kind of mistake and lost my progress")
            had = ((self.store.get(f"planVersions/{plan_id}_v{parent}") or {}).get("parts") or {}).get("board") if current else None
            if had and not parts.get("board"):
                raise ValueError("The parent version has a board (what_for, idea, product); send it again in parts.board. "
                                 "Nothing was saved.")
            # step s8: the parts of a plan read from a session are checked against its record; bad #n and quotes marked
            parts, checks = check_parts(parts, (plan.get("source") or {}).get("pagesDir", ""))
            text = text if text.strip() else parts_markdown(parts)
        if given:  # every file link opens on the dashboard (filelinks.py)
            refuse_dead_links(text, plan.get("cwd") or self.cwd, [r for _, r in self.roots])
        asked = {i["id"]: i for i in self.store.where("inbox", "planId", plan_id)}
        if answers is None:
            answers = [k for k, i in asked.items() if int(i.get("round", 0)) == parent and i.get("answer")]
        made_by = [{"id": k, "title": asked[k].get("title", ""), "choice": (asked[k].get("answer") or {}).get("choice", ""),
                    "text": (asked[k].get("answer") or {}).get("text", "")} for k in answers if k in asked]
        # a plan's numbers only grow, so a branch from an old version still gets the next number
        n = int(plan.get("last", current)) + 1
        version = {
            "id": f"{plan_id}_v{n}", "planId": plan_id, "n": n, "parent": parent, "madeBy": made_by,
            "text": redact(text, 30000), "note": redact(note, 400), "createdAt": now_iso(), "phase": phase,
        }
        if phase != was:
            version["phaseMove"] = {"from": was, "to": phase, "order": redact(order, 2000)}
            if phase == "build" and harness:
                version["phaseMove"]["harness"] = harness_split(harness, self.store.get(f"planHarness/{plan_id}"))
        if checks and checks["refs"] + checks["quotes"]:
            version["checks"] = checks
        if parts is not None:
            version["parts"] = parts
            # s5: the auto rule check B1 to B10 on every version with a board; saved with a red flag, never refused
            # (the owner's pick "Save + red flag"; refusing is open: "refuse will come when I decide later")
            bc = check_board(parts.get("board"))
            if bc:
                version["boardCheck"] = bc
        if harness:
            version["harness"] = harness
        if change in KINDS:
            version["change"] = {"kind": change, "message": redact((run or {}).get("ownerText") or (run or {}).get("prompt", ""), 2000)}
        self.store.put_many({f"planVersions/{plan_id}_v{n}": version})
        self.store.update(f"plans/{plan_id}", {"current": n, "last": n, "chosen": n, "updatedAt": now_iso(), "phase": phase})
        if self.push is not None:
            self.push.notify(f"Plan v{n}: {plan.get('title', '')}", note or "New version.", f"/?plan={plan_id}", f"plan-{plan_id}")
        return n

    def step_update(self, plan_id: str, step_id: str, state: str, reply: str, check_command: str = "",
                    evidence: list[str] | None = None, report: dict | None = None) -> int:
        """A step version: the step's state and the session's reply on it. Never a plan version (the owner's words:
        "not moving step"). Questions asked while a step is "now" join that step. Returns the step version number."""
        if state not in STEP_STATES:
            raise ValueError("state is one of " + ", ".join(STEP_STATES))
        rep = clean_report(report)
        if state == "done" and (not rep.get("numbers") or not rep.get("tests")):
            raise ValueError("A done report needs its numbers (metric, before, after, how measured) and its tests (method, "
                             "result), the owner's pick 2026-11-15 \"A + exact report fields\". Add them and report again.")
        plan = self.store.get(f"plans/{plan_id}")
        if not plan:
            raise ValueError(f"no plan {plan_id}")
        v = self.store.get(f"planVersions/{plan_id}_v{plan.get('current', 0)}") or {}
        steps = {st["id"]: st for st in (v.get("parts") or {}).get("steps") or []}
        if step_id not in steps:
            raise ValueError(f"plan v{plan.get('current', 0)} has no step {step_id}; its steps: " + ", ".join(steps))
        # F4, done needs a receipt (plan bf73af63; the owner's picks 2026-11-13 "Check or checked pictures", 2026-11-19
        # "Done waits for its receipt"): a done report needs a ticked check or attached pictures; the step then waits as
        # "checking" until the bridge's check exits 0 (stepcheck.py) or the LLM check passes the pictures (evidence.py)
        from .evidence import add_set, on_done, pictures
        from .evidence import queue as evidence_queue
        from .stepcheck import CHECKING, propose, queue, ticked
        if check_command.strip():
            propose(self.store, plan_id, step_id, check_command.strip())
        has_check = state == "done" and ticked(self.store.get(f"planChecks/{plan_id}_{step_id}"))
        pics = pictures(evidence, plan.get("cwd", "")) if state == "done" else []
        if state == "done" and not has_check and not pics:
            raise ValueError("Done needs a receipt (the owner's picks 2026-11-13 \"Check or checked pictures\", 2026-11-19 "
                             "\"Done waits for its receipt\"): this step has no ticked check and the report attaches no "
                             "picture that exists. Propose a check_command and ask the owner to tick it, or attach the "
                             "pictures that show the step working (evidence=[paths]); then report done again.")
        cited = self.check_cites(state, reply, rep)
        saved = CHECKING if state == "done" else state
        path = f"planSteps/{plan_id}_{step_id}"
        versions = list((self.store.get(path) or {}).get("versions") or [])
        n = len(versions) + 1
        versions.append({"n": n, "state": saved, "reply": redact(reply, 8000), "at": now_iso(),
                         "planVersion": int(plan.get("current", 0)), **({"report": rep} if rep else {}),
                         **({"receiptBy": "check" if has_check else "pictures"} if state == "done" else {})})
        self.store.put_many({path: {"id": f"{plan_id}_{step_id}", "planId": plan_id, "stepId": step_id, "state": saved,
                                    "versions": versions, "updatedAt": now_iso()}})
        # step i8: a done report asks the bridge to run the ticked check
        if has_check:
            queue(self.store, {**plan, "id": plan_id}, step_id, "done", self.machine)
            # 8. Evidence, flow 1 (the owner's pick, 2026-11-12: "Attach, else picture run")
            on_done(self.store, {**plan, "id": plan_id}, step_id, evidence or [], n, self.machine)
        elif state == "done":  # F4: no ticked check: the LLM check on the attached pictures gives the receipt
            add_set(self.store, plan_id, step_id, pics, "report", "done", step_version=n)
            evidence_queue(self.store, {**plan, "id": plan_id}, step_id, "check", "receipt", self.machine)
        active = step_id if state == "now" else (None if plan.get("activeStep") == step_id else plan.get("activeStep"))
        self.store.update(f"plans/{plan_id}", {"activeStep": active, "updatedAt": now_iso()})
        if state in ("done", "failed"):
            # the report as a result to review in the inbox (the owner's choice, 2026-11-15: "v7 data + code fix"; the
            # owner's words: "the result report is not visible"); its push replaces the step's own push
            said = f"done, waiting for its receipt ({'the ticked check' if has_check else 'the LLM check of the pictures'})" if state == "done" else state
            self.result(f"Step {said}: {step_id} · {steps[step_id]['title']}", report_text(rep) or reply, evidence or [],
                        plan_id=plan_id, step_id=step_id, extra={"round": int(plan.get("current", 0)), "stepVersion": n})
        return n

    def check_cites(self, state: str, reply: str, rep: dict) -> list[str]:
        """KB first (plan bf73af63 F1, the mockup: "run must cite them"): a done or failed report of a run that was given
        records must cite every one of them (how it was used, or why it does not apply). Refused otherwise, with the ids.
        Returns the given ids (each counted as cited once on its record)."""
        if state not in ("done", "failed"):
            return []
        run = self.running_command() or {}
        given = list((run.get("kb") or {}).get("given") or [])
        if not given:
            return []
        from .records import Records

        rec = Records(self.store)
        missing = rec.check_cites(given, reply + " " + report_text(rep))
        if missing:
            raise ValueError(f"This run was given records {', '.join(given)} (KB first). Cite each in the reply: how it was "
                             f"used, or why it does not apply. Not cited: {', '.join(missing)}.")
        rec.count_cites(given)
        self.store.update(f"commands/{run['id']}", {"kb": {**run["kb"], "cited": given, "citedAt": now_iso()}})
        return given

    def ask_switch(self, to: str, change: str, why: str) -> str:
        """A Q&A or an Action run asks the owner to switch to a kind that changes the plan. Returns the question's id."""
        if to not in KINDS or to in NO_PLAN_CHANGE:
            raise ValueError("switch to one of: " + ", ".join(k for k in KINDS if k not in NO_PLAN_CHANGE))
        run = self.running_command() or {}
        opts = [{"label": f"Switch to {KINDS[to]}", "detail": "the session makes this change as a new plan version",
                 "differs": "the plan changes: a new version", "example": {"type": "text", "draft": change}},
                {"label": "Keep Q&A", "detail": "nothing changes", "differs": "the plan stays as it is",
                 "example": {"type": "text", "draft": "No change to the plan."}}]
        return self.post("question", f"Switch to {KINDS[to]}?", why, opts, 0,
                         extra={"switch": {"to": to, "commandId": run.get("id", "")}, "topic": "scope"})  # F7: a plan change is scope

    def confirm_switch(self, item_id: str) -> bool:
        """After the owner answered a switch question: unlocks plan_version for the run when the owner chose the switch."""
        item = self.store.get(f"inbox/{item_id}") or {}
        sw = item.get("switch") or {}
        ok = ((item.get("answer") or {}).get("choice") or "").startswith("Switch to")
        if ok and sw.get("commandId"):
            self.store.update(f"commands/{sw['commandId']}", {"switchedTo": sw.get("to")})
        return ok

    def post(self, kind: str, title: str, text: str, options: list[dict] | None = None,
             recommended: int | None = None, files: list[str] | None = None, extra: dict | None = None) -> str:
        item_id = uuid.uuid4().hex[:20]
        extra = dict(extra or {})
        if kind == "question" and "planId" not in extra:
            plan = self.open_plan()
            if plan:
                extra.update(planId=plan["id"], round=int(plan.get("current", 0)))
                if plan.get("activeStep"):
                    extra["stepId"] = plan["activeStep"]
        if kind == "question" and extra.get("planId"):
            bad = [f'"{o.get("label", "")}": {why}' for o in options or [] if (why := check_example(o.get("example")))]
            if not options or bad:
                raise ValueError("Every option of a plan question needs an example (the owner's rule). "
                                 + ("; ".join(bad) if bad else "Give options, each with an example."))
        # each option drawn, or at least its difference (the owner's words, 2026-11-07: "I want the question to have the
        # visualization ... or at least give me the different between each answer"); the question box has neither
        if kind == "question" and extra.get("via") != "hook" and options:
            plain = [o.get("label", "") for o in options
                     if not str(o.get("differs") or "").strip() and (o.get("example") or {}).get("type") not in ("visual", "image")]
            if plain:
                raise ValueError("Every option needs a drawing (example type visual) or a differs line: what is "
                                 "different about it, in a few words. Missing on: " + ", ".join(plain))
        opts = [{"label": redact(o.get("label", ""), 120), "detail": redact(o.get("detail", ""), 400),
                 **({"differs": redact(str(o["differs"]), 160)} if o.get("differs") else {}),
                 **({"example": clean_example(o["example"])} if o.get("example") else {})} for o in options or []]
        if recommended is not None and not 0 <= recommended < len(opts):
            recommended = None
        # F7: every inbox item is the owner's: a question carries its owner topic (scope, policy, approval, spend), a
        # question from the hook "hook", other items their kind. A coordinator question never comes here
        # (coordinator.py).
        if extra.get("route", "owner") != "owner":
            raise ValueError("Only owner items go to the owner's inbox; a coordinator question goes to the plan's session.")
        extra.update(route="owner", topic=extra.get("topic") or ("hook" if extra.get("via") == "hook" else kind))
        self.store.put_many({f"inbox/{item_id}": {
            "id": item_id,
            "kind": kind,
            "sessionId": self.session_id,
            "machine": self.machine,
            "cwd": self.cwd,
            "workType": work_type_of(self.cwd, self.roots),
            "title": redact(title, 200),
            "text": redact(text, 4000),
            "options": opts,
            "recommended": recommended,
            "files": [redact(f, 300) for f in files or []],
            "status": "open",
            "createdAt": now_iso(),
            "answer": None,
            **extra,
        }})
        if extra.get("planId"):
            self.store.update(f"plans/{extra['planId']}", {"updatedAt": now_iso()})
        if self.push is not None and kind in PUSH_TITLE:
            first = next((line for line in text.splitlines() if line.strip()), "")
            body = ("Answer within 10 minutes, or the session asks there. " if extra.get("via") == "hook" else "") + first
            self.push.notify(f"{PUSH_TITLE[kind]}: {title}", body[:200] or title, f"/?item={item_id}", item_id)
        return item_id

    def result(self, title: str, text: str, files: list[str] | None = None, plan_id: str = "", step_id: str = "",
               edit_of: str = "", extra: dict | None = None) -> tuple[str, int]:
        """F12, one result per item, later ones edit it (plan bf73af63; the owner's picks 2026-11-19 "Start F12, build
        now", "Same plan step"). The item is the plan step: a result on a step edits that step's newest result (any
        session, so a handoff keeps one card); a result with no step edits edit_of when given, else it is a new card.
        The edit keeps the earlier title, text, files, status and answer as a version, opens the card again for review
        and pushes it as edited. plan_id / step_id default to the dashboard run's step. Returns (item id, version)."""
        if not (plan_id and step_id):
            c = self.running_command() or {}
            plan_id = plan_id or str(c.get("planId") or "")
            step_id = step_id or (str(c.get("stepId") or "") if c.get("planId") == plan_id else "")
        if step_id and not plan_id:
            raise ValueError("step needs its plan: this session has no dashboard run on a plan step; give plan_id.")
        old = None
        if edit_of:
            old = self.store.get(f"inbox/{edit_of}")
            if not old or old.get("kind") != "result":
                raise ValueError(f"No result {edit_of} to edit.")
        elif plan_id and step_id:
            same = [i for i in self.store.where("inbox", "planId", plan_id)
                    if i.get("kind") == "result" and i.get("stepId") == step_id]
            old = max(same, key=lambda i: i.get("editedAt") or i.get("createdAt", ""), default=None)
        ex = {**(extra or {}), **({"planId": plan_id} if plan_id else {}), **({"stepId": step_id} if step_id else {})}
        if not old:
            return self.post("result", title, text, files=files, extra=ex), 1
        at = now_iso()
        keep = ("title", "text", "files", "status", "answer", "sessionId", "deliveredAt", "deliveredVia")
        versions = list(old.get("versions") or []) + [
            {**{k: old.get(k) for k in keep}, "at": old.get("editedAt") or old.get("createdAt"), "n": int(old.get("version") or 1)}]
        n = len(versions) + 1
        ex.pop("route", None)
        self.store.update(f"inbox/{old['id']}", {
            **ex, "title": redact(title, 200), "text": redact(text, 4000), "files": [redact(f, 300) for f in files or []],
            "status": "open", "answer": None, "deliveredAt": None, "deliveredVia": None, "commandId": None, "waitReason": None,
            "error": None, "sessionId": self.session_id, "machine": self.machine, "cwd": self.cwd, "editedAt": at,
            "version": n, "versions": versions[-20:]})
        if plan_id:
            self.store.update(f"plans/{plan_id}", {"updatedAt": at})
        if self.push is not None:
            first = next((line for line in text.splitlines() if line.strip()), "")
            self.push.notify(f"Result edited (v{n}): {title}", first[:200] or title, f"/?item={old['id']}", old["id"])
        return old["id"], n

    def withdraw(self, item_id: str, reason: str) -> str:
        """F12: a session withdraws its own moot question (the owner's words in the plan: "session withdraws a moot
        question"). Only an open question; only the session that asked it, or the session that holds its plan now
        (after a handoff). The item closes with the reason, so it leaves "waiting for you"; the old form stays.
        Returns "" when done, else why not."""
        if not reason.strip():
            return "Not withdrawn: give the reason it is moot."
        item = self.store.get(f"inbox/{item_id}")
        if not item or item.get("kind") != "question":
            return f"No question {item_id}."
        if item.get("status") != "open":
            return "Not withdrawn: the owner already answered it (status " + str(item.get("status")) + ")."
        plan = self.store.get(f"plans/{item['planId']}") if item.get("planId") else None
        if self.session_id not in (item.get("sessionId"), (plan or {}).get("sessionId")):
            return "Only the session that asked, or the session holding its plan, can withdraw it."
        at = now_iso()
        self.store.update(f"inbox/{item_id}", {"status": "closed", "waitReason": None,
                                               "withdrawn": {"at": at, "reason": redact(reason, 600), "by": self.session_id}})
        return ""

    def post_batch(self, questions: list[dict], via: str = "") -> list[str]:
        """Questions asked together are one batch (the owner's words, 2026-11-07: "group the questions in the same batch,
        instead of current flow is 3 questions from the same batch/session/message became 3 items in inbox"): one inbox
        entry on the page, answered together. Each question keeps its own record, so rounds and answers stay per
        question. questions: [{"title", "text", "options", "recommended", "extra"}]."""
        batch = uuid.uuid4().hex[:12]
        return [self.post("question", q.get("title") or q.get("text", "")[:80], q.get("text", ""), q.get("options"),
                          q.get("recommended"), extra={**(q.get("extra") or {}), **({"via": via} if via else {}),
                                                       "batchId": batch, "batchIndex": k, "batchSize": len(questions)})
                for k, q in enumerate(questions)]

    def ask_back(self, item_id: str) -> dict | None:
        """The owner's newest question back on an item that the session has not replied to yet (the ping-pong)."""
        return open_ask((self.store.get(f"inbox/{item_id}") or {}).get("thread") or [])

    def reply(self, item_id: str, text: str) -> bool:
        """The session's short reply to the owner's question back; it never answers the question for the owner. Only
        its length is stored: the page reads the words from this session's log on the PC (texts.py, the owner's
        choice, 2026-11-08: "From the PC too")."""
        item = self.store.get(f"inbox/{item_id}")
        if not item:
            return False
        thread = list(item.get("thread") or []) + [{"who": "session", "kind": "reply", "chars": len(text), "at": now_iso()}]
        return self.store.update(f"inbox/{item_id}", {"thread": thread})

    def redraw(self, item_id: str, note: str, question: str | None = None, options: list[dict] | None = None,
               option: int | None = None, svg: str | None = None, recommended: int | None = None) -> str:
        """Changes one open question in place, during the ask back rounds (the owner's words, 2026-11-13: "I only as for
        1 question redraw not all questions"; "I want the ask can work on its question and images so I can alter the
        question and answer the most correct with the deepen question ask back rounds"). Only this item changes: the
        other questions of its batch and their saved answers stay. option + svg swaps one drawing; options replaces the
        whole list (same checks as inbox_ask); question replaces the text. The old form goes to revisions, the thread
        gets a session "redraw" entry (it answers the open ask back) and the item is marked redrawn. A saved answer on
        this question stays unless its picked option no longer exists. Returns "" when done, else why not."""
        item = self.store.get(f"inbox/{item_id}")
        if not item or item.get("kind") != "question":
            return f"No question {item_id}."
        if item.get("sessionId") != self.session_id:
            return "Only the session that asked can redraw its question."
        if item.get("status") != "open":
            return "The question is already answered; ask a new one instead."
        opts = [dict(o) for o in item.get("options") or []]
        changed = []
        if options is not None:
            bad = [f'"{o.get("label", "")}": {why}' for o in options if item.get("planId") and (why := check_example(o.get("example")))]
            plain = [o.get("label", "") for o in options if not str(o.get("differs") or "").strip()
                     and (o.get("example") or {}).get("type") not in ("visual", "image")]
            if not options or bad or plain:
                return ("Not redrawn: " + "; ".join(bad) if bad else "Not redrawn: every option needs a drawing (example type "
                        "visual) or a differs line. Missing on: " + ", ".join(plain or ["(no options)"]))
            opts = [{"label": redact(o.get("label", ""), 120), "detail": redact(o.get("detail", ""), 400),
                     **({"differs": redact(str(o["differs"]), 160)} if o.get("differs") else {}),
                     **({"example": clean_example(o["example"])} if o.get("example") else {})} for o in options]
            changed.append("options")
        if svg is not None:
            if option is None or not 0 <= option < len(opts):
                return f"Not redrawn: option is the index (0 to {len(opts) - 1}) of the drawing to swap."
            s = clean_svg(svg)
            if not s:
                return "Not redrawn: svg must be an inline <svg> drawing (under 30000 characters)."
            ex = dict(opts[option].get("example") or {})
            opts[option]["example"] = {"type": "visual", "svg": s, **({"note": ex["note"]} if ex.get("note") else {})}
            changed.append(f"drawing ({chr(97 + option)})")
        update: dict = {}
        if question is not None and question.strip():
            update["text"] = redact(question, 4000)
            changed.append("question")
        if not changed:
            return "Not redrawn: give question, options, or option + svg."
        if recommended is not None:
            update["recommended"] = recommended if 0 <= recommended < len(opts) else None
        elif options is not None and item.get("recommended") is not None and item["recommended"] >= len(opts):
            update["recommended"] = None
        at = now_iso()
        old = {k: item.get(k) for k in ("text", "options", "recommended")}
        update.update(options=opts, redrawn=at, revisions=list(item.get("revisions") or []) + [{**old, "at": at}])
        labels = {o["label"] for o in opts}
        draft = item.get("draft") or {}
        if draft.get("choice") and not set(draft["choice"].split(", ")) <= labels:
            update["draft"] = None  # the picked option is gone: this one question is answered again
            changed.append("saved pick cleared")
        text = redact(f"Redrew {', '.join(changed)}." + (f" {note.strip()}" if note.strip() else ""), 600)
        update["thread"] = list(item.get("thread") or []) + [{"who": "session", "kind": "redraw", "text": text, "at": at}]
        self.store.update(f"inbox/{item_id}", update)
        return ""

    def beat(self) -> None:
        if self.session_id == "unknown" or self.beats < 0:
            return
        path = f"liveSessions/{self.session_id}"
        if self.beats == 0:
            self.store.put_many({path: {"sessionId": self.session_id, "machine": self.machine, "cwd": self.cwd,
                                        "beatAt": now_iso()}})
        elif not self.store.update(path, {"beatAt": now_iso()}):
            self.beats = -1  # the owner deleted it: no more beats from this session
            return
        self.beats += 1

    def take_answer(self, item_id: str) -> str | None:
        """The owner's answer as text for the session, marking the item delivered; None while it is still open."""
        item = self.store.get(f"inbox/{item_id}")
        if not item or item.get("status") != "answered":
            return None
        try:  # the decision's pictures as they are at the answer (snapshot.py); never blocks the answer
            from .snapshot import take

            take(self.store, item)
        except OSError:
            pass
        self.store.update(f"inbox/{item_id}", {"status": "delivered", "deliveredAt": now_iso(), "deliveredVia": "live"})
        return answer_text(item)

    def other_replies(self, skip: str = "") -> list[str]:
        """Answers to this session's other items, so a live session picks them up on any inbox call."""
        out = []
        for item in self.store.where("inbox", "sessionId", self.session_id):
            if item.get("id") != skip and item.get("status") == "answered":
                text = self.take_answer(item["id"])
                if text:
                    out.append(text)
        return out


def approval_reply(item: dict | None, tool_input: dict) -> str:
    """The JSON a --permission-prompt-tool returns: allow with the input unchanged, or deny with the owner's note."""
    import json

    a = (item or {}).get("answer") or {}
    if a.get("choice") == "Allow":
        return json.dumps({"behavior": "allow", "updatedInput": tool_input})
    if item is None:
        return json.dumps({"behavior": "deny", "message": "No answer from the owner in time; the call was not run."})
    return json.dumps({"behavior": "deny", "message": "The owner denied this call." + (f" Note: {a['text']}" if a.get("text") else "")})


def answer_text(item: dict) -> str:
    a = item.get("answer") or {}
    kind = {"question": "your question", "suggestion": "your suggestion", "result": "your result"}.get(item.get("kind"), "")
    parts = [f'The owner answered {kind} "{item.get("title", "")}" on the dashboard.']
    if item.get("reopened") and item.get("planId"):
        was = (item.get("history") or [{}])[-1]
        parts = [f'The owner reopened "{item.get("title", "")}" in plan {item["planId"]} and changed the answer'
                 f' (it was: {was.get("choice") or was.get("text") or "no choice"}). Branch the plan: post a new version'
                 f' with plan_version(parent={int(item.get("round", 0))}) built on this answer.']
    if a.get("choice"):
        parts.append(f"Choice: {a['choice']}.")
    if a.get("text"):
        parts.append(f"Note: {a['text']}")
    if not a.get("choice") and not a.get("text"):
        parts.append("No note.")
    return " ".join(parts)


def open_ask(thread: list[dict]) -> dict | None:
    """The owner's newest question back in a thread with no session reply after it."""
    for e in reversed(thread):
        if e.get("who") == "session":
            return None
        if e.get("who") == "owner" and e.get("kind") == "ask":
            return e
    return None


def ask_back_text(item: dict, ask: dict) -> str:
    """The message a session gets when the owner asked back after its inbox_ask stopped waiting (the owner's choice,
    2026-11-08: "A, bridge delivers"). It is not an answer: the session replies in the thread, then waits again."""
    return (f'The owner asks back on your question "{item.get("title", "")}" (id {item.get("id", "")}) on the dashboard: '
            f'"{ask.get("text", "")}". This is not an answer. Reply in a few words with inbox_reply(item_id="{item.get("id", "")}", '
            f'text=...) (draw it with an svg when it can be drawn), or, when the owner wants the question, its options or '
            f'a drawing changed, change only this question in place with inbox_redraw(item_id="{item.get("id", "")}", ...) '
            f'(never a new batch); then call inbox_wait(item_id="{item.get("id", "")}") for the answers.')


def is_live(store, session_id: str) -> bool:
    beat = store.get(f"liveSessions/{session_id}")
    if not beat or not beat.get("beatAt"):
        return False
    age = datetime.now(timezone.utc) - datetime.fromisoformat(beat["beatAt"])
    return age.total_seconds() < LIVE_SECONDS


def server():
    """The MCP server each Claude Code session starts (stdio). Registered with `claude mcp add --scope user`."""
    import asyncio

    from mcp.server.mcpserver import Context, MCPServer

    from .auth import Session
    from .config import Config
    from .firestore import Firestore

    cfg = Config.load()
    from .push import pusher

    from .store import open_store

    store = open_store(cfg)
    push = pusher(store, cfg.owner_email)
    inbox = Inbox(store, cfg.machine, cfg.roots, os.environ.get("CLAUDE_CODE_SESSION_ID", ""), os.getcwd(), push)

    def beat_forever():
        while True:
            try:
                inbox.beat()
            except BaseException:
                pass
            time.sleep(BEAT_SECONDS)

    threading.Thread(target=beat_forever, daemon=True).start()

    mcp = MCPServer(
        "agent-inbox",
        instructions=(
            "The owner's dashboard inbox. Post a decision the owner must make with inbox_ask (give options and mark "
            "the one you recommend), a result to review with inbox_result, and an idea with inbox_suggest. For planning "
            "with rounds of questions, open a plan with plan_start, post each new version with plan_version. Only the "
            "owner closes or reopens a plan, on the page; closed is a label and never stops work on it. Every question "
            "you ask joins the round of your plan's current version. While a plan is yours, every option of every question carries an example (before and after pictures, a "
            "code diff with a benchmark, or a draft). A plan with parts makes a new version only when its data "
            "changes; report work on a step with step_update, which never makes a plan version. A plan has a phase: "
            "explore, build, verify, remove, optimize, done. Every plan starts in explore, where no step runs. Only the "
            "owner moves the phase, forward or back, with the phase buttons on the page: the bridge records that move "
            "itself as a plain version, never you. Only when the owner orders a move in a message, record it with "
            "plan_version(phase=..., order=the owner's words), a plain version. In explore, list the harness with plan_version(harness=[...]): the tools and "
            "context each step needs and each step's check; the owner approves every item on the page. While a "
            "dashboard run works, keep its headline current with headline (now, next; done/total and ETA for heavy "
            "work): at the start and at least every 5 minutes."
        ),
    )

    async def wait_for(item_id: str, minutes: float, ctx: Context) -> str:
        """Waits for the answer to item_id, or to every question of its batch. Returns early when the owner asks back."""
        minutes = max(1.0, min(minutes, MAX_WAIT_MINUTES))
        end = time.time() + minutes * 60
        step = 0
        first = await asyncio.to_thread(inbox.store.get, f"inbox/{item_id}") or {}
        ids = [item_id]
        if first.get("batchId"):
            ids = [i["id"] for i in sorted(await asyncio.to_thread(inbox.store.where, "inbox", "batchId", first["batchId"]),
                                           key=lambda i: i.get("batchIndex", 0))] or ids
        while time.time() < end:
            for i in ids:
                ask = await asyncio.to_thread(inbox.ask_back, i)
                if ask:
                    title = next((x.get("title", "") for x in [await asyncio.to_thread(inbox.store.get, f"inbox/{i}") or {}]), "")
                    return (f'The owner asks back on "{title}" (id {i}): "{ask.get("text", "")}". This is not an answer. '
                            f"Reply in a few words with inbox_reply(item_id=\"{i}\", text=...) (draw it with an svg when "
                            f"it can be drawn), or, when the owner wants this question, its options or a drawing "
                            f"changed, change only it in place with inbox_redraw(item_id=\"{i}\", ...) (never a new "
                            f"batch); then call inbox_wait(item_id=\"{item_id}\").")
            items = [await asyncio.to_thread(inbox.store.get, f"inbox/{i}") or {} for i in ids]
            if all(x.get("status") == "answered" or x.get("withdrawn") for x in items) and any(x.get("status") == "answered" for x in items):
                texts = [t for i in ids if (t := await asyncio.to_thread(inbox.take_answer, i))]
                extra = await asyncio.to_thread(inbox.other_replies, item_id)
                return "\n".join([*texts, *extra])
            step += 1
            try:
                await ctx.report_progress(step, None, "waiting for the owner's answer")
            except Exception:
                pass
            await asyncio.sleep(POLL_SECONDS)
        return (
            f"No answer yet after {minutes:.0f} minutes. The question stays open in the inbox (id {item_id}). "
            "Call inbox_wait with this id to keep waiting, or go on with other work. If this session closes, the "
            "answer will be delivered by resuming it."
        )

    async def wait_coordinator(ids: list[str], minutes: float, ctx: Context) -> str:
        """F7: waits for the plan session's answers to coordinator questions (coordinator.py)."""
        from . import coordinator as co
        minutes = max(1.0, min(minutes, MAX_WAIT_MINUTES))
        end, step, got = time.time() + minutes * 60, 0, {}
        while time.time() < end:
            for i in ids:
                if i not in got and (t := await asyncio.to_thread(co.take, inbox.store, i)):
                    got[i] = t
            if len(got) == len(ids):
                return "\n".join(got[i] for i in ids)
            step += 1
            try:
                await ctx.report_progress(step, None, "waiting for the coordinator (the plan's session)")
            except Exception:
                pass
            await asyncio.sleep(POLL_SECONDS)
        return "\n".join([*got.values(), f"No coordinator answer yet after {minutes:.0f} minutes for "
                          + ", ".join(i for i in ids if i not in got) + ". Call inbox_wait with the id to keep waiting."])

    @mcp.tool()
    async def inbox_ask(question: str, ctx: Context, title: str = "", options: list[dict] | None = None,
                        recommended: int | None = None, context: str = "", wait_minutes: float = MAX_WAIT_MINUTES,
                        more_questions: list[dict] | None = None, route: str = "") -> str:
        """Ask the owner on the dashboard and wait for the answer. Draw before you write: the owner reads pictures
        faster than words.

        options: a list of {"label": short choice, "detail": one line, "differs": what is different about this
        option, a few words on the same point for every option, "example": {...}}. Each option needs a drawing
        (example type visual) or a differs line. recommended: the index of the option you recommend. context: the
        facts the owner needs to decide. wait_minutes: up to 25; then call inbox_wait.
        more_questions: other questions asked together, each {"question", "title", "options", "recommended"}: the
        owner sees and answers them as one batch, and you get all the answers at once.
        The owner may ask back before answering: you then get their question; reply with inbox_reply, or change that
        one question in place with inbox_redraw (never a new batch), and wait again.

        example (required on every option while a plan is open), one of:
        {"type": "visual", "svg": an inline <svg> drawing of the option, small, labelled, no script};
        {"type": "image", "before": file path, "after": file path, "note": what to look at} (same view, with markers);
        {"type": "code", "diff": unified diff, "bench": [{"name", "before", "after", "measured": true|false,
         "source": the run that measured it}]} (say measured false for an estimate);
        {"type": "text", "draft": the draft text}.

        route (required, F7: ask the right party): who decides. scope, policy, approval or spend: only the owner
        decides; it goes to the owner's inbox. coordinator: GPU, host, job, CI, review, disk and agent conflicts; the
        plan's own session answers it and it never reaches the owner's inbox. Each of more_questions names its own
        route; one batch goes to one party (owner topics together, or coordinator questions together).
        """
        from . import coordinator as co
        try:
            party, ids = await asyncio.to_thread(co.ask, inbox, question, title, options, recommended, context,
                                                 more_questions, route)
        except ValueError as e:
            return f"Not asked: {e}"
        if party == co.COORDINATOR:
            return await wait_coordinator(ids, wait_minutes, ctx)
        item_id = ids[0]
        return await wait_for(item_id, wait_minutes, ctx)

    claims_box: list = []

    def claims():
        """F8: the claims client, made on first use (the control plane: Firestore; this box's copy: the store)."""
        if not claims_box:
            from .claims import Claims
            from .store import is_firestore
            control = store if is_firestore(store) else Firestore(Session(cfg))
            claims_box.append(Claims(control, store, cfg.machine))
        return claims_box[0]

    @mcp.tool()
    async def claim(step: str = "", folder: str = "", release: bool = False) -> str:
        """Claim a step of your plan, or a folder, for this box before you work on it (F8, rules-review: "Claim every
        gap you work on"). A claim held by another box refuses you with its box, session and time: then do not work
        on it. step: a step id of this session's plan; folder: a full path. release: drop your claim. Your claims also
        go when your run ends."""
        from .claims import folder_key, holder_text, step_key
        plan = await asyncio.to_thread(inbox.open_plan) if step else None
        if step and not plan:
            return "No plan in this session: claim a folder instead."
        try:
            if release:
                key = step_key(plan["id"], step) if step else folder_key(folder)
                ok = await asyncio.to_thread(claims().release, key)
                return f"Released {key}." if ok else f"No claim of this box on {key}."
            ok, held = await asyncio.to_thread(claims().take, "step" if step else "folder", inbox.session_id, "",
                                               "session", plan["id"] if plan else "", step, folder)
        except ValueError as e:
            return f"Not claimed: {e}"
        except SystemExit as e:  # Firestore refused: the control plane is down
            return f"Not claimed: the control plane did not answer ({str(e)[:160]})."
        return (f"Claimed {held['key']} for box {held['machine']}." if ok
                else f"Refused: {holder_text(held)}. Do not work on it.")

    @mcp.tool()
    async def inbox_reply(item_id: str, text: str) -> str:
        """Reply to the owner's question back on an inbox question: a few words (an svg drawing in the text is fine
        when it explains better). It never answers the question for the owner. Then call inbox_wait."""
        ok = await asyncio.to_thread(inbox.reply, item_id, text)
        return "Replied. Call inbox_wait to wait for the answer." if ok else f"No question {item_id}."

    @mcp.tool()
    async def inbox_redraw(item_id: str, note: str = "", question: str | None = None, options: list[dict] | None = None,
                           option: int | None = None, svg: str | None = None, recommended: int | None = None) -> str:
        """Change one open question in place when the owner asks back for it (a new drawing, a sharper question,
        better options). Only this question changes: the rest of its batch and the owner's saved answers stay; never
        post a new inbox_ask for this. option + svg: swap the drawing of option number option (0 = a). options: the
        whole new option list (same form and checks as inbox_ask). question: the new question text. note: a few words
        on what changed, shown in the thread. The question is marked redrawn, its old form kept. Then call inbox_wait."""
        why = await asyncio.to_thread(inbox.redraw, item_id, note, question, options, option, svg, recommended)
        return why or "Redrawn in place. Call inbox_wait to wait for the answer."

    @mcp.tool()
    async def inbox_wait(item_id: str, ctx: Context, wait_minutes: float = MAX_WAIT_MINUTES) -> str:
        """Keep waiting for the answer to an earlier inbox_ask (the owner's, or the coordinator's)."""
        if await asyncio.to_thread(inbox.store.get, f"coordinator/{item_id}"):
            return await wait_coordinator([item_id], wait_minutes, ctx)
        return await wait_for(item_id, wait_minutes, ctx)

    # Text only: Claude Code refuses a permission answer that also carries structured content ("Expected a single text
    # block param"), which the SDK adds to any tool returning str unless told not to.
    @mcp.tool(structured_output=False)
    async def inbox_approve(tool_name: str, input: dict, tool_use_id: str = "") -> str:
        """Permission prompt for runs started from the dashboard: the owner allows or denies the call in the inbox."""
        import json

        item_id = await asyncio.to_thread(
            inbox.post, "approval", f"Allow {tool_name}?", json.dumps(input, indent=1, ensure_ascii=False)[:3500],
            [{"label": "Allow", "detail": "run this call"}, {"label": "Deny", "detail": "the session is told it was denied"}],
        )
        what = input.get("command") or input.get("description") or input.get("file_path") or json.dumps(input, ensure_ascii=False)
        await asyncio.to_thread(push.notify, f"Approval needed: {tool_name}", str(what)[:160], f"/?item={item_id}", item_id)
        end = time.time() + MAX_WAIT_MINUTES * 60
        while time.time() < end:
            item = await asyncio.to_thread(inbox.store.get, f"inbox/{item_id}")
            if item and item.get("status") == "answered":
                await asyncio.to_thread(inbox.store.update, f"inbox/{item_id}",
                                        {"status": "delivered", "deliveredAt": now_iso(), "deliveredVia": "live"})
                return approval_reply(item, input)
            await asyncio.sleep(POLL_SECONDS)
        await asyncio.to_thread(inbox.store.update, f"inbox/{item_id}", {"status": "closed", "error": "No answer in time; denied."})
        return approval_reply(None, input)

    @mcp.tool()
    async def plan_start(title: str, text: str = "", note: str = "", parts: dict | None = None, source: str = "",
                         harness: list | None = None) -> str:
        """Open a plan on the dashboard, always in the latest format: parts is required (a plan with text only is
        refused). text: an extra markdown note for version 1, if you have one. Questions you ask with inbox_ask
        (or your question box) while the plan is open join it, in the round of its current version.

        parts: the six parts of a plan from a session, in this order: {"goal": markdown (quote the owner), "summary":
        markdown (cite log entries as #n), "rules": [{"rule", "source"}], "lessons": [{"lesson", "taught_by",
        "applied_in"}], "leftover": [text], "steps": [{"id", "title", "does", "check", "new": true for work the record does not hold}],
        "board": {"what_for": one line, what the plan is for, "idea": [short lines, how], "product": [{"feature": the
        final product's feature, short, "steps": [the step ids that build it]}], "materials": [{"name", "path": the
        full path (none for a material the owner gave as text), "kind": "story" (story text), "material" (the
        owner's material, references, logs) or "file" (maps, pictures, tools), "note"}]}}. The board is the plan's
        main look: the page colors each feature from its steps' states. materials: the latest version of each file,
        material and story of the plan, one entry each (the owner's words, 2026-11-17: "only keep the latest version
        of each file/material and stories"); the bridge keeps the newest vN of a family. Send it again with every
        version, updated. Sources (the owner's picks, 2026-11-19: "Source chip per line", "Source field per line"):
        what_for and each idea line may be {"text", "src": [ids]}; an id is a part (goal, summary, rules, lessons,
        leftover, steps), a step id, a KB record (dec:N, rule:N, find:N, att:N, les:N) or a full file path
        (path#"quoted words" for a feedback log row, which never drifts; path:line for one line). Each id must exist; a line with no src shows a red "no source" chip.
        idea_groups (plan 44fc4979 s7, the owner's pick "By meaning", rule B2 chunks of 4): when idea has over 4
        lines, name its sub-groups in order, [{"head": a short heading that starts with an information word,
        "count": lines in it, 1 to 4}], counts adding up to the idea lines; the page heads each group with it.
        source: the command id the dashboard gave you when it asked for a plan from a session."""
        try:
            plan_id = await asyncio.to_thread(inbox.plan_start, title, text, note, parts, source, harness)
        except ValueError as e:
            return f"Not opened: {e}"
        plan = await asyncio.to_thread(inbox.store.get, f"plans/{plan_id}")
        return f"Opened plan {plan_id} at version {plan.get('current', 0)}." + (NO_BOARD if parts and not parts.get("board") else "")

    @mcp.tool()
    async def plan_version(note: str, text: str = "", plan_id: str = "", parent: int = -1, parts: dict | None = None,
                           phase: str = "", order: str = "", harness: list | None = None) -> str:
        """Post the next version of the plan (the whole text, markdown, or for a plan with parts the whole six parts).
        Only when the plan's data changes; a step moving is step_update. note: one line on what changed and which
        answers or message caused it. plan_id: this session's plan when empty. parent: the version it grows
        from; leave it out for the current one, or give an older one when the owner reopened an answer (a branch).
        phase: explore, build, verify, remove, optimize or done. Only the owner moves a phase, forward or back. A move
        from the page's phase buttons is recorded by the bridge, not here; when the owner orders a move in a message,
        call this with phase and order (the owner's words), and leave text and parts out for a plain
        version that keeps the data. harness: the whole harness list, each {"id": "h1", "item", "kind": "tool" or
        "check"}: the tools and context each step needs, and each step's check; the owner approves every item on the
        page. Left out, the list stays as it was. parts.board (see plan_start): send it with every parts version;
        a version that drops the board its parent had is refused. Before each version, read the board again against
        the goal, the steps and the step results, and adjust What for, Idea and the features (the owner's words,
        2026-11-16: "in new version you should look back and adjust the What for, Idea and 8 features ... Don't let
        the dashboard out of date in any kind")."""
        plan_id = plan_id or ((await asyncio.to_thread(inbox.open_plan)) or {}).get("id", "")
        if not plan_id:
            return "No plan in this session. Open one with plan_start."
        try:
            n = await asyncio.to_thread(inbox.plan_version, plan_id, text, note, None if parent < 0 else parent, None, parts,
                                      "", phase, order, harness)
        except ValueError as e:
            return str(e)
        out = f"Saved version {n} of plan {plan_id}. Questions asked from now on are round {n}."
        saved = (await asyncio.to_thread(inbox.store.get, f"planVersions/{plan_id}_v{n}")) or {}
        if saved.get("parts") and not saved["parts"].get("board"):
            out += NO_BOARD
        elif saved.get("parts"):
            was = ((await asyncio.to_thread(inbox.store.get, f"planVersions/{plan_id}_v{saved.get('parent')}")) or {}).get("parts") or {}
            if was.get("board") == saved["parts"]["board"] and (was.get("goal") != saved["parts"]["goal"] or was.get("steps") != saved["parts"]["steps"]):
                out += (" The goal or the steps changed but the board did not: read What for, Idea and the features "
                        "again and post a version that adjusts them, if they no longer match.")
        split = saved.get("phaseMove", {}).get("harness")
        if split:
            out += (" Build uses only the approved harness items: " + (", ".join(split["approved"]) or "none")
                    + ". Not approved, left out of Build: " + (", ".join(split["notApproved"]) or "none") + ".")
        return out

    @mcp.tool()
    async def step_update(step_id: str, state: str, reply: str, plan_id: str = "", check_command: str = "",
                          evidence: list[str] | None = None, built: list[str] | None = None,
                          numbers: list[dict] | None = None, tests: list[dict] | None = None,
                          not_done: list[dict] | None = None) -> str:
        """Report on one step of the plan: state next, now, done or failed, and your reply (what was done, the
        numbers, what is open). A step version; never a plan version. Questions asked while a step is now join it.
        check_command: propose one PowerShell command that checks this step (run in the plan's folder, 10 min max,
        exit 0 = pass). The bridge runs it only after the owner ticks it on the page, on each done report and on the
        page's Run check; a non-zero exit after done turns the step failed.
        Done needs a receipt (F4): a done report needs a ticked check or attached pictures, else it is refused. The step
        then shows "checking" until the bridge settles it: the ticked check exits 0, or (no ticked check) the LLM check
        passes the pictures -> done with its receipt; anything else -> failed.
        evidence: on a done report, the paths of the pictures that show the step's feature working (screenshots,
        renders), taken before reporting; the owner wants pictures, not text. None attached: the bridge starts a
        picture run.
        The run report card (required on done, the owner's pick "A + exact report fields"):
        built: short lines, what was built (files, commit).
        numbers: [{"metric", "before", "after", "how"}]: each measured number, before and after ("" when none), and how
        it was measured; at least one on done.
        tests: [{"method", "result"}]: each test or check run and its result ("pytest tests/x.py", "16 pass"); at least
        one on done.
        not_done: [{"item", "fix"}]: what is not done and the suggestion or question to solve it."""
        plan_id = plan_id or ((await asyncio.to_thread(inbox.open_plan)) or {}).get("id", "")
        if not plan_id:
            return "No plan in this session."
        try:
            report = {"built": built, "numbers": numbers, "tests": tests, "not_done": not_done}
            n = await asyncio.to_thread(inbox.step_update, plan_id, step_id, state, reply, check_command, evidence, report)
        except ValueError as e:
            return str(e)
        return f"Saved step version {n} of {step_id} ({state})."

    @mcp.tool()
    async def headline(now: str, next: str = "", done: int | None = None, total: int | None = None,
                       eta_minutes: float | None = None) -> str:
        """While a dashboard run works in this session: set its headline on the owner's Runs tab. Call it when the run
        starts and again at least every 5 minutes, and when the work moves on. now: what you are doing now; next: what
        comes next. Heavy work also gives done and total (units: files, tests, steps; the page shows done/total and %)
        and eta_minutes (minutes left; the page shows the clock time). A headline older than 5 minutes shows as stale."""
        try:
            h = await asyncio.to_thread(inbox.headline, now, next, done, total, eta_minutes)
        except ValueError as e:
            return str(e)
        return f"Headline set on run {h['run']}."

    # Records with ids (plan bf73af63 F1, the owner's pick "Best"): the knowledge base sessions write and read.
    from .records import Records, Refused, TYPES as RECORD_TYPES

    records = Records(store, by=inbox.session_id)

    @mcp.tool()
    async def record_add(type: str, text: str, words: str = "", why: str = "", outcome: str = "", source: str = "",
                         area: str = "", plan: str = "", step: str = "", files: list[str] | None = None,
                         supersedes: list[str] | None = None, duplicate_of: str = "", new: bool = False,
                         new_reason: str = "") -> str:
        """Add a record to the knowledge base; returns its id (dec:N, att:N, les:N, rule:N, find:N).
        type: dec (a decision given to you: put the owner's exact words in words), att (an attempt: record it when you
        build a design and again with outcome accepted or rejected and why), les (a lesson), rule, find (a finding).
        Read near records first (record_query). The KB refuses: a repeat of a rejected attempt without new_reason (the
        refusal names its id); a near-duplicate unless duplicate_of=<id> (the same fact, conditions and outcome) or
        new=true (a distinct one). supersedes: ids this record replaces. plan, step, files: what it applies to."""
        try:
            rid = await asyncio.to_thread(records.add, type, text, words_=words, why=why, outcome=outcome, source=source,
                                          area=area, plan=plan, step=step, files=files, supersedes=supersedes,
                                          duplicate_of=duplicate_of, new=new, new_reason=new_reason)
        except (Refused, ValueError) as e:
            return str(e)
        return f"Saved {rid}."

    @mcp.tool()
    async def record_query(about: str = "", type: str = "", id: str = "", status: str = "", k: int = 10) -> str:
        """Find records: about (words or a question; ranked by meaning and words, Ollama on the PC), type (dec, att,
        les, rule, find), status (att: open, accepted, rejected). id: one record whole, with its versions and links.
        Cite the ids you reuse (dec:41) in your reports."""
        if id:
            r = await asyncio.to_thread(records.get, id)
            return json.dumps(r, ensure_ascii=False) if r else f"No record {id}."
        got = await asyncio.to_thread(records.search, about, type, max(1, min(k, 50)), status)
        rows = [{"id": r["id"], "type": RECORD_TYPES[r["type"]], "status": r.get("status"), "v": len(r.get("versions") or [1]),
                 "text": r["text"][:500], "words": r.get("words", "")[:300], "why": r.get("why", ""), "source": r.get("source", ""),
                 "meaning": r.get("meaning")} for r in got["results"]]
        return json.dumps({"how": got["how"], "results": rows}, ensure_ascii=False)

    @mcp.tool()
    async def record_edit(id: str, text: str = "", words: str = "", note: str = "", outcome: str = "", why: str = "") -> str:
        """A new version of a record, v(n+1); the old versions stay. A rule or a decision needs the owner's exact words
        for this version (words). An attempt's outcome: open, accepted or rejected, with why."""
        try:
            n = await asyncio.to_thread(records.edit, id, text, words, note, outcome, why)
        except ValueError as e:
            return str(e)
        return f"Saved {id} v{n}."

    @mcp.tool()
    async def plan_get(plan_id: str = "", part: str = "") -> str:
        """Read the plan as it is now: the current version's six parts, the harness (approved: the owner ticked it and
        its text is unchanged) and each step's last state. Read it before changing the plan or working on a step when
        the conversation does not hold it. plan_id: this session's plan when empty. part: one part only (goal,
        summary, rules, lessons, leftover, steps, board, harness) to keep the reply small."""
        plan_id = plan_id or ((await asyncio.to_thread(inbox.open_plan)) or {}).get("id", "")
        if not plan_id:
            return "No plan in this session."
        try:
            got = await asyncio.to_thread(inbox.plan_get, plan_id, part)
        except ValueError as e:
            return str(e)
        return json.dumps(got, ensure_ascii=False, separators=(",", ":"))

    @mcp.tool()
    async def plan_switch(to: str, change: str, why: str, ctx: Context) -> str:
        """In a Q&A or an Action message, when the plan needs a change: ask the owner to switch the message to another
        kind (goal, step, rule or lesson). change: the exact change you would make (the owner sees it as the draft).
        Waits for the answer; only after the owner confirms may you post plan_version."""
        try:
            item_id = await asyncio.to_thread(inbox.ask_switch, to, change, why)
        except ValueError as e:
            return str(e)
        text = await wait_for(item_id, MAX_WAIT_MINUTES, ctx)
        ok = await asyncio.to_thread(inbox.confirm_switch, item_id)
        return text + ("\nThe owner confirmed the switch: make the change now with plan_version." if ok else
                       "\nNo switch: answer only, change nothing.")

    @mcp.tool()
    async def inbox_suggest(title: str, suggestion: str) -> str:
        """Post a suggestion for the owner to accept or decline. Does not wait."""
        item_id = await asyncio.to_thread(inbox.post, "suggestion", title, suggestion)
        replies = await asyncio.to_thread(inbox.other_replies, item_id)
        return "\n".join([f"Posted suggestion {item_id}.", *replies])

    @mcp.tool()
    async def inbox_result(title: str, summary: str, files: list[str] | None = None, step: str = "", plan_id: str = "",
                           edit_of: str = "") -> str:
        """Post a result for the owner to review: what was done, the numbers, the files to look at. Does not wait.
        One result per item (F12): a result on a plan step (step, default: this dashboard run's step) edits that step's
        result, which keeps the earlier text as a version and opens again for review. No step: edit_of=<result id>
        edits that result; else a new one."""
        try:
            item_id, n = await asyncio.to_thread(inbox.result, title, summary, files, plan_id, step, edit_of)
        except ValueError as e:
            return f"Not posted: {e}"
        replies = await asyncio.to_thread(inbox.other_replies, item_id)
        head = f"Edited result {item_id} (v{n}) for review." if n > 1 else f"Posted result {item_id} for review."
        return "\n".join([head, *replies])

    @mcp.tool()
    async def inbox_withdraw(item_id: str, reason: str) -> str:
        """Withdraw your own open question when it is moot (answered elsewhere, the work changed): it leaves the owner's
        "waiting for you" with your reason. Only the session that asked, or the one holding its plan now."""
        why = await asyncio.to_thread(inbox.withdraw, item_id, reason)
        return why or f"Withdrew {item_id}."

    # The archiver (archiver.py; the owner's choice, 2026-11-06: "the bridge checks for free and wakes the archiver only
    # when needed, with the archiver in Auto"). Only the archiver session calls these two.
    from .archiver import Hand
    from .config import data_dir

    hand = Hand(data_dir() / "runs" / "archiver", inbox.session_id)

    @mcp.tool()
    async def archiver_wait() -> str:
        """For the archiver session only. Waits (no tokens) until the bridge asks you to archive or unarchive a
        session, or ARCHIVER_WAIT seconds pass; then returns the ask as JSON, or "nothing". Call it again after each
        answer, forever."""
        ask = await asyncio.to_thread(hand.take, ARCHIVER_WAIT)
        return json.dumps(ask) if ask else "nothing"

    @mcp.tool()
    async def archiver_report(cid: str, action: str, ok: bool, note: str = "", app_session: str = "") -> str:
        """For the archiver session only. Report one ask: cid and action from the ask, ok true when the session was
        archived (or unarchived), else ok false and note why (busy, pinned, open on screen, no match, refused).
        app_session: the app's session id you acted on (local_...)."""
        await asyncio.to_thread(hand.report, cid, action, ok, note, app_session)
        return "Reported. Call archiver_wait again."

    mcp.run("stdio")


if __name__ == "__main__":
    server()
