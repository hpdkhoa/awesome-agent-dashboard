// Step s11: the count of past recommended picks matches a hand count, and nothing is ever answered by it.
import { describe, expect, it } from "vitest";
import type { InboxItem } from "../web/src/data";
import { clearHistory, groupFor, missingPicks, pastPicks } from "../web/src/pastPicks";

const q = (id: string, planId: string, rec: number | null, choice: string | null, extra: Partial<InboxItem> = {}) =>
  ({ id, planId, kind: "question", multi: false, recommended: rec, options: [{ label: "A", detail: "" }, { label: "B", detail: "" }],
    answer: choice ? { choice, text: "", at: "x" } : null, ...extra }) as unknown as InboxItem;

describe("past picks", () => {
  const items = [
    q("1", "kpi", 0, "A"), q("2", "kpi", 1, "B"), q("3", "kpi", 0, "A"), q("4", "dash", 0, "B"),
    q("5", "dash", 0, null), q("6", "dash", null, "A"), q("7", "", 0, "A"), q("8", "dash", 0, "A", { multi: true }),
    q("9", "dash", 0, "A", { kind: "suggestion" }),
  ];
  it("counts answered plan questions with a recommended option, by hand: 3 of 4, this plan 3 of 3", () => {
    expect(pastPicks(items)).toEqual({ picked: 3, total: 4 });
    expect(pastPicks(items, "", "kpi")).toEqual({ picked: 3, total: 3 });
    expect(pastPicks(items, "4", "dash")).toEqual({ picked: 0, total: 0 });
  });
  it("never fills an answer", () => {
    const before = JSON.stringify(items);
    pastPicks(items, "5");
    expect(JSON.stringify(items)).toBe(before);
    expect(items[4].answer).toBeNull();
  });
});

describe("grouping", () => {
  const past = Array.from({ length: 6 }, (_, k) => q(`p${k}`, "old", 0, "A"));
  const open = (id: string, plan: string, at: string, extra: Partial<InboxItem> = {}) =>
    q(id, plan, 0, null, { status: "open", createdAt: at, ...extra } as Partial<InboxItem>);
  const w1 = open("w1", "kpi", "2026-11-07T01"), w2 = open("w2", "kpi", "2026-11-07T00"), w3 = open("w3", "dash", "2026-11-07T02");
  it("groups the waiting questions of one plan, oldest first, when the history is clear (6 of 6)", () => {
    const items = [...past, w1, w2, w3];
    expect(clearHistory(items)).toBe(true);
    expect(groupFor(items, w1).map((i) => i.id)).toEqual(["w2", "w1"]);
    expect(groupFor(items, w3)).toEqual([]); // alone on its plan
  });
  it("does not group when the history is short or mixed, or for a multi-select", () => {
    expect(groupFor([...past.slice(0, 4), w1, w2], w1)).toEqual([]); // 4 answered, under 5
    const mixed = [...past, q("x1", "old", 0, "B"), w1, w2]; // 6 of 7 = 86 %
    expect(groupFor(mixed, w1)).toEqual([]);
    expect(groupFor([...past, w1, open("m", "kpi", "x", { multi: true })], w1)).toEqual([]);
  });
  it("Send needs every pick; nothing is filled in", () => {
    expect(missingPicks([w1, w2], { w1: "A" })).toEqual(["w2"]);
    expect(missingPicks([w1, w2], { w1: "A", w2: "B" })).toEqual([]);
    expect(w1.answer).toBeNull();
  });
});
