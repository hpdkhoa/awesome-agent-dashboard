import {
  collection, doc, getCountFromServer, getDocs, limit, orderBy, query, startAfter, writeBatch,
  type QueryConstraint, type QueryDocumentSnapshot,
} from "firebase/firestore";
import { db } from "./firebase";

// Every collection the page and the bridge write. `bridge`: the bridge writes it again from Claude Code's logs, so a
// delete also goes on meta/deleted and the bridge skips that path from then on (the owner's choice, 2026-11-01, "B1").
// The bridge and the inbox server only update records that exist, so a deleted run, plan, inbox item or heartbeat
// stays deleted (the owner's choice, 2026-11-03).
export const COLLECTIONS: { name: string; label: string; order?: string; bridge?: boolean; show: string[] }[] = [
  { name: "inbox", label: "Inbox items", order: "createdAt", show: ["title", "kind", "status", "createdAt"] },
  { name: "plans", label: "Plans", order: "updatedAt", show: ["title", "status", "current", "updatedAt"] },
  { name: "planSteps", label: "Plan steps", order: "updatedAt", show: ["planId", "stepId", "state", "updatedAt"] },
  { name: "planVersions", label: "Plan versions", order: "createdAt", show: ["planId", "n", "note", "createdAt"] },
  { name: "pushSubs", label: "Phones for notifications", order: "createdAt", show: ["device", "createdAt"] },
  { name: "commands", label: "Runs and messages", order: "createdAt", show: ["action", "status", "prompt", "createdAt"] },
  { name: "sessions", label: "Sessions", order: "lastAt", bridge: true, show: ["title", "workType", "lastAt"] },
  { name: "usage", label: "Spend by day", order: "day", bridge: true, show: ["day", "total", "costUsd"] },
  { name: "workTypes", label: "Work types", bridge: true, show: ["sessions", "lastAt"] },
  { name: "machines", label: "Machines", bridge: true, show: ["name", "syncedAt"] },
  { name: "liveSessions", label: "Session heartbeats", order: "beatAt", show: ["cwd", "beatAt"] },
  { name: "moneyEntries", label: "Money entries", order: "date", show: ["date", "asset", "amount", "note"] },
  { name: "fxRates", label: "Rate snapshots", order: "savedAt", show: ["source", "sourceTime", "savedAt"] },
  { name: "goldPrices", label: "Gold prices", order: "enteredAt", show: ["date", "product", "buy", "sell"] },
];

export const PAGE = 50;

export type Row = { path: string; id: string; data: Record<string, unknown>; bytes: number };

// Firestore's storage size rules (firebase.google.com/docs/firestore/storage-size): a string is its UTF-8 bytes + 1,
// a number 8, a boolean or null 1, a timestamp 8, a map or array the sum of its parts (a map also counts each key as a
// string); a document is its name (each path part as a string, + 16) + its fields + 32.
const enc = new TextEncoder();
const str = (s: string) => enc.encode(s).length + 1;
export function valueBytes(v: unknown): number {
  if (v === null || v === undefined || typeof v === "boolean") return 1;
  if (typeof v === "number") return 8;
  if (typeof v === "string") return str(v);
  if (Array.isArray(v)) return v.reduce((a: number, x) => a + valueBytes(x), 0);
  if (typeof v === "object" && "toMillis" in (v as object)) return 8;
  if (typeof v === "object") return Object.entries(v as object).reduce((a, [k, x]) => a + str(k) + valueBytes(x), 0);
  return 8;
}
export const docBytes = (path: string, data: Record<string, unknown>) =>
  path.split("/").reduce((a, p) => a + str(p), 16) + valueBytes(data) + 32;

// One read per 1,000 documents counted (at least one), so counting all collections costs about 10 reads.
export async function countAll(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await Promise.all(COLLECTIONS.map(async (c) => (out[c.name] = (await getCountFromServer(collection(db, c.name))).data().count)));
  return out;
}

export async function listPage(name: string, after?: QueryDocumentSnapshot) {
  const c = COLLECTIONS.find((x) => x.name === name)!;
  const cons: QueryConstraint[] = [];
  if (c.order) cons.push(orderBy(c.order, "desc"));
  if (after) cons.push(startAfter(after));
  cons.push(limit(PAGE));
  const snap = await getDocs(query(collection(db, name), ...cons));
  const rows: Row[] = snap.docs.map((d) => ({ path: `${name}/${d.id}`, id: d.id, data: d.data(), bytes: docBytes(`${name}/${d.id}`, d.data()) }));
  return { rows, last: snap.docs.at(-1), more: snap.docs.length === PAGE };
}

// Deletes in batches of 400; a bridge path also goes on meta/deleted in the same batch, so the two never disagree.
export async function removeRows(name: string, paths: string[]) {
  const bridge = COLLECTIONS.find((x) => x.name === name)?.bridge;
  const at = new Date().toISOString();
  for (let i = 0; i < paths.length; i += 400) {
    const part = paths.slice(i, i + 400);
    const b = writeBatch(db);
    for (const p of part) b.delete(doc(db, p));
    if (bridge) b.set(doc(db, "meta", "deleted"), { paths: Object.fromEntries(part.map((p) => [p, at])) }, { merge: true });
    await b.commit();
  }
}
