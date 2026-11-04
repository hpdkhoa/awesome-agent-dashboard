import { collection, doc, getDoc, getDocs, query, setDoc, where } from "firebase/firestore";
import { db } from "./firebase";
import { removeRows } from "./storeData";

// Delete a record with its linked records (the owner's choice, 2026-11-03: "Also delete the linked records, after
// showing a list to confirm"). Links go down only: a session to its runs, plans, inbox items and heartbeat; a run to
// its inbox items, the plan it made and the stop commands aimed at it; a plan to its versions, steps, questions and
// messages. A run never takes its session with it. Files on the PC stay (the owner's choice: "Leave them").
// Delete also stops the work (the owner's choice, 2026-11-03: "Delete also stops the session's work: the bridge stops
// its runs, and the confirm list says "1 running, will be stopped". A session open in the Claude app can't be stopped
// from the dashboard, so the list warns about it instead").
export type Linked = { path: string; label: string; running?: string; openInApp?: boolean };

const RUNNING = new Set(["running", "stopping"]);
const LIVE_MS = 180_000; // the bridge's own rule: a heartbeat older than 3 minutes is a closed session
const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 20);

const LINKS: Record<string, [string, string][]> = {
  sessions: [["commands", "sessionId"], ["commands", "sourceSessionId"], ["inbox", "sessionId"], ["plans", "sessionId"]],
  commands: [["inbox", "commandId"], ["commands", "target"], ["plans", "source.commandId"]],
  plans: [["planVersions", "planId"], ["planSteps", "planId"], ["planHarness", "planId"], ["inbox", "planId"], ["commands", "planId"]],
};

const text = (d: Record<string, unknown>) =>
  String(d.title ?? d.note ?? d.prompt ?? d.stepId ?? d.date ?? d.action ?? "").split("\n")[0].slice(0, 80);

export async function linkedRecords(path: string): Promise<Linked[]> {
  const out = new Map<string, Linked>();
  const todo = [path];
  while (todo.length) {
    const p = todo.shift()!;
    if (out.has(p)) continue;
    const [name, id] = p.split("/");
    const snap = await getDoc(doc(db, name, id));
    if (!snap.exists() && p !== path) continue; // a session with no heartbeat
    const d = snap.data() ?? {};
    out.set(p, { path: p, label: snap.exists() ? text(d) : "",
      running: name === "commands" && RUNNING.has(String(d.status)) ? String(d.machine ?? "") : undefined,
      openInApp: name === "liveSessions" && Date.now() - Date.parse(String(d.beatAt)) < LIVE_MS });
    if (name === "sessions") todo.push(`liveSessions/${id}`);
    for (const [coll, field] of LINKS[name] ?? []) {
      const rows = await getDocs(query(collection(db, coll), where(field, "==", id)));
      rows.forEach((d) => todo.push(`${coll}/${d.id}`));
    }
  }
  const list = [...out.values()];
  // a fresh heartbeat with a bridge run behind it is that run, which the bridge stops; any other is the Claude app
  for (const x of list.filter((y) => y.openInApp)) {
    const sid = x.path.split("/")[1];
    const runs = await getDocs(query(collection(db, "commands"), where("sessionId", "==", sid)));
    if (runs.docs.some((r) => RUNNING.has(String(r.data().status)))) x.openInApp = false;
  }
  return list;
}

// One stop per running run, sent before the delete; the bridge kills the run and deletes the stop too.
export async function stopRunning(list: Linked[]) {
  for (const x of list.filter((y) => y.running !== undefined)) {
    const id = newId();
    await setDoc(doc(db, "commands", id), { id, action: "stop", machine: x.running, target: x.path.split("/")[1], deleting: true,
      status: "new", createdAt: new Date().toISOString() });
  }
}

export async function deleteRecords(paths: string[]) {
  const by = new Map<string, string[]>();
  for (const p of paths) by.set(p.split("/")[0], [...(by.get(p.split("/")[0]) ?? []), p]);
  for (const [name, ps] of by) await removeRows(name, ps);
}
