// The harness ticks: an approval holds the item's hash, so an item whose text changes needs approving again.
import { describe, expect, it } from "vitest";
import { approved, buildNote, harnessCount, harnessLine, itemHash, type HarnessItem, type HarnessTicks } from "../web/src/harness";

const h1: HarnessItem = { id: "h1", item: "tests/test_delete.py written, fails now", kind: "check" };
const h2: HarnessItem = { id: "h2", item: "web/src/Storage.tsx and the emulator", kind: "tool" };
const tick = (h: HarnessItem, ok = true) => ({ ok, at: "t", hash: itemHash(h), v: 1 });

describe("harness ticks", () => {
  it("counts an item as approved only with a matching tick", () => {
    const ticks: HarnessTicks = { planId: "p", items: { h1: tick(h1), h2: tick(h2, false) } };
    expect(approved(h1, ticks)).toBe(true);
    expect(approved(h2, ticks)).toBe(false);
    expect(harnessCount([h1, h2], ticks)).toEqual({ done: 1, all: 2 });
    expect(harnessCount([h1, h2], null)).toEqual({ done: 0, all: 2 });
  });

  it("clears the tick when the item's text or kind changes in a later version", () => {
    const ticks: HarnessTicks = { planId: "p", items: { h1: tick(h1) } };
    expect(approved({ ...h1, item: "tests/test_delete.py, 3 cases" }, ticks)).toBe(false);
    expect(approved({ ...h1, kind: "tool" }, ticks)).toBe(false);
  });

  it("writes one diff line per item", () => {
    expect(harnessLine(h2)).toBe("h2 [tool] web/src/Storage.tsx and the emulator");
  });

  it("gives the same hash as the bridge (inbox.py item_hash)", () => {
    expect(itemHash(h1)).toBe("d1e192ba");
  });

  it("tells Run step to use only the approved items", () => {
    const ticks: HarnessTicks = { planId: "p", items: { h1: tick(h1) } };
    expect(buildNote([h1, h2], ticks)).toBe(" Use only the approved harness items: h1. Not approved, left out: h2.");
    expect(buildNote([h1], ticks)).toBe(" Use only the approved harness items: h1.");
    expect(buildNote([], ticks)).toBe("");
  });
});
