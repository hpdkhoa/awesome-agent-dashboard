// Generate and check on a plan: the owner's last order, what came back for it, and what the buttons send.
import { describe, expect, it } from "vitest";
import type { InboxItem, Plan, Run } from "../web/src/data";
import { approvals, checkGenerate, generateFolder, generatePrompt, lastOrder, tmpFolderOf } from "../web/src/planCheck";

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
    const t = generatePrompt(["mockup", "data"], "phone width", generateFolder({ id: "p1", current: 3 }));
    expect(t).toContain("Save each file in .plan_data/p1/v3/tmp/");
    expect(t).toContain("stay in tmp/ until the owner approves");
    expect(t).toContain("Never overwrite: if the name is taken, add -2, -3.");
    expect(t).toContain("- Mockup:");
    expect(t).toContain("- Data: sample or measured data, as CSV or JSON");
    expect(t).toContain('The owner\'s note: "phone width"');
    expect(t).toContain('inbox_result(title="Generated <kind>');
  });

  it("groups an approval per version folder: ticked files kept, every tmp result dropped", () => {
    expect(tmpFolderOf(".plan_data/p1/v3/tmp/diagram-a.svg")).toBe(".plan_data/p1/v3");
    expect(tmpFolderOf(".plan_data\\p1\\v3\\tmp\\a.svg")).toBe(".plan_data/p1/v3"); // Windows separators
    expect(tmpFolderOf(".plan_data/p1/v3/diagram-a.svg")).toBeNull(); // already approved
    const order = { kinds: ["diagram", "mockup"] as ("diagram" | "mockup")[], note: "", at: "2026-11-04T02:00:00Z" };
    const c = checkGenerate(plan, order, [
      result("Generated diagram: a", [".plan_data/p1/v3/tmp/diagram-a.svg", ".plan_data/p1/v3/tmp/diagram-b.svg"]),
      result("Generated mockup: m", [".plan_data/p1/v3/tmp/mockup-m.svg"]),
      result("Generated diagram: old", [".plan_data/p1/v2/diagram-old.svg"]),
    ]);
    expect(approvals(c, [".plan_data/p1/v3/tmp/diagram-b.svg"])).toEqual([
      { folder: ".plan_data/p1/v3", keep: [".plan_data/p1/v3/tmp/diagram-b.svg"],
        drop: ["Generated diagram: a", "Generated mockup: m"] },
    ]);
  });
});
