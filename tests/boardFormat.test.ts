// s6 of plan 44fc4979: the page's Update board gaps match the bridge's (bridge/tests/test_boardformat.py).
import { describe, expect, it } from "vitest";
import { boardGaps } from "../web/src/boardFormat";
import type { Parts } from "../web/src/data";

const steps = [{ id: "s1", title: "a" }, { id: "s2", title: "b" }] as Parts["steps"];
const card = { for: "f", action: "a", how: "h", done: "d", missed: "nothing" };

describe("boardGaps", () => {
  it("is empty for the latest format", () => {
    const p = { steps, board: { whatFor: "x", idea: ["i"], product: [], glossary: [{ term: "t", means: "m" }],
      stepCards: [{ step: "s1", ...card }, { step: "s2", ...card }] } } as unknown as Parts;
    expect(boardGaps(p)).toEqual([]);
  });
  it("names each gap of an old board", () => {
    const p = { steps, board: { whatFor: "x", idea: ["1", "2", "3", "4", "5"], product: [],
      stepCards: [{ step: "s1", for: "f", how: "h" }] } } as unknown as Parts;
    expect(boardGaps(p)).toEqual(["no step card: s2", "step cards without Action: s1", "step cards without Done: s1", "step cards without Missed: s1",
      "no glossary", "idea over 4 lines with no idea groups"]);
    expect(boardGaps({ steps } as unknown as Parts)).toEqual(["no board"]);
  });
});
