// The plan's phases: a divider where each phase begins, old records count as Explore, and the owner's order text.
import { describe, expect, it } from "vitest";
import type { PlanVersion } from "../web/src/data";
import { phaseOf, phaseOrder, phaseStarts, PHASES } from "../web/src/phases";

const v = (n: number, phase?: PlanVersion["phase"]) => ({ id: `p_v${n}`, planId: "p", n, text: "", note: "", createdAt: "", phase }) as PlanVersion;

describe("phases", () => {
  it("lists the owner's six phases in order, with the owner's words", () => {
    expect(PHASES.map((p) => p.id)).toEqual(["explore", "build", "verify", "remove", "optimize", "done"]);
    expect(PHASES[5].means).toContain("Open/Closed status stays separate");
    expect(PHASES[1].means).toContain("the result of build phase will be the MVP");
  });

  it("marks where each phase begins, including a rollback, in number order", () => {
    const starts = phaseStarts([v(3, "build"), v(1), v(2, "explore"), v(4, "build"), v(5, "verify"), v(6, "explore")]);
    expect([...starts]).toEqual([[1, "explore"], [3, "build"], [5, "verify"], [6, "explore"]]);
  });

  it("counts a plan or version from before phases as Explore", () => {
    expect(phaseOf(undefined)).toBe("explore");
    expect(phaseOf(v(1))).toBe("explore");
  });

  it("words the owner's order the bridge records", () => {
    expect(phaseOrder("build")).toBe("Move the plan to phase Build.");
    expect(phaseOrder("done")).toBe("Move the plan to phase Done.");
  });
});
