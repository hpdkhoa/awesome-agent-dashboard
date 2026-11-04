// A step for work the session's record does not hold is marked new in each version's diff (the owner's words,
// 2026-11-04: "PLAN_PROMPT allows new steps and marked new in diff of each version").
import { describe, expect, it } from "vitest";
import type { Parts } from "../web/src/data";
import { diffLines, partLines } from "../web/src/planDiff";

const base: Parts = { goal: "g", summary: "s", rules: [], lessons: [], leftover: [], steps: [{ id: "s1", title: "Old", does: "d", check: "c" }] };

describe("new steps", () => {
  it("shows [new] on a new step's line, and the diff adds it", () => {
    const next = { ...base, steps: [...base.steps, { id: "s2", title: "Bulk delete", does: "d", check: "c", new: true }] };
    expect(partLines(next, "steps")).toEqual(["s1 Old: d · check: c", "s2 [new] Bulk delete: d · check: c"]);
    expect(diffLines(partLines(base, "steps"), partLines(next, "steps")).filter((l) => l.op === "add")).toEqual([
      { op: "add", text: "s2 [new] Bulk delete: d · check: c" },
    ]);
  });
});
