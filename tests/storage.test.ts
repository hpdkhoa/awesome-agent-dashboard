import { describe, expect, it } from "vitest";
import { docBytes } from "../web/src/storeData";

describe("document size", () => {
  // The worked example in firebase.google.com/docs/firestore/storage-size: 44 (name) + 71 (fields) + 32 = 147 bytes.
  it("matches Firestore's own example", () => {
    const task = { type: "Personal", done: false, priority: 1, description: "Learn Cloud Firestore" };
    expect(docBytes("users/jeff/tasks/my_task_id", task)).toBe(147);
  });

  it("counts UTF-8 bytes and nested maps", () => {
    expect(docBytes("a/b", { n: "đ" })).toBe(2 + 2 + 16 + (2 + 3) + 32);
    expect(docBytes("a/b", { m: { k: [1, null] } })).toBe(20 + 2 + 2 + 9 + 32);
  });
});
