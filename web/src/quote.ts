// Quote a step, a part or selected words into the plan's message box (the owner's words, 2026-11-09: "give me the
// action to interact with each step and give me the feature to quote and start Q&A on that part"; pick: "Both").
import type { Parts, PlanKind } from "./data";

export const QUOTE_EVENT = "aad.quote";

// planId: the quote goes to that plan's message box; sessionId (no planId): to that session's message box (the owner's
// words, 2026-11-10: "The cite to ask feature need to apply dashboard wide, when in sessions and run then the cite will
// direct to the message box"). Neither: the plan box open now (the step and part buttons).
export type QuoteAsk = { text: string; kind?: PlanKind; stepId?: string; part?: string; planId?: string; sessionId?: string };

// Markdown quote of some text, one "> " per line.
export const quoteLines = (text: string) =>
  text
    .replace(/\r\n/g, "\n")
    .trim()
    .split("\n")
    .map((l) => "> " + l)
    .join("\n");

export const quoteStep = (st: Parts["steps"][number]) =>
  quoteLines(`**${st.id} · ${st.title}**\n${st.does}\nCheck: ${st.check}`);

export const quotePart = (name: string, lines: string[]) => quoteLines(`**${name}**\n${lines.join("\n") || "none"}`);

export const quoteWords = (words: string) => quoteLines(words);

// Fills a message box (PlanParts.tsx PlanMessage, Runs.tsx MessageBox listen): the quote, the kind to send as, and
// where the reply shows. A quote whose box is not on screen waits here; the Dashboard opens its plan or session and the
// box takes it when it mounts.
let pending: QuoteAsk | null = null;
export const askAbout = (q: QuoteAsk) => {
  pending = q;
  window.dispatchEvent(new CustomEvent<QuoteAsk>(QUOTE_EVENT, { detail: q }));
};
// The waiting quote, if it is for this box; taken once.
export function takeQuote(match: (q: QuoteAsk) => boolean): QuoteAsk | null {
  if (!pending || !match(pending)) return null;
  const q = pending;
  pending = null;
  return q;
}
export const forPlan = (planId: string) => (q: QuoteAsk) => q.planId === planId || (!q.planId && !q.sessionId);
export const forSession = (sessionId: string) => (q: QuoteAsk) => !q.planId && q.sessionId === sessionId;
