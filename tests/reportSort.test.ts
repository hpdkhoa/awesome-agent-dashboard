// The run report card's fields (the owner's pick, 2026-11-15: "A + exact report fields"; "not losing data").
import { describe, expect, it } from "vitest";
import { boardCells, openItems, sortCheck, sortReply } from "../web/src/reportSort";

const reply = [
  "- Built (not committed): button 3 SEND in app.js",
  "- CPU with the avatar closed: 0.34-0.44 % of one core",
  "- Checks: 18 of 18 pass on the live avatar (s1test.py)",
  "| Task | Before | After |",
  "|---|---|---|",
  "| T1 | 0/3 | 3/3 |",
  "- Picture: cc/n3/s1-compare.png",
  "- Not done:",
  "  - Only 1 box is registered, so 2 boxes were not tested",
].join("\n");

describe("run report from a free reply", () => {
  it("places every line in one field and loses no number", () => {
    const { fields } = sortReply(reply);
    expect(fields.built[0]).toMatchObject({ kind: "line", text: "Built (not committed): button 3 SEND in app.js" });
    expect(fields.numbers.map((x) => x.kind)).toEqual(["line", "table"]);
    expect(fields.tests).toHaveLength(1);
    expect(fields.pictures).toHaveLength(1);
    expect(fields.notDone).toHaveLength(2);
    expect(sortCheck(reply)).toMatchObject({ lines: 9, placed: 9, missing: [] });
  });
  it("fills a board row and the open items", () => {
    expect(boardCells(reply)).toMatchObject({ exact: false, built: "button 3 SEND in app.js", tested: "Checks: 18 of 18 pass on the live avatar (s1test.py)", open: 1 });
    expect(openItems(reply)).toEqual(["Only 1 box is registered, so 2 boxes were not tested"]);
  });
});

describe("run report from the fields", () => {
  const rep = { built: ["gate.py"], numbers: [{ metric: "pass rate", before: "3/12", after: "12/12", how: "4 tasks x 3" }],
    tests: [{ method: "pytest tests/test_gate.py", result: "5 pass" }], not_done: [{ item: "Linux box", fix: "s7" }] };
  it("uses the fields as they are", () => {
    expect(boardCells("free text", rep)).toEqual({ exact: true, built: "gate.py", number: "pass rate: 3/12 → 12/12", tested: "pytest tests/test_gate.py: 5 pass", open: 1 });
    expect(openItems("- Not done: x", rep)).toEqual(["Linux box → s7"]);
  });
});
