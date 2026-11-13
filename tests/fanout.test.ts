// Many boxes: merging their answers and routing a write (the owner's words, 2026-11-13: "each bridge give out their
// data and dashboard will render all data after filter in dashboard side").
import { describe, expect, it } from "vitest";
import { mergeRows, targetOf } from "../web/src/fanout";

const row = (id: string, at: string) => ({ id, data: { id, createdAt: at } });
const boxes = [{ name: "PC", url: "https://pc" }, { name: "linux", url: "https://linux" }];

describe("merging the boxes' answers", () => {
  it("one list, newest first, cut to the limit, a record once", () => {
    const pc = [row("a", "5"), row("b", "3"), row("c", "1")];
    const linux = [row("x", "4"), row("b", "3"), row("y", "2")];
    expect(mergeRows([pc, linux], "createdAt", true, 4).map((r) => r.id)).toEqual(["a", "x", "b", "y"]);
    expect(mergeRows([pc, linux], "createdAt", false, 0).map((r) => r.id)).toEqual(["c", "y", "b", "x", "a"]);
    expect(mergeRows([pc, []], "", false, 0).length).toBe(3);
  });
});

describe("totals of the same day on two boxes", () => {
  it("adds the numbers, joins the session lists, keeps the later date", () => {
    const pc = [{ id: "2026-11-13", data: { day: "2026-11-13", total: 10, costUsd: 1.5, byModel: { opus: { total: 10 } }, sessions: ["a"], syncedAt: "1" } }];
    const linux = [{ id: "2026-11-13", data: { day: "2026-11-13", total: 5, costUsd: 0.5, byModel: { opus: { total: 2 }, haiku: { total: 3 } }, sessions: ["b"], syncedAt: "2" } }];
    const [d] = mergeRows([pc, linux], "day", true, 0, "usage");
    expect(d.data).toEqual({ day: "2026-11-13", total: 15, costUsd: 2, byModel: { opus: { total: 12 }, haiku: { total: 3 } }, sessions: ["a", "b"], syncedAt: "2" });
    expect(mergeRows([pc, linux], "day", true, 0, "commands")[0].data.total).toBe(10); // other records: once, not added
  });
});

describe("where a write goes", () => {
  const owners = new Map([["plans/p1", "https://linux"], ["commands/c9", "https://pc"]]);
  it("settings go to every box", () => {
    expect(targetOf({ op: "set", path: "meta/runs", data: { model: "opus" }, merge: true }, owners, boxes)).toBe("all");
    expect(targetOf({ op: "set", path: "pushSubs/s1", data: {}, merge: false }, owners, boxes)).toBe("all");
  });
  it("a record goes back to the box that gave it", () => {
    expect(targetOf({ op: "update", path: "commands/c9", fields: { force: true } }, owners, boxes)).toBe("https://pc");
    expect(targetOf({ op: "delete", path: "plans/p1" }, owners, boxes)).toBe("https://linux");
  });
  it("a new run goes to the box its machine names", () => {
    expect(targetOf({ op: "set", path: "commands/n1", data: { machine: "linux", action: "start" }, merge: false }, owners, boxes)).toBe("https://linux");
  });
  it("a plan's records go to the box that holds the plan", () => {
    expect(targetOf({ op: "set", path: "planHarness/p1", data: { items: {} }, merge: true }, owners, boxes)).toBe("https://linux");
    expect(targetOf({ op: "set", path: "planChecks/p1_s3", data: { planId: "p1" }, merge: false }, owners, boxes)).toBe("https://linux");
    expect(targetOf({ op: "update", path: "planChecks/p1_s3", fields: { state: "queued" } }, owners, boxes)).toBe("https://linux");
  });
  it("an unknown record is asked of every box; a new one with nothing to go by goes to the first", () => {
    expect(targetOf({ op: "update", path: "inbox/q7", fields: { status: "answered" } }, owners, boxes)).toBe("any");
    expect(targetOf({ op: "set", path: "inbox/q8", data: {}, merge: false }, owners, boxes)).toBe("https://pc");
  });
});
