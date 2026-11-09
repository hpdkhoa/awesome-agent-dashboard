// Quoting a step, a part or selected words for the plan's message box (the owner's pick, 2026-11-09: "Both").
import { describe, expect, it } from "vitest";
import { quoteLines, quotePart, quoteStep, quoteWords } from "../web/src/quote";

describe("quotes for the message box", () => {
  it("quotes every line of a step with its id, title, work and check", () => {
    const q = quoteStep({ id: "s3", title: "Rule form", does: "The owner enters a rule.\nThree fields.", check: "one row saved" });
    expect(q.split("\n")).toEqual(["> **s3 · Rule form**", "> The owner enters a rule.", "> Three fields.", "> Check: one row saved"]);
  });

  it("quotes a part by name, and says none for an empty part", () => {
    expect(quotePart("5. Leftover", ["- a", "- b"])).toBe("> **5. Leftover**\n> - a\n> - b");
    expect(quotePart("5. Leftover", [])).toBe("> **5. Leftover**\n> none");
  });

  it("quotes selected words as they are, trimmed, with Windows line ends folded", () => {
    expect(quoteWords("  a D1 table keeps it  ")).toBe("> a D1 table keeps it");
    expect(quoteLines("one\r\ntwo")).toBe("> one\n> two");
  });
});
