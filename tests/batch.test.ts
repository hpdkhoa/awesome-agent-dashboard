// A batch (the owner's words, 2026-11-07): your saved answers can change until the last question is saved; then all are
// sent, each with its latest answer, and the thread keeps every saved answer and question back.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc } from "firebase/firestore";
import type { InboxItem } from "../web/src/data";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../web/src/firebase", () => ({ get db() { return state.db; } }));
const fsShim = await import("../web/src/fs");
fsShim.forceSource("firestore"); // the page's logic against the emulator; the bridge path has its own tests
const { askBack, batchOf, saveDraft, sendBatch } = await import("../web/src/data");

let env: RulesTestEnvironment;
beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-batch",
    firestore: { host: "127.0.0.1", port: 8080, rules: "rules_version = '2'; service cloud.firestore { match /databases/{d}/documents { match /{x=**} { allow read, write: if true; } } }" },
  });
  state.db = env.unauthenticatedContext().firestore();
});
beforeEach(() => env.clearFirestore());
afterAll(() => env.cleanup());

const get = async (id: string) => (await getDoc(doc(state.db as never, "inbox", id))).data() as InboxItem;
const q = (id: string, k: number) => ({ id, kind: "question", status: "open", title: id, text: "", options: [{ label: "A", detail: "" }, { label: "B", detail: "" }],
  recommended: 0, files: [], answer: null, batchId: "b1", batchIndex: k, batchSize: 2, createdAt: "x" }) as unknown as InboxItem;

describe("a batch", () => {
  it("keeps the latest saved answer, sends all once the last is saved, and keeps the thread", async () => {
    for (const x of [q("q2", 1), q("q1", 0)]) await setDoc(doc(state.db as never, "inbox", x.id), x);
    expect(batchOf(q("q2", 1), [q("q2", 1), q("q1", 0)]).map((i) => i.id)).toEqual(["q1", "q2"]);
    await saveDraft(await get("q1"), [await get("q1"), await get("q2")], "A", "");
    await saveDraft(await get("q1"), [await get("q1"), await get("q2")], "B", "because"); // changed: B wins
    expect((await get("q1")).status).toBe("open");
    await askBack(await get("q2"), "what is B?");
    await saveDraft(await get("q2"), [await get("q1"), await get("q2")], "", "my own answer");
    const [a, b] = [await get("q1"), await get("q2")];
    expect([a.status, a.answer?.choice, a.answer?.text]).toEqual(["answered", "B", "because"]);
    expect([b.status, b.answer?.choice, b.answer?.text]).toEqual(["answered", "", "my own answer"]);
    expect(a.thread?.map((t) => t.choice)).toEqual(["A", "B"]);
    expect(b.thread?.map((t) => t.kind)).toEqual(["ask", "answer"]);
  });

  // step i7, the owner's pick "Tap = save, go to next; Send at the end": on the phone the last save never sends
  it("phone: saving every question sends nothing until Send, then sends each latest answer", async () => {
    for (const x of [q("q1", 0), q("q2", 1)]) await setDoc(doc(state.db as never, "inbox", x.id), x);
    await saveDraft(await get("q1"), [await get("q1"), await get("q2")], "A", "", false);
    await expect(sendBatch([await get("q1"), await get("q2")])).rejects.toThrow("every question");
    await saveDraft(await get("q2"), [await get("q1"), await get("q2")], "B", "", false);
    await saveDraft(await get("q2"), [await get("q1"), await get("q2")], "A", "changed", false);
    expect([(await get("q1")).status, (await get("q2")).status]).toEqual(["open", "open"]);
    await sendBatch([await get("q1"), await get("q2")]);
    const [a, b] = [await get("q1"), await get("q2")];
    expect([a.status, a.answer?.choice, b.status, b.answer?.choice, b.answer?.text]).toEqual(["answered", "A", "answered", "A", "changed"]);
  });
});
