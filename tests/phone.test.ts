// Step i7, phone-first inbox: the swipe, the card moves and the dots (the owner's picks 2026-11-12).
import { describe, expect, it } from "vitest";
import { dotState, nextTodo, step, swipeDir } from "../web/src/phone";
import type { InboxItem } from "../web/src/data";

const q = (id: string, status = "open", draft = false) =>
  ({ id, status, ...(draft ? { draft: { choice: "A", text: "", at: "x" } } : {}) }) as unknown as InboxItem;

describe("phone inbox", () => {
  it("a swipe is 50 px or more and mostly sideways; a scroll is not a swipe", () => {
    expect(swipeDir(-80, 10)).toBe(-1);
    expect(swipeDir(80, 10)).toBe(1);
    expect(swipeDir(-40, 0)).toBe(0);
    expect(swipeDir(-60, 50)).toBe(0);
  });
  it("moves stay inside the batch", () => {
    expect(step(0, 3, -1)).toBe(0);
    expect(step(1, 3, 1)).toBe(2);
    expect(step(2, 3, 1)).toBe(2);
  });
  it("a tap goes to the next question still to answer, -1 when all are saved", () => {
    const b = [q("a"), q("b", "open", true), q("c")];
    expect(nextTodo(b, 0, new Set(["a"]))).toBe(2);
    expect(nextTodo(b, 2, new Set(["c"]))).toBe(0);
    expect(nextTodo(b, 2, new Set(["a", "c"]))).toBe(-1);
  });
  it("dots: shown, saved, to answer", () => {
    expect(dotState([q("a", "answered"), q("b"), q("c", "open", true)], 1)).toEqual(["saved", "now", "saved"]);
  });
});
