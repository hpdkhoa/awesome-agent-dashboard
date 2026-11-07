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

// Grouping (step s11; the owner's words, 2026-11-07: "build s11 grouping", from the mockup "Shown together because your
// history is clear. Nothing is picked for you."). Waiting plan questions of one plan show together when your history
// is clear: at least CLEAR_MIN answered plan questions, with the recommended option picked in CLEAR_SHARE of them.
export const CLEAR_MIN = 5;
export const CLEAR_SHARE = 0.9;

const groupable = (i: InboxItem) =>
  i.status === "open" && !!i.planId && i.kind === "question" && !i.multi && i.recommended != null && i.options.length > 0;

export function clearHistory(items: InboxItem[]): boolean {
  const p = pastPicks(items);
  return p.total >= CLEAR_MIN && p.picked / p.total >= CLEAR_SHARE;
}

// The waiting questions shown together with `item`, oldest first; empty when they are not grouped.
export function groupFor(items: InboxItem[], item: InboxItem): InboxItem[] {
  if (!groupable(item) || !clearHistory(items)) return [];
  const group = items.filter((i) => groupable(i) && i.planId === item.planId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return group.length >= 2 ? group : [];
}

// Send only when every question has your pick; nothing is ever filled in for you.
export const missingPicks = (group: InboxItem[], picks: Record<string, string>) => group.filter((i) => !picks[i.id]).map((i) => i.id);
