// "Ask about this" goes to the box of what the words belong to (the owner's words, 2026-11-10: "The cite to ask
// feature need to apply dashboard wide, when in sessions and run then the cite will direct to the message box").
import { describe, expect, it } from "vitest";
import { forPlan, forSession, takeQuote } from "../web/src/quote";

describe("quote targets", () => {
  it("a plan quote goes to that plan's box only", () => {
    const q = { text: "> a", planId: "p1", sessionId: "s1" };
    expect(forPlan("p1")(q)).toBe(true);
    expect(forPlan("p2")(q)).toBe(false);
    expect(forSession("s1")(q)).toBe(false); // a plan's run quotes to the plan, not its session
  });
  it("a session quote goes to that session's box; a step button quote to the open plan", () => {
    expect(forSession("s1")({ text: "x", sessionId: "s1" })).toBe(true);
    expect(forSession("s2")({ text: "x", sessionId: "s1" })).toBe(false);
    expect(forPlan("p9")({ text: "x", stepId: "S1" })).toBe(true);
  });
  it("nothing waits until askAbout; a waiting quote is taken once", async () => {
    expect(takeQuote(() => true)).toBeNull();
    (globalThis as { window?: unknown }).window = { dispatchEvent: () => true };
    (globalThis as { CustomEvent?: unknown }).CustomEvent ??= class { constructor(public type: string, public init: unknown) {} };
    const { askAbout } = await import("../web/src/quote");
    askAbout({ text: "> b", sessionId: "s1" });
    expect(takeQuote(forPlan("p1"))).toBeNull(); // not for a plan: it keeps waiting
    expect(takeQuote(forSession("s1"))?.text).toBe("> b");
    expect(takeQuote(forSession("s1"))).toBeNull();
  });
});
