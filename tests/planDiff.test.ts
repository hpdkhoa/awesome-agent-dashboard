// A plan with six parts: the line diff between plan versions, each part as lines, and #n links to the log pages.
import { describe, expect, it } from "vitest";
import type { Parts, Plan } from "../web/src/data";
import { diffLines, linkEntries, partLines } from "../web/src/planDiff";

const parts: Parts = {
  goal: "ship it\n\n(#3)", summary: "- built x (#12)",
  rules: [{ rule: "no bypass", source: "#3" }],
  lessons: [{ lesson: "sort the queue", taughtBy: "#9", appliedIn: "runs.py" }],
  leftover: ["read count"], steps: [{ id: "s1", title: "Count", does: "count reads", check: "a number" }],
};

describe("plan parts", () => {
  it("diffs lines in order: kept, removed, added", () => {
    expect(diffLines(["a", "b", "c"], ["a", "x", "c", "d"])).toEqual([
      { op: "same", text: "a" }, { op: "del", text: "b" }, { op: "add", text: "x" }, { op: "same", text: "c" }, { op: "add", text: "d" },
    ]);
    expect(diffLines([], [])).toEqual([]);
  });

  it("turns each part into lines", () => {
    expect(partLines(parts, "goal")).toEqual(["ship it", "(#3)"]);
    expect(partLines(parts, "lessons")).toEqual(["sort the queue · taught by #9 · applied in runs.py"]);
    expect(partLines(parts, "steps")).toEqual(["s1 Count: count reads · check: a number"]);
  });

  it("links #n to the page that holds entry n, and leaves other #n alone", () => {
    const plan = { source: { pagesDir: "C:\\d\\p1", pages: [{ file: "page-01.txt", first: 1, last: 10 }, { file: "page-02.txt", first: 11, last: 20 }] } } as Plan;
    expect(linkEntries("built x (#12) and #3, not #99 or a#5", plan)).toBe(
      "built x ([#12](<C:/d/p1/page-02.txt>)) and [#3](<C:/d/p1/page-01.txt>), not #99 or a#5");
    expect(linkEntries("#3", {} as Plan)).toBe("#3");
  });
});
