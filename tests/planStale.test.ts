// The plan's update check (the owner's pick, 2026-11-10: "Both").
import { describe, expect, it } from "vitest";
import { staleMark, staleness, versionAt } from "../web/src/planStale";
import { clampWidth, gridColumns, DEFAULT_LAYOUT } from "../web/src/layout";

const step = (id: string, does: string) => ({ id, title: id, does, check: "c" });
const parts = (steps: ReturnType<typeof step>[]) => ({ goal: "g", summary: "s", rules: [], lessons: [], leftover: [], steps });
const v = (n: number, createdAt: string, p: ReturnType<typeof parts>) =>
  ({ id: `p_v${n}`, planId: "p", n, text: "", note: "", createdAt, parts: p }) as never;
const plan = { id: "p", current: 2 } as never;

describe("plan staleness", () => {
  const versions = [v(1, "2026-11-01T00:00:00Z", parts([step("s1", "a"), step("s2", "b")])), v(2, "2026-11-05T00:00:00Z", parts([step("s1", "a"), step("s2", "b changed")]))];
  const steps = [
    { id: "p_s1", planId: "p", stepId: "s1", state: "done", updatedAt: "", versions: [{ n: 1, state: "done", reply: "", at: "2026-11-02T00:00:00Z", planVersion: 1 }] },
    { id: "p_s2", planId: "p", stepId: "s2", state: "done", updatedAt: "", versions: [{ n: 1, state: "done", reply: "", at: "2026-11-02T00:00:00Z", planVersion: 1 }] },
  ] as never;

  it("a step reported on an older version is stale only when its text changed", () => {
    const rows = staleness(plan, versions, null, null, steps, []);
    expect(rows.find((r) => r.section === "results · s1")).toMatchObject({ ok: true, note: "done on v1, unchanged since" });
    expect(rows.find((r) => r.section === "results · s2")).toMatchObject({ ok: false, fix: "Run step again on the current text" });
    expect(staleMark(rows, "results")).toContain("s2".length ? "changed in v2" : "");
    expect(staleMark(rows, "parts")).toBeUndefined();
  });

  it("generated files approved for an older version only are stale", () => {
    const gen = { planId: "p", versions: { v1: [{ file: "a.svg", kind: "diagram", at: "x" }] } };
    const rows = staleness(plan, versions, null, gen, [], []);
    expect(rows.find((r) => r.section === "generated")).toMatchObject({ ok: false, note: "files approved for v1, none for v2" });
    const gen2 = { planId: "p", versions: { v2: [{ file: "b.svg", kind: "diagram", at: "x" }] } };
    expect(staleness(plan, versions, null, gen2, [], []).find((r) => r.section === "generated")!.ok).toBe(true);
  });

  it("the last message is answered when a version came after it", () => {
    const run = { id: "m1", planId: "p", kind: "rule", action: "message", status: "done", createdAt: "2026-11-04T00:00:00Z" } as never;
    const rows = staleness(plan, versions, null, null, [], [run]);
    expect(rows.find((r) => r.section === "last message")).toMatchObject({ ok: true });
    const late = { ...(run as object), id: "m2", createdAt: "2026-11-06T00:00:00Z" } as never;
    expect(staleness(plan, versions, null, null, [], [late]).find((r) => r.section === "last message")!.ok).toBe(false);
    expect(versionAt(versions, "2026-11-03T00:00:00Z")).toBe(1);
    expect(versionAt(versions, "2026-10-01T00:00:00Z")).toBe(0);
  });
});

describe("panel layout", () => {
  it("clamps a panel between 180 px and 60% of the window", () => {
    expect(clampWidth(50, 1200)).toBe(180);
    expect(clampWidth(900, 1200)).toBe(720);
    expect(clampWidth(300, 1200)).toBe(300);
  });
  it("a hidden panel and its handle take no room", () => {
    expect(gridColumns(DEFAULT_LAYOUT)).toBe("320px 6px 1fr 6px 300px");
    expect(gridColumns({ ...DEFAULT_LAYOUT, leftHidden: true })).toBe("0 0 1fr 6px 300px");
    expect(gridColumns({ ...DEFAULT_LAYOUT, rightHidden: true })).toBe("320px 6px 1fr 0 0");
  });
});
