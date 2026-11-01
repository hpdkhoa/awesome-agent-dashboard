// The plan graph: branches get their own lane, the chosen line, the line diff, and each step's answers and counts.
import { describe, expect, it } from "vitest";
import type { InboxItem, Plan, PlanVersion } from "../web/src/data";
import { chip, chosenLine, diffCount, layout, steps } from "../web/src/planTree";

const v = (n: number, parent: number | undefined, text: string, madeBy?: PlanVersion["madeBy"]): PlanVersion =>
  ({ id: `p_v${n}`, planId: "p", n, parent, text, note: `note ${n}`, createdAt: `2026-11-01T00:0${n}:00Z`, madeBy });
const q = (id: string, round: number, choice: string | null, text = ""): InboxItem =>
  ({ id, planId: "p", round, title: `Q ${id}`, kind: "question", status: choice === null ? "open" : "delivered",
    answer: choice === null ? null : { choice, text, at: "x" }, createdAt: id } as InboxItem);
const plan = (chosen?: number) => ({ id: "p", current: 4, chosen } as Plan);

// v1 -> v2 -> v3, and a branch v1 -> v4 after the owner reopened Q a
const versions = [v(1, 0, "a\nb"), v(2, 1, "a\nb\nlist", [{ id: "a", title: "Q a", choice: "List", text: "" }]), v(3, 2, "a\nb\nlist\nmore"),
  v(4, 1, "a\ngraph", [{ id: "a", title: "Q a", choice: "Graph", text: "tree only please, no extra library at all" }])];

describe("plan tree", () => {
  it("puts a branch in its own lane", () => {
    const { nodes, lanes } = layout(versions);
    const at = Object.fromEntries(nodes.map((d) => [d.v.n, d]));
    expect(lanes).toBe(2);
    expect([at[1].lane, at[2].lane, at[3].lane]).toEqual([0, 0, 0]);
    expect(at[4]).toMatchObject({ depth: 1, lane: 1 });
  });
  it("follows the chosen version back to v1", () => {
    expect([...chosenLine(plan(), versions)].sort()).toEqual([1, 4]);
    expect([...chosenLine(plan(3), versions)].sort()).toEqual([1, 2, 3]);
  });
  it("counts lines added and removed", () => expect(diffCount("a\nb", "a\ngraph")).toEqual({ add: 1, del: 1 }));
});

describe("steps", () => {
  const asked = [q("a", 1, "Graph"), q("b", 2, "Yes"), q("c", 4, null)];
  it("one step per round: your answers as they were, the version they made, the counts", () => {
    const s = steps(plan(), versions, asked);
    expect(s.map((x) => x.round)).toEqual([1, 2, 4]);
    expect(s[0]).toMatchObject({ made: { n: 4 }, add: 1, del: 1, waiting: 0 });
    expect(s[0].answers[0].choice).toBe("Graph");
    expect(s[2]).toMatchObject({ made: undefined, waiting: 1 });
  });
  it("on the other branch the old answer stays", () => {
    expect(steps(plan(3), versions, asked)[0].answers[0].choice).toBe("List");
  });
  it("cuts a note to 6 words", () => expect(chip(versions[3].madeBy![0])).toBe("Graph: tree only please, no extra library…"));
});
