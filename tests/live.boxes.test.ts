// A live check of the page's database adapter (web/src/fs.ts) against real bridges, run by hand:
//   AAD_LIVE_BOX1=http://127.0.0.1:8793 AAD_LIVE_TOKEN=<owner id token> AAD_LIVE_BOX2=http://127.0.0.1:8899 npx vitest run tests/live.boxes.test.ts
// Box 1 is the owner's running bridge (only a scratch collection is written, and removed); box 2 is a scratch bridge
// (bridge/scripts/scratch_box.py). Skipped in the normal test run. The owner's words, 2026-11-13: "multi box validate
// still use full function while only one box, right? if all function working then merge it."
import { describe, expect, it, vi } from "vitest";

const BOX1 = process.env.AAD_LIVE_BOX1 ?? "";
const BOX2 = process.env.AAD_LIVE_BOX2 ?? "";
const TOKEN = process.env.AAD_LIVE_TOKEN ?? "";
const NAME1 = process.env.AAD_LIVE_NAME1 ?? "PC";

const state = vi.hoisted(() => ({ boxes: [] as Record<string, unknown>[], backupReads: 0, backupWrites: 0 }));
vi.mock("../web/src/firebase", () => ({ db: {}, auth: { currentUser: { getIdToken: async () => process.env.AAD_LIVE_TOKEN } } }));
vi.mock("firebase/firestore", () => {
  const snap = (rows: Record<string, unknown>[]) => ({ docs: rows.map((r) => ({ id: String(r.name ?? r.id ?? "x"), data: () => r, exists: () => true })) });
  return {
    collection: (_db: unknown, name: string) => ({ name }), doc: (_db: unknown, c: string, id: string) => ({ c, id }),
    query: (c: { name: string }) => c, where: () => ({}), orderBy: () => ({}), limit: () => ({}), startAfter: () => ({}),
    getDocs: async (c: { name: string }) => (c.name === "bridges" ? snap(state.boxes) : (state.backupReads++, snap([{ id: "from-backup" }]))),
    getDoc: async () => (state.backupReads++, { exists: () => false, data: () => undefined }),
    getCountFromServer: async () => (state.backupReads++, { data: () => ({ count: 7 }) }),
    onSnapshot: () => () => undefined,
    setDoc: async () => void state.backupWrites++, updateDoc: async () => void state.backupWrites++, deleteDoc: async () => void state.backupWrites++,
    writeBatch: () => ({ set() {}, update() {}, delete() {}, commit: async () => void state.backupWrites++ }),
  };
});

