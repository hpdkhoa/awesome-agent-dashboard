// Generate and check on a plan: the owner's last order, what came back for it, and what the buttons send.
import { describe, expect, it } from "vitest";
import type { InboxItem, Plan, Run } from "../web/src/data";
import { checkGenerate, generatePrompt, lastOrder } from "../web/src/planCheck";

const plan = { id: "p1", sessionId: "s1", createdAt: "2026-11-04T01:00:00Z", status: "open" } as Plan;
const run = (f: Partial<Run>) => ({ id: "r", action: "message", planId: "p1", createdAt: "2026-11-04T02:00:00Z", ...f }) as Run;
const result = (title: string, files: string[], f: Partial<InboxItem> = {}) =>
  ({ id: title, kind: "result", sessionId: "s1", title, files, createdAt: "2026-11-04T03:00:00Z", ...f }) as InboxItem;

describe("generate and check", () => {
  it("takes the newest Generate order on this plan", () => {
    const runs = [
      run({ generate: { kinds: ["mockup"], note: "old" }, createdAt: "2026-11-04T01:30:00Z" }),
      run({ generate: { kinds: ["mockup", "diagram"], note: "delete flow" } }),
      run({ planId: "other", generate: { kinds: ["data"] }, createdAt: "2026-11-04T05:00:00Z" }),
      run({}),
    ];
    expect(lastOrder(plan, runs)).toEqual({ kinds: ["mockup", "diagram"], note: "delete flow", at: "2026-11-04T02:00:00Z" });
    expect(lastOrder(plan, [run({})])).toBeNull();
  });

  it("finds each asked kind from this session's results after the order, and lists what is missing", () => {
    const order = { kinds: ["mockup", "diagram", "chart"] as const, note: "", at: "2026-11-04T02:00:00Z" };
    const items = [
      result("Generated mockup: the delete flow", ["delete.svg"]),
      result("Generated graph: reads per day", ["reads.svg"]),
      result("Generated diagram", ["old.svg"], { createdAt: "2026-11-04T01:00:00Z" }), // before the order
      result("Generated diagram", ["other.svg"], { sessionId: "s2" }), // another session
      result("Generated diagram", []), // no file
    ];
    const c = checkGenerate(plan, { ...order, kinds: [...order.kinds] }, items);
    expect(c.got).toEqual({ mockup: ["delete.svg"], chart: ["reads.svg"] });
    expect(c.missing).toEqual(["diagram"]);
  });

  it("asks for each kind as a file and one result per kind, with the owner's note", () => {
    const t = generatePrompt(["mockup", "data"], "phone width");
    expect(t).toContain("- Mockup:");
    expect(t).toContain("- Data: sample or measured data, as CSV or JSON");
    expect(t).toContain('The owner\'s note: "phone width"');
    expect(t).toContain('inbox_result(title="Generated <kind>');
  });
});
