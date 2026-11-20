import { describe, expect, it } from "vitest";
import { coverage, covStats, firstSentence, isLogRow } from "../web/src/covCount";

// s4 (plan 44fc4979): the owner's picks "Reachable through a chip" and "Chip targets only"
const LOG = "K:\\x\\OWNER_FEEDBACK.md";
const base = {
  goal: "line one\n\n- line two", rules: ["r1", "r2"], lessons: ["l1"], leftover: ["o1"],
  reports: [{ id: "s1", title: "One" }, { id: "s2", title: "Two" }],
  records: [{ id: "dec:1", title: "d" }, { id: "find:2", title: "f" }],
  logRows: [{ path: LOG, line: 3, text: '| 2026-11-19 | "both a and c" | decision | x |' }, { path: LOG, line: 4, text: "| 2026-11-20 | other | good | y |" }],
};

describe("coverage", () => {
  it("counts what a board chip opens and lists the rest", () => {
    const g = coverage({ ...base, boardIds: ["goal", "s1", "dec:1", `${LOG}#"both a and c"`] });
    const st = covStats(g);
    expect(st.total).toBe(2 + 2 + 1 + 1 + 2 + 2 + 2);
    expect(st.covered).toBe(2 + 1 + 1 + 1);
    expect(g.find((x) => x.source === "rules")!.items.every((i) => !i.covered && i.chip === "rules")).toBe(true);
    expect(g.find((x) => x.source === "feedback log rows")!.items.map((i) => i.covered)).toEqual([true, false]);
    expect(st.lowest?.pct).toBe(0);
  });
  it("a whole-file chip covers every row of that file; a line chip covers its line", () => {
    expect(covStats(coverage({ ...base, boardIds: [LOG.toLowerCase().replace(/\\/g, "/")] })).covered).toBe(2);
    expect(covStats(coverage({ ...base, boardIds: [`${LOG}:4`] })).covered).toBe(1);
  });
  it("labels a record by its first full sentence (the owner's pick 'First sentence of the text')", () => {
    expect(firstSentence("Single features pop out (slope 3.1 ms per item). Conjunctions need a serial search.")).toBe("Single features pop out (slope 3.1 ms per item).");
    expect(firstSentence("no end mark here\nsecond line")).toBe("no end mark here");
  });
  it("reads only dated table rows as log rows", () => {
    expect(isLogRow("| 2026-11-19 | a | b | c |")).toBe(true);
    expect(isLogRow("| Date | Words |")).toBe(false);
  });
});
