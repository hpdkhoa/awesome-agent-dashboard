// Step s11: the count of past recommended picks matches a hand count, and nothing is ever answered by it.
import { describe, expect, it } from "vitest";
import type { InboxItem } from "../web/src/data";
import { pastPicks } from "../web/src/pastPicks";

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
