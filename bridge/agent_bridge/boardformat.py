"""s6 of plan 44fc4979 (the owner, 2026-11-21: "I don't want auto update on all plans, I want the update button so I can
do manual update for the roll out, the next run steps on a plan will auto generate to selfupdate the work to keep up with
latest work").

board_gaps: what a plan's board lacks against the latest board format (s8: step cards For / How / Done / Missed, the
glossary; s7: idea groups when the idea has more than 4 lines). web/src/boardFormat.ts holds the same list for the
page's Update board button.
update_block: the order a run gets to bring the board up to date: on the owner's Update board button (boardUpdate on
the command), and first thing in a Run step on a plan whose board has gaps. No plan is touched otherwise.
"""
from __future__ import annotations

CARD_FIELDS = ("for", "action", "how", "done", "missed")  # action: the owner, 2026-11-26, "add action which show what step does"


def board_gaps(parts: dict | None) -> list[str]:
    """The gaps of a plan version's board against the latest format, one short line each; [] when it is up to date."""
    parts = parts or {}
    steps = [str(s.get("id")) for s in parts.get("steps") or [] if isinstance(s, dict) and s.get("id")]
    b = parts.get("board")
    if not isinstance(b, dict) or not b:
        return ["no board"]
    gaps: list[str] = []
    cards = {str(c.get("step")): c for c in (b.get("stepCards") or b.get("step_cards") or []) if isinstance(c, dict)}
    no_card = [s for s in steps if s not in cards]
    if no_card:
        gaps.append("no step card: " + ", ".join(no_card))
    for f in CARD_FIELDS:
        short = [s for s in steps if s in cards and not str(cards[s].get(f) or "").strip()]
        if short:
            gaps.append(f"step cards without {f.capitalize()}: " + ", ".join(short))
    if not b.get("glossary"):
        gaps.append("no glossary")
    if len(b.get("idea") or []) > 4 and not b.get("ideaGroups"):
        gaps.append("idea over 4 lines with no idea groups")
    return gaps


def update_block(gaps: list[str], by_button: bool) -> str:
    """The board-update order put in a run's message."""
    why = ("The owner pressed Update board on this plan's page." if by_button else
           "This plan's board is older than the latest board format; bring it up to date first, then work the step.")
    have = "\n".join(f"- {g}" for g in gaps) if gaps else "- none found; refresh Done / Missed and the glossary from the latest work"
    return (f"Board update (plan 44fc4979 s6, the owner's words 2026-11-21: \"I want the update button so I can do manual "
            f"update for the roll out, the next run steps on a plan will auto generate to selfupdate the work to keep up "
            f"with latest work\"). {why}\nGaps:\n{have}\n"
            "Do: read the plan with plan_get and its step reports; write board.stepCards for every step (step, for, action = one short line of what "
            "the step does, how, done, missed in plain words, src), board.glossary for the plan's own terms ({group, term, means}), idea "
            "groups when the idea has more than 4 lines, a source chip on every line (rules B1 to B10, "
            "cc/dashboard/ATTENTION.md). Change only the board; keep every other part as it is. Count steps, rules, "
            "lessons, leftover, harness, idea and features before and after: any loss stops the call (rule:23). Post "
            "it with plan_version, read it back, and say in the reply what changed on the board."
            + (" The button is the owner's order: this run posts the board-only plan_version with no plan_switch "
               "(a change to any other part is refused)." if by_button else ""))
