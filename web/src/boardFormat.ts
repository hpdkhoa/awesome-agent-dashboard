// s6 of plan 44fc4979 (the owner, 2026-11-21: "I don't want auto update on all plans, I want the update button so I can
// do manual update for the roll out, the next run steps on a plan will auto generate to selfupdate the work to keep up
// with latest work"). The same gaps as the bridge's boardformat.board_gaps; the bridge puts the update order in the run.
import type { Parts } from "./data";

const FIELDS = ["for", "action", "how", "done", "missed"] as const; // action: the owner, 2026-11-26, "add action which show what step does"

export function boardGaps(parts?: Parts | null): string[] {
  const steps = (parts?.steps ?? []).map((s) => s.id).filter(Boolean);
  const b = parts?.board;
  if (!b) return ["no board"];
  const gaps: string[] = [];
  const cards = new Map((b.stepCards ?? []).map((c) => [c.step, c] as const));
  const noCard = steps.filter((s) => !cards.has(s));
  if (noCard.length) gaps.push(`no step card: ${noCard.join(", ")}`);
  for (const f of FIELDS) {
    const short = steps.filter((s) => cards.has(s) && !String(cards.get(s)?.[f] ?? "").trim());
    if (short.length) gaps.push(`step cards without ${f[0].toUpperCase() + f.slice(1)}: ${short.join(", ")}`);
  }
  if (!b.glossary?.length) gaps.push("no glossary");
  if ((b.idea?.length ?? 0) > 4 && !b.ideaGroups?.length) gaps.push("idea over 4 lines with no idea groups");
  return gaps;
}
