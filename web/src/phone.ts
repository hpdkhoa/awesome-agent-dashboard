// Phone-first inbox (step i7, the owner's picks 2026-11-12: "Tap = save, go to next; Send at the end", "Full screen,
// Back to list", "One card per screen, swipe + dots"). Phone = 560 px and narrower, the same line as the page's
// other phone rules; the desktop layout does not change.
import { useEffect, useState } from "react";
import type { InboxItem } from "./data";

export const PHONE_QUERY = "(max-width: 560px)";

export function usePhone(): boolean {
  const mq = typeof window !== "undefined" && window.matchMedia ? window.matchMedia(PHONE_QUERY) : null;
  const [on, setOn] = useState(mq?.matches ?? false);
  useEffect(() => {
    if (!mq) return;
    const f = () => setOn(mq.matches);
    mq.addEventListener("change", f);
    return () => mq.removeEventListener("change", f);
  }, [mq]);
  return on;
}

// A swipe: the finger moved at least 50 px sideways and clearly more sideways than up or down (a scroll stays a
// scroll). -1 = to the next question (finger moved left), 1 = back, 0 = no swipe.
export const SWIPE_MIN = 50;
export function swipeDir(dx: number, dy: number): -1 | 0 | 1 {
  if (Math.abs(dx) < SWIPE_MIN || Math.abs(dx) < 1.5 * Math.abs(dy)) return 0;
  return dx < 0 ? -1 : 1;
}

// The card to show after a move, kept inside the batch.
export const step = (k: number, n: number, by: number) => Math.max(0, Math.min(n - 1, k + by));

// A question counts as saved once it has a saved answer, or is no longer open (already sent).
export const isSaved = (q: InboxItem) => q.status !== "open" || !!q.draft;

// One dot per question: saved, the one shown, or still to answer.
export const dotState = (batch: InboxItem[], shown: number) =>
  batch.map((q, k) => (k === shown ? "now" : isSaved(q) ? "saved" : "todo"));

// The first question still to answer after k (wrapping round), or -1 when all are saved: where a tap goes next.
export function nextTodo(batch: InboxItem[], k: number, saved: Set<string> = new Set()): number {
  for (let i = 1; i <= batch.length; i++) {
    const j = (k + i) % batch.length;
    if (!isSaved(batch[j]) && !saved.has(batch[j].id)) return j;
  }
  return -1;
}
