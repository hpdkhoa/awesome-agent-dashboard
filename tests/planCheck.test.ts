// The plan-start check behind the Check button: mockup and picture examples counted, and what the button sends.
import { describe, expect, it } from "vitest";
import type { InboxItem, Plan } from "../web/src/data";
import { checkPlan, checkPrompt } from "../web/src/planCheck";

const plan = { id: "p1", sessionId: "s1", createdAt: "2026-11-04T01:00:00Z", status: "open" } as Plan;
const item = (f: Partial<InboxItem>) =>
  ({ id: "i", kind: "question", sessionId: "s1", createdAt: "2026-11-04T02:00:00Z", files: [], options: [], ...f }) as InboxItem;
const text = { label: "A", detail: "", example: { type: "text" as const, draft: "d" } };
const pic = { label: "B", detail: "", example: { type: "image" as const, before: "a.png", after: "b.png" } };

describe("plan check", () => {
  it("finds nothing in a plan with only text examples and no mockup (the KPI plan, 2026-11-04)", () => {
    const c = checkPlan(plan, [item({ planId: "p1", options: [text, text] })]);
    expect(c).toEqual({ mockup: null, questions: 1, options: 2, pictures: 0, missing: ["mockup", "pictures"] });
    const msg = checkPrompt(c);
    expect(msg).toContain("mockup missing; 0 of 2 options in 1 questions");
    expect(msg).toContain("PNG or SVG") ;
    expect(msg).toContain("Ask those questions again");
  });

  it("takes the mockup only from the plan's own session, after the plan opened, as a picture", () => {
    const items = [
      item({ kind: "result", sessionId: "other", files: ["x.png"] }),
      item({ kind: "result", createdAt: "2026-11-04T00:00:00Z", files: ["old.png"] }),
      item({ kind: "result", files: ["notes.md", "mock.svg"] }),
      item({ planId: "p1", options: [text, pic] }),
    ];
    const c = checkPlan(plan, items);
    expect(c.mockup).toBe("mock.svg");
    expect(c.pictures).toBe(1);
    expect(c.missing).toEqual([]);
    expect(checkPrompt(c)).toBe("Go on with the plan from where it stopped.");
  });

  it("asks for picture examples only once questions exist", () => {
    const c = checkPlan(plan, [item({ kind: "result", files: ["m.png"] })]);
    expect(c.missing).toEqual([]);
    expect(checkPlan(plan, [item({ kind: "result", files: ["m.png"] }), item({ planId: "p1", options: [text] })]).missing).toEqual(["pictures"]);
  });
});
