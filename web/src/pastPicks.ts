import type { InboxItem } from "./data";

// Your past picks before a plan question (step s11, idea accepted 2026-11-04): how often you took the recommended option
// on answered plan questions. It is shown only; it never picks or answers for you.
export type Picks = { picked: number; total: number };

const counted = (i: InboxItem) =>
  !!i.planId && i.kind === "question" && !i.multi && i.recommended != null && !!i.options[i.recommended] && !!i.answer?.choice;

export function pastPicks(items: InboxItem[], skip = "", planId = ""): Picks {
  const past = items.filter((i) => i.id !== skip && counted(i) && (!planId || i.planId === planId));
  return { picked: past.filter((i) => i.answer!.choice === i.options[i.recommended!].label).length, total: past.length };
}