const fs = await import("../web/src/fs");
const { registry } = await import("../web/src/bridge");
const { collection, doc, getCountFromServer, getDoc, getDocs, limit, onSnapshot, orderBy, query, setDoc, updateDoc, deleteDoc, where, writeBatch, reloadBoxes } = fs;
const db = null;
const box = (name: string, url: string, extra: Record<string, unknown> = {}) => ({ name, url, db: "local", plugged: true, ...extra });
const use = async (...boxes: Record<string, unknown>[]) => {
  state.boxes = boxes;
  await registry(true);
  await reloadBoxes();
};
const raw = async (url: string, body: unknown) =>
  (await fetch(url + "/data", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const T = "selftest";

describe.skipIf(!BOX1 || !TOKEN)("one box: every function of the adapter on the owner's bridge", () => {
  it("reads: a sorted, limited list; one record; a count; a filter", async () => {
    await use(box(NAME1, BOX1));
    const plans = await getDocs(query(collection(db, "plans"), orderBy("updatedAt", "desc"), limit(3)));
    expect(plans.docs.length).toBeGreaterThan(0);
    const at = plans.docs.map((d) => String(d.data().updatedAt));
    expect([...at].sort().reverse()).toEqual(at);
    const one = await getDoc(doc(db, "plans", plans.docs[0].id));
    expect(one.exists() && one.data()?.title).toBe(plans.docs[0].data().title);
    expect((await getDoc(doc(db, "plans", "no-such-plan"))).exists()).toBe(false);
    const n = (await getCountFromServer(collection(db, "commands"))).data().count;
    expect(n).toBe((await raw(BOX1, { op: "count", coll: "commands" })).count);
    const open = await getDocs(query(collection(db, "inbox"), where("status", "in", ["open", "answered", "delivering"]), limit(10)));
    expect(open.docs.every((d) => ["open", "answered", "delivering"].includes(String(d.data().status)))).toBe(true);
    expect(state.backupReads).toBe(0); // nothing came from Firestore
  });

  it("writes and live updates: set, merge, update, a listener that hears a change, batch, delete, a missing record", async () => {
    await use(box(NAME1, BOX1));
    const ref = doc(db, T, "a1");
    await setDoc(ref, { id: "a1", n: 1, items: { x: 1 }, createdAt: "1" });
    await setDoc(ref, { items: { y: 2 } }, { merge: true });
    expect((await getDoc(ref)).data()).toEqual({ id: "a1", n: 1, items: { x: 1, y: 2 }, createdAt: "1" });
    const heard: number[] = [];
    const stop = onSnapshot(query(collection(db, T), orderBy("createdAt", "desc")), (s) => heard.push(s.docs.length));
    const one: unknown[] = [];
    const stopDoc = onSnapshot(ref, (s) => one.push(s.data()?.n));
    await wait(800);
    expect(heard).toEqual([1]);
    await updateDoc(ref, { n: 2 });
    const b = writeBatch(db);
    b.set(doc(db, T, "a2"), { id: "a2", createdAt: "2" });
    b.set(doc(db, T, "a3"), { id: "a3", createdAt: "3" });
    await b.commit();
    await wait(2500);
    expect(heard[heard.length - 1]).toBe(3); // the listener heard the batch without asking
    expect(one).toEqual([1, 2]);
    stop();
    stopDoc();
    await expect(updateDoc(doc(db, T, "nope"), { n: 1 })).rejects.toMatchObject({ code: "not-found" });
    for (const id of ["a1", "a2", "a3"]) await deleteDoc(doc(db, T, id));
    expect((await getDocs(collection(db, T))).docs.length).toBe(0);
    expect(state.backupReads + state.backupWrites).toBe(0);
  });
});

describe.skipIf(!BOX1 || !BOX2 || !TOKEN)("two boxes: plug, merge, route, unplug, a box that goes off", () => {
  it("plug a second box in: one merged list; a new record goes to the box its machine names; a change goes back to its box", async () => {
    await use(box(NAME1, BOX1), box("box2", BOX2));
    await setDoc(doc(db, T, "p1"), { id: "p1", machine: NAME1, createdAt: "5" });
    await setDoc(doc(db, T, "q1"), { id: "q1", machine: "box2", createdAt: "4" });
    await setDoc(doc(db, T, "q2"), { id: "q2", machine: "box2", createdAt: "6" });
    expect((await raw(BOX1, { op: "count", coll: T })).count).toBe(1);
    expect((await raw(BOX2, { op: "count", coll: T })).count).toBe(2);
    const all = await getDocs(query(collection(db, T), orderBy("createdAt", "desc")));
    expect(all.docs.map((d) => d.id)).toEqual(["q2", "p1", "q1"]);
    expect((await getDocs(query(collection(db, T), orderBy("createdAt", "desc"), limit(2)))).docs.map((d) => d.id)).toEqual(["q2", "p1"]);
    expect((await getCountFromServer(collection(db, T))).data().count).toBe(3);
    await updateDoc(doc(db, T, "q1"), { done: true });
    expect((await raw(BOX2, { op: "get", path: `${T}/q1` })).doc.done).toBe(true);
    expect((await raw(BOX1, { op: "get", path: `${T}/q1` })).doc).toBeNull();
    await setDoc(doc(db, "meta", "selftest"), { v: 1 }); // a setting: every box gets it
    expect((await raw(BOX1, { op: "get", path: "meta/selftest" })).doc).toEqual({ v: 1 });
    expect((await raw(BOX2, { op: "get", path: "meta/selftest" })).doc).toEqual({ v: 1 });
  });

  it("unplug it: its records leave the lists, its data stays on the box; plug in: they are back", async () => {
    await use(box(NAME1, BOX1), box("box2", BOX2, { plugged: false }));
    expect((await getDocs(query(collection(db, T), orderBy("createdAt", "desc")))).docs.map((d) => d.id)).toEqual(["p1"]);
    expect((await raw(BOX2, { op: "count", coll: T })).count).toBe(2);
    await use(box(NAME1, BOX1), box("box2", BOX2));
    expect((await getDocs(collection(db, T))).docs.length).toBe(3);
  });

  it("a box that does not answer: the other box still serves; every box off: the backup, read-only", async () => {
    await use(box(NAME1, BOX1), box("dead", "http://127.0.0.1:9"));
    expect((await getDocs(query(collection(db, T), orderBy("createdAt", "desc")))).docs.map((d) => d.id)).toEqual(["p1"]);
    expect(state.backupReads).toBe(0);
    await use(box("dead", "http://127.0.0.1:9"));
    const fromBackup = await getDocs(collection(db, T));
    expect(fromBackup.docs.map((d) => d.id)).toEqual(["from-backup"]);
    await expect(setDoc(doc(db, T, "z"), { id: "z" })).rejects.toThrow(/read-only|off/);
    expect(state.backupWrites).toBe(0);
  });

  it("clean up", async () => {
    await use(box(NAME1, BOX1), box("box2", BOX2));
    for (const id of ["p1", "q1", "q2"]) await deleteDoc(doc(db, T, id));
    await deleteDoc(doc(db, "meta", "selftest"));
    expect((await getDocs(collection(db, T))).docs.length).toBe(0);
    expect((await raw(BOX1, { op: "get", path: "meta/selftest" })).doc).toBeNull();
  });
});
