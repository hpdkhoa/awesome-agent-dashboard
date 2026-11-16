// Generate and check on a plan: the owner's last order, what came back for it, and what the buttons send.
import { describe, expect, it } from "vitest";
import type { InboxItem, Plan, Run } from "../web/src/data";
import { approvals, approvedFiles, baseVersion, checkGenerate, compareBase, generateFolder, generatePrompt, kindName, kindOfTitle, kindSlug, lastOrder, ownKind, partsDiffText, relPath, tmpFolderOf, versionFolderOf } from "../web/src/planCheck";
import type { Parts, PlanVersion } from "../web/src/data";

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
    expect(lastOrder(plan, runs)).toEqual({ kinds: ["mockup", "diagram"], formats: [], base: "last", note: "delete flow", at: "2026-11-04T02:00:00Z" });
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
    expect(tmpFolderOf(".plan_data/p1/v3/diagram-a.svg")).toBeNull(); // not in tmp/
    const order = { kinds: ["diagram", "mockup"], formats: [], base: "last" as const, note: "", at: "2026-11-04T02:00:00Z" };
    const c = checkGenerate(plan, order, [
      result("Generated diagram: a", [".plan_data/p1/v3/tmp/diagram-a.svg", ".plan_data/p1/v3/tmp/diagram-b.svg"]),
      result("Generated mockup: m", [".plan_data/p1/v3/tmp/mockup-m.svg"]),
      result("Generated diagram: old", [".plan_data/p1/v2/diagram-old.svg"]),
    ]);
    expect(approvals(c, [".plan_data/p1/v3/tmp/diagram-b.svg"], "p1")).toEqual([
      { folder: ".plan_data/p1/v3", keep: [".plan_data/p1/v3/tmp/diagram-b.svg"],
        drop: ["Generated diagram: a", "Generated mockup: m"], kinds: { ".plan_data/p1/v3/tmp/diagram-b.svg": "diagram" } },
    ]);
  });

  it("approved only from the record: a file outside tmp/ waits for a tick, and absolute paths count", () => {
    const cwd = String.raw`K:\Projects\cc`;
    expect(relPath("K:/Projects/cc/.plan_data/p1/v3/tmp/a.svg", cwd)).toBe(".plan_data/p1/v3/tmp/a.svg");
    expect(versionFolderOf(".plan_data/p1/v3/old.svg", "p1")).toBe(".plan_data/p1/v3");
    expect(versionFolderOf(".plan_data/p2/v3/old.svg", "p1")).toBeNull();
    const done = approvedFiles({ versions: { v3: [{ file: ".plan_data/p1/v3/kept.svg" }] } });
    const order = { kinds: ["diagram"], formats: [], base: "last" as const, note: "", at: "2026-11-04T02:00:00Z" };
    const c = checkGenerate(plan, order, [
      result("Generated diagram: old", [".plan_data/p1/v3/old.svg", ".plan_data/p1/v3/kept.svg"]),
      result("Generated diagram: new", ["K:/Projects/cc/.plan_data/p1/v3/tmp/new.svg"]),
    ]);
    expect(approvals(c, [], "p1", cwd, done)).toEqual([]); // nothing ticked: nothing to approve
    expect(approvals(c, [".plan_data/p1/v3/old.svg"], "p1", cwd, done)).toEqual([
      { folder: ".plan_data/p1/v3", keep: [".plan_data/p1/v3/old.svg"], drop: ["Generated diagram: old", "Generated diagram: new"],
        kinds: { ".plan_data/p1/v3/old.svg": "diagram" } },
    ]);
  });

  // the owner's picks, 2026-11-16: S1 what it shows x format, S2 Compare, S3 feature + product map, S4 own kind
  it("S4: the owner's own kind is checked by name, the longest kind first", () => {
    expect(ownKind("  Risk   Map ")).toBe("risk map");
    expect(kindSlug("risk map")).toBe("riskmap");
    expect(kindSlug("featuremap")).toBe("featuremap");
    expect(kindName("risk map")).toBe("risk map");
    expect(kindOfTitle("Generated risk map: top 5", ["risk map", "featuremap"])).toBe("risk map");
    expect(kindOfTitle("Generated feature map: plans", ["productmap", "featuremap"])).toBe("featuremap");
    expect(kindOfTitle("Generated product map", ["productmap", "featuremap"])).toBe("productmap");
    expect(kindOfTitle("Generated graph: reads", ["numbers"])).toBe("numbers");
    expect(kindOfTitle("Generated mapping notes", ["risk map"])).toBeNull();
    const order = { kinds: ["risk map", "compare"], formats: [], base: "last" as const, note: "", at: "2026-11-04T02:00:00Z" };
    const c = checkGenerate(plan, order, [result("Generated risk map: top 5", ["r.svg"]), result("Generated compare: v3 vs v2", ["c.html"])]);
    expect(c.got).toEqual({ "risk map": ["r.svg"], compare: ["c.html"] });
    expect(c.missing).toEqual([]);
  });

  it("S1: the prompt says what to show and the formats; the user-stories style only for User stories", () => {
    const t = generatePrompt(["featuremap", "risk map"], "", ".plan_data/p1/v3", { formats: ["html", "csv"] });
    expect(t).toContain("- Feature map: this plan's features grouped by product area");
    expect(t).toContain("- risk map: the owner's own kind");
    expect(t).toContain("one standalone HTML page that zooms and pans");
    expect(t).toContain("these kinds: featuremap, riskmap");
    expect(t).not.toContain("user-stories-diagram skill");
    expect(generatePrompt(["stories"], "", "f")).toContain("user-stories-diagram skill");
    expect(generatePrompt(["flow"], "", "f")).toContain("the format that shows it best");
  });

  it("S2: Compare reads the plan's own diff against the base version, or the product as it is", () => {
    expect(baseVersion("last", 4)).toBe(3);
    expect(baseVersion("v1", 4)).toBe(1);
    expect(baseVersion("v4", 4)).toBeNull();
    expect(baseVersion("product", 4)).toBeNull();
    const parts = (goal: string, step: string) => ({ goal, summary: "", rules: [], lessons: [], leftover: [], board: undefined,
      steps: [{ id: "s1", title: step, does: "x", check: "y" }] }) as unknown as Parts;
    const vs = [{ n: 3, parts: parts("Fast plans", "Kinds") }, { n: 4, parts: parts("Fast plans", "Purpose x format") }] as PlanVersion[];
    const d = partsDiffText(vs[0].parts, vs[1].parts);
    expect(d).toContain("6. Steps:\n- s1 Kinds: x · check: y\n+ s1 Purpose x format: x · check: y");
    expect(d).not.toContain("1. Goal");
    const b = compareBase("last", 4, vs);
    expect(b.says).toBe("plan version v3");
    const t = generatePrompt(["compare"], "", "f", { current: 4, baseSays: b.says, baseDiff: b.diff });
    expect(t).toContain("the base is plan version v3; the after is plan version v4");
    expect(t).toContain("+ s1 Purpose x format");
    expect(compareBase("product", 4, vs).says).toContain("the product as it is now");
  });
});