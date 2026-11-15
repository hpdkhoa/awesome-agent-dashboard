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

  it("Summary and Leftover are behind when a step reported after the current version", () => {
    // the owner's words, 2026-11-15: "it is not update the open points ... after steps done I don't see the update in summarize"
    const late = [{ ...(steps as never[])[0] as object, versions: [{ n: 1, state: "done", reply: "", at: "2026-11-06T00:00:00Z", planVersion: 2 }] }] as never;
    const rows = staleness(plan, versions, null, null, late, []);
    expect(rows.find((r) => r.section === "summary")).toMatchObject({ ok: false, note: "1 step report after v2 (newest: s1 done), not in Summary" });
    expect(staleMark(rows, "leftover")).toContain("not in Leftover");
    const early = staleness(plan, versions, null, null, steps, []);
    expect(early.find((r) => r.section === "summary")).toMatchObject({ ok: true, note: "v2, no step report since" });
  });

  it("the board is behind when missing, when a step sits under no feature, or when the goal or steps changed after it", () => {
    // the owner's words, 2026-11-16: "Don't let the dashboard out of date in any kind"
    const b = { whatFor: "w", idea: [], product: [{ feature: "F", steps: ["s1", "s2"] }] };
    const withB = (n: number, at: string, st: ReturnType<typeof step>[], board?: object) => v(n, at, { ...parts(st), ...(board ? { board } : {}) } as never);
    const row = (vs: never[]) => staleness(plan, vs, null, null, [], []).find((r) => r.section === "board");
    expect(row(versions as never[])).toMatchObject({ ok: false, note: "v2 has no board" });
    const two = [step("s1", "a"), step("s2", "b")];
    expect(row([withB(1, "2026-11-01", two, b), withB(2, "2026-11-02", two, b)] as never[])).toMatchObject({ ok: true, note: "board from v1, every step under a feature" });
    const three = [...two, step("s3", "c")];
    expect(row([withB(1, "2026-11-01", two, b), withB(2, "2026-11-02", three, b)] as never[])).toMatchObject({ ok: false, note: "steps under no feature: s3" });
    const retitled = [step("s1", "a"), { ...step("s2", "b"), title: "new title" }];
    expect(row([withB(1, "2026-11-01", two, b), withB(2, "2026-11-02", retitled, b)] as never[])).toMatchObject({ ok: false, note: "board from v1; goal or steps changed in v2" });
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
