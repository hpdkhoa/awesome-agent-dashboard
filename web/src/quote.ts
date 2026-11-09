// Quote a step, a part or selected words into the plan's message box (the owner's words, 2026-11-09: "give me the
// action to interact with each step and give me the feature to quote and start Q&A on that part"; pick: "Both").
import type { Parts, PlanKind } from "./data";

export const QUOTE_EVENT = "aad.quote";

export type QuoteAsk = { text: string; kind?: PlanKind; stepId?: string; part?: string };

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

// Fills the message box (PlanParts.tsx PlanMessage listens): the quote, the kind to send as, and where the reply shows.
export const askAbout = (q: QuoteAsk) => window.dispatchEvent(new CustomEvent<QuoteAsk>(QUOTE_EVENT, { detail: q }));
