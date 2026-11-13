// Delete with linked records (the owner's choice, 2026-11-03): links go down only, the list is what gets deleted, and
// a deleted bridge record (a session) goes on meta/deleted so sync never writes it back.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc } from "firebase/firestore";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../web/src/firebase", () => ({ get db() { return state.db; } }));
const fsShim = await import("../web/src/fs");
fsShim.forceSource("firestore"); // the page's logic against the emulator; the bridge path has its own tests
const { deleteRecords, linkedRecords, stopRunning } = await import("../web/src/links");
const { removeRows } = await import("../web/src/storeData");

let env: RulesTestEnvironment;
beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-links",
    firestore: { host: "127.0.0.1", port: 8080, rules: "rules_version = '2'; service cloud.firestore { match /databases/{d}/documents { match /{x=**} { allow read, write: if true; } } }" },
  });
  state.db = env.unauthenticatedContext().firestore();
});
beforeEach(() => env.clearFirestore());
afterAll(() => env.cleanup());

const put = (p: string, d: Record<string, unknown>) => setDoc(doc(state.db as never, p), d);

describe("delete with linked records", () => {
  it("a session takes its runs, plans with their versions and steps, inbox items and heartbeat; a run never takes its session", async () => {
    await put("sessions/s1", { title: "work" });
    await put("liveSessions/s1", { beatAt: "x" });
    await put("commands/c1", { sessionId: "s1", prompt: "hello" });
    await put("commands/stop1", { action: "stop", target: "c1" });
    await put("commands/p1", { action: "plan", sourceSessionId: "s1" });
    await put("plans/pl1", { sessionId: "s2", title: "made from s1", source: { commandId: "p1" } });
    await put("planVersions/pl1_v1", { planId: "pl1", note: "v1" });
    await put("planSteps/pl1_s1", { planId: "pl1", stepId: "s1" });
    await put("inbox/i1", { sessionId: "s1", title: "q" });
    await put("sessions/s2", { title: "other" });

    const all = (await linkedRecords("sessions/s1")).map((x) => x.path).sort();
    expect(all).toEqual(["commands/c1", "commands/p1", "commands/stop1", "inbox/i1", "liveSessions/s1", "planSteps/pl1_s1",
      "planVersions/pl1_v1", "plans/pl1", "sessions/s1"]);
    expect((await linkedRecords("commands/c1")).map((x) => x.path).sort()).toEqual(["commands/c1", "commands/stop1"]);

    await deleteRecords(all);
    for (const p of all) expect((await getDoc(doc(state.db as never, p))).exists()).toBe(false);
    expect((await getDoc(doc(state.db as never, "sessions/s2"))).exists()).toBe(true);
    const gone = (await getDoc(doc(state.db as never, "meta/deleted"))).data()?.paths ?? {};
    expect(Object.keys(gone)).toEqual(["sessions/s1"]);
  });

  it("marks running runs, sends them a deleting stop, and warns about a session open in the app", async () => {
    const fresh = new Date().toISOString();
    await put("sessions/app", { title: "in the app" });
    await put("liveSessions/app", { beatAt: fresh });
    await put("sessions/run", { title: "a bridge run" });
    await put("liveSessions/run", { beatAt: fresh });
    await put("commands/r1", { sessionId: "run", status: "running", machine: "PC", prompt: "work" });

    const app = await linkedRecords("sessions/app");
    expect(app.find((x) => x.path === "liveSessions/app")?.openInApp).toBe(true);
    const run = await linkedRecords("sessions/run");
    expect(run.find((x) => x.path === "liveSessions/run")?.openInApp).toBe(false);
    expect(run.find((x) => x.path === "commands/r1")?.running).toBe("PC");

    await stopRunning(run);
    const { getDocs, collection, query, where } = await import("firebase/firestore");
    const stops = await getDocs(query(collection(state.db as never, "commands"), where("action", "==", "stop")));
    expect(stops.docs.map((d) => [d.data().target, d.data().machine, d.data().deleting])).toEqual([["r1", "PC", true]]);
  });

  it("the Storage tab's bulk delete of sessions takes each session's heartbeat too", async () => {
    await put("sessions/a", { title: "a" });
    await put("liveSessions/a", { beatAt: "x" });
    await put("sessions/b", { title: "b" });
    await put("liveSessions/b", { beatAt: "x" });
    await put("liveSessions/c", { beatAt: "x" });
    await removeRows("sessions", ["sessions/a", "sessions/b"]);
    for (const p of ["sessions/a", "liveSessions/a", "sessions/b", "liveSessions/b"])
      expect((await getDoc(doc(state.db as never, p))).exists()).toBe(false);
    expect((await getDoc(doc(state.db as never, "liveSessions/c"))).exists()).toBe(true);
  });
});
