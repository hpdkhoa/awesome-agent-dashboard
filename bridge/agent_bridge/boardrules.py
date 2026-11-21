"""The auto rule check of the report board (plan 44fc4979 s5). The owner's picks, 2026-11-20: "Check all 10, B2/B4/B7
'waits s7'" (all ten board rules B1 to B10 of cc/dashboard/ATTENTION.md are checked on every plan_version; B2, B4 and
B7 need s7's board code, so they show as "waits for s7" and do not count as fails until s7 is done) and "Save + red
flag" (a version that breaks a rule is saved; the board shows the fails; refusing is an open item the owner decides
later: "refuse will come when I decide later so note it as open").

What each rule measures on the board's data (the stored board: whatFor, idea, product, materials, src):
  B1 Conclusion first: What for is there, one line.
  B2 Chunks of 4: Idea over 4 lines needs its named sub-groups (ideaGroups), each 1 to 4 lines, adding up to the
     Idea lines (s7, the owner's pick "By meaning"); features, materials and lists are split by the page (s7).
  B3 First 2 words: lines that open with a generic word, and openers repeated down one list.
  B4 One cue per meaning: one colour per state is page code (s7, "Amber = needs you only"); pass, measured on the page.
  B5 Source beside the line: What for and Idea lines with no source id.
  B6 Two levels only: a board line that holds a second level itself (a line break or a sub-bullet).
  B7 Changes are marked: the "changed" mark is page code (s7, "Bridge, all devices"); pass, measured on the page.
  B8 Short by writing: text cut with "..." or "…".
  B9 What, not why: lines that carry a why ("because", "since", "so that", "due to", "in order to", "why").
  B10 Grouped and headed: the board's group headings (the page's, listed in HEADINGS) start with an information word.
"""
import re
from datetime import datetime, timezone


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()

S7 = "waits for s7"  # the state older versions' saved checks hold (s5); s7 made B2, B4 and B7 real checks
# the page's group headings on the report board (web/src/PlanParts.tsx ReportBoard, BoardRules.tsx, Coverage.tsx); keep in step
HEADINGS = ["Coverage", "What for", "Idea", "Progress vs the final product", "Materials", "Needs you", "Latest result", "Rules and glance",
            "Features built", "Features with open items", "Features being built", "Features failed", "Features not built",
            "Steps failed", "Questions waiting", "Open items", "Rules failing", "Rules passing", "Rules waiting",
            "Missing", "Stories", "Other files", "Counts", "Spread"]
GENERIC = {"built", "step", "note", "done", "todo", "info", "misc", "update", "item", "the", "a", "an", "this", "it"}
WHY = re.compile(r"\b(because|since|so that|due to|in order to|why)\b", re.I)
CUT = re.compile(r"\.\.\.|…")
NAMES = {"B1": "Conclusion first", "B2": "Chunks of 4", "B3": "First 2 words", "B4": "One cue per meaning",
         "B5": "Source beside the line", "B6": "Two levels only", "B7": "Changes are marked",
         "B8": "Short by writing, never by cutting", "B9": "What, not why", "B10": "Grouped and headed"}
KB = {f"B{i}": f"rule:{23 + i}" for i in range(1, 11)}


def _first(line: str) -> str:
    m = re.match(r"\W*([\w'-]+)", line or "")
    return m.group(1).lower() if m else ""


def _lines(board: dict) -> list[tuple[str, str]]:
    """(group, text) for every line the board's data holds."""
    out = [("What for", board.get("whatFor") or "")]
    out += [("Idea", x) for x in board.get("idea") or []]
    out += [("Features", f.get("feature", "")) for f in board.get("product") or []]
    out += [("Materials", f"{m.get('name', '')} {m.get('note', '')}".strip()) for m in board.get("materials") or []]
    return [(g, t) for g, t in out if t]


def check_board(board: dict | None) -> dict | None:
    if not board:
        return None
    lines = _lines(board)
    src = board.get("src") or {}
    rules = []

    def add(rid, state, n=0, found=None, note=""):
        rules.append({"id": rid, "name": NAMES[rid], "kb": KB[rid], "state": state, "n": n, "lines": (found or [])[:20], "note": note})

    what = board.get("whatFor") or ""
    add("B1", "pass" if what.strip() and "\n" not in what.strip() else "fail", 0 if what.strip() else 1,
        [] if what.strip() else ["What for is empty"])
    idea, ig = board.get("idea") or [], board.get("ideaGroups") or []
    over = []
    if len(idea) > 4:
        if not ig:
            over.append(f"Idea: {len(idea)} lines with no named sub-groups (idea_groups)")
        else:
            big = [f"Idea group '{g['head']}': {g['count']} lines" for g in ig if g["count"] > 4]
            total = sum(g["count"] for g in ig)
            over += big + ([f"Idea groups hold {total} lines, Idea has {len(idea)}"] if total != len(idea) else [])
    add("B2", "fail" if over else "pass", len(over), over,
        "features, materials and lists are split into headed groups of up to 4 by the page")
    generic = [f"{g}: {t}" for g, t in lines if _first(t) in GENERIC]
    repeated = []
    for g in ("Idea", "Features"):
        firsts = [_first(t) for gg, t in lines if gg == g]
        repeated += [f"{g}: '{w}' opens {firsts.count(w)} lines" for w in sorted(set(firsts)) if w and firsts.count(w) > 1]
    found = generic + repeated
    add("B3", "fail" if found else "pass", len(found), found)
    add("B4", "pass", 0, [], "page code: one colour per state (green done, blue doing, grey not built, red failed, amber needs you)")
    nosrc = ([] if src.get("whatFor") else ["What for"]) + [f"Idea: {t}" for i, t in enumerate(board.get("idea") or [])
                                                             if not (src.get("idea") or [])[i:i + 1] or not (src.get("idea") or [])[i]]
    add("B5", "fail" if nosrc else "pass", len(nosrc), nosrc)
    two = [f"{g}: {t[:80]}" for g, t in lines if "\n" in t.strip() or re.match(r"^\s*[-*]\s", t)]
    add("B6", "fail" if two else "pass", len(two), two)
    add("B7", "pass", 0, [], "page code: lines that differ since the owner's last look (boardSeen) carry 'changed'")
    cut = [f"{g}: {t}" for g, t in lines if CUT.search(t)]
    add("B8", "fail" if cut else "pass", len(cut), cut)
    why = [f"{g}: {t}" for g, t in lines if WHY.search(t)]
    add("B9", "fail" if why else "pass", len(why), why)
    heads = [f"heading '{h}' opens with '{_first(h)}'" for h in HEADINGS + [g["head"] for g in ig] if _first(h) in GENERIC]
    add("B10", "fail" if heads else "pass", len(heads), heads)
    count = {s: sum(1 for r in rules if r["state"] == s) for s in ("pass", "fail", S7)}
    return {"at": now_iso(), "rules": rules, "pass": count["pass"], "fail": count["fail"], "wait": count[S7]}
