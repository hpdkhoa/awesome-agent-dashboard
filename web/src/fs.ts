// The page's database calls, with the names the Firestore SDK has, served by the bridges' local databases (the owner's
// words, 2026-11-13: "switch firestore into local DB in the place bridge is hosted, and then use the bridge to read and
// write to that DB, firestore can keep as backup but I want to least the read request from firestore"; then: "use
// firestore as control plane, the bridge and data on dashboard will select directly from each bridge ... each bridge
// give out their data and dashboard will render all data after filter in dashboard side").
//
// - Every plugged box (bridge.ts) is asked; the answers are merged by id, sorted and cut here. A record belongs to the
//   box that gave it: its updates and deletes go back there. A new record goes to the box its `machine` names, or to
//   the box that holds its plan; settings (meta, pushSubs) go to every box.
// - Live updates: one open "changes" call per box; a listener asks again only when its collection changed there.
// - A box is off: its records are missing until it is back; the header says which. Every box is off (the owner's pick
//   1b): reads fall back to the Firestore backup, read-only. Every 30 s the page tries the boxes again.
// - No box keeps its data locally yet (before the import, or DB=firestore): Firestore itself, as before the switch.
// Money (moneyData.ts) stays on Firestore itself (the owner's pick 2b) and does not come through here.
import * as fb from "firebase/firestore";
import { useEffect, useState } from "react";
import { BridgeDown, boxes, NoDataApi, postTo, type Box } from "./bridge";
import { db as realDb } from "./firebase";
import { mergeRows, targetOf, type Row, type Write } from "./fanout";

type Filter = [string, string, unknown];
export type QueryConstraint =
  | { t: "where"; f: Filter }
  | { t: "orderBy"; field: string; desc: boolean }
  | { t: "limit"; n: number }
  | { t: "startAfter"; snap: QueryDocumentSnapshot };
type CollRef = { kind: "coll"; name: string };
type DocRef = { kind: "doc"; coll: string; id: string; path: string };
type Query = { kind: "query"; name: string; cons: QueryConstraint[] };
type Data = Record<string, unknown>;

export type QueryDocumentSnapshot = { id: string; data: () => Data; exists: () => true; ref: DocRef };
export type DocumentSnapshot = { id: string; data: () => Data | undefined; exists: () => boolean; ref: DocRef };
export type QuerySnapshot = {
  docs: QueryDocumentSnapshot[]; size: number; empty: boolean;
  forEach: (fn: (d: QueryDocumentSnapshot) => void) => void; docChanges: () => { doc: QueryDocumentSnapshot }[];
};

export const collection = (_db: unknown, name: string): CollRef => ({ kind: "coll", name });
export function doc(_db: unknown, a: string, b?: string): DocRef {
  const [coll, id] = b === undefined ? a.split("/") : [a, b];
  return { kind: "doc", coll, id, path: `${coll}/${id}` };
}
export const where = (field: string, op: string, value: unknown): QueryConstraint => ({ t: "where", f: [field, op, value] });
export const orderBy = (field: string, dir: "asc" | "desc" = "asc"): QueryConstraint => ({ t: "orderBy", field, desc: dir === "desc" });
export const limit = (n: number): QueryConstraint => ({ t: "limit", n });
export const startAfter = (snap: QueryDocumentSnapshot): QueryConstraint => ({ t: "startAfter", snap });
export const query = (c: CollRef | Query, ...cons: QueryConstraint[]): Query =>
  c.kind === "coll" ? { kind: "query", name: c.name, cons } : { kind: "query", name: c.name, cons: [...c.cons, ...cons] };

// the boxes and where the data comes from now -----------------------------------------------------------------------
export type Source = "bridge" | "backup" | "firestore";
export type BoxState = { name: string; url: string; up: boolean };
type Live = Box & { up: boolean; seq: number; pumping: boolean };
let live: Live[] | null = null;
let source: Source = "bridge";
const owners = new Map<string, string>(); // record path -> the url of the box that gave it
const seen = new Set<() => void>();
const tell = () => seen.forEach((f) => f());

export const forceSource = (s: Source) => setSource(s); // tests, and nothing else: the page's logic against the emulator
export const usingBackup = () => source !== "bridge"; // any read from Firestore itself, backup or not
export function useSource(): { source: Source; boxes: BoxState[] } {
  const snap = () => ({ source, boxes: (live ?? []).map((b) => ({ name: b.name, url: b.url, up: b.up })) });
  const [s, setS] = useState(snap);
  useEffect(() => {
    const f = () => setS(snap());
    seen.add(f);
    f();
    return () => {
      seen.delete(f);
    };
  }, []);
  return s;
}

async function all(): Promise<Live[]> {
  if (!live) live = (await boxes()).map((b) => ({ ...b, up: true, seq: -1, pumping: false }));
  return live;
}
// The registry changed (a box plugged or unplugged): take the new list, keep what is known about the old boxes.
export async function reloadBoxes(): Promise<void> {
  const old = live ?? [];
  live = (await boxes()).map((b) => old.find((o) => o.url === b.url) ?? { ...b, up: true, seq: -1, pumping: false });
  if (source !== "firestore") setSource("bridge", true);
  tell();
}

let retry: ReturnType<typeof setTimeout> | null = null;
function setSource(s: Source, again = false) {
  if (s === source && !again) return;
  source = s;
  tell();
  for (const l of listeners) restart(l);
  if (s === "bridge") for (const b of live ?? []) void pump(b);
}
function retryLater() {
  if (retry) return;
  retry = setTimeout(async () => {
    retry = null;
    for (const b of (live ?? []).filter((x) => !x.up)) {
      try {
        await postTo(b.url, "/data", { op: "seq" });
        mark(b, true);
      } catch {
        // still off
      }
    }
    if ((live ?? []).some((x) => !x.up)) retryLater();
  }, 30000);
}
function mark(b: Live, up: boolean) {
  if (b.up === up) return;
  b.up = up;
  if (!up) {
    b.seq = -1;
    retryLater();
  }
  const anyUp = (live ?? []).some((x) => x.up);
  if (source !== "firestore") {
    if (!anyUp) setSource("backup");
    else if (source === "backup") setSource("bridge");
    else {
      for (const l of listeners) void refresh(l); // one box came or went: every list is asked again
      if (up) void pump(b);
    }
  }
  tell();
}
const READ_ONLY = "The PC is off: the page shows the Firestore backup, read-only. Try again when the bridge is back.";

async function callBox<T>(b: Live, body: unknown, signal?: AbortSignal): Promise<T> {
  try {
    const r = await postTo<T>(b.url, "/data", body, signal);
    mark(b, true);
    return r;
  } catch (e) {
    if (e instanceof NoDataApi) {
      if ((live ?? []).length <= 1) setSource("firestore");
      else mark(b, false);
    } else if (e instanceof BridgeDown && !signal?.aborted) mark(b, false);
    throw e;
  }
}
// The boxes that answer now; empty: use Firestore (the backup, or Firestore itself).
async function ups(): Promise<Live[]> {
  if (source !== "bridge") return [];
  return (await all()).filter((b) => b.up);
}

// snapshots ---------------------------------------------------------------------------------------------------------
const docSnap = (ref: DocRef, data: Data | null | undefined): DocumentSnapshot =>
  ({ id: ref.id, data: () => data ?? undefined, exists: () => data != null, ref });
function querySnap(name: string, rows: Row[], before?: Map<string, string>): QuerySnapshot {
  const docs = rows.map((r) => ({ id: r.id, data: () => r.data, exists: () => true as const, ref: doc(null, name, r.id) }));
  const changed = before ? docs.filter((d) => before.get(d.id) !== JSON.stringify(d.data())) : docs;
  const gone = before ? [...before.keys()].filter((id) => !rows.some((r) => r.id === id)).length : 0;
  return {
    docs, size: docs.length, empty: docs.length === 0, forEach: (fn) => docs.forEach(fn),
    docChanges: () => [...changed.map((d) => ({ doc: d })), ...Array.from({ length: gone }, () => ({ doc: docs[0] }))],
  };
}
const fieldOf = (d: Data, path: string) => path.split(".").reduce<unknown>((cur, k) => (cur as Data | undefined)?.[k], d);
function shape(q: Query) {
  const order = q.cons.find((c) => c.t === "orderBy") as Extract<QueryConstraint, { t: "orderBy" }> | undefined;
  const after = q.cons.find((c) => c.t === "startAfter") as Extract<QueryConstraint, { t: "startAfter" }> | undefined;
  const lim = q.cons.find((c) => c.t === "limit") as Extract<QueryConstraint, { t: "limit" }> | undefined;
  return { order, after, limit: lim?.n ?? 0 };
}
function findBody(q: Query) {
  const { order, after, limit: n } = shape(q);
  return {
    op: "find", coll: q.name, filters: q.cons.filter((c) => c.t === "where").map((c) => (c as { f: Filter }).f),
    order: order?.field ?? "", desc: order?.desc ?? false, limit: n,
    ...(after && order ? { after: [fieldOf(after.snap.data(), order.field), after.snap.id] } : {}),
  };
}

// Every box that answers is asked; null: none answered (use Firestore).
async function findAll(q: Query): Promise<Row[] | null> {
  const list = await ups();
  if (!list.length) return null;
  const got = await Promise.allSettled(list.map((b) => callBox<{ docs: Row[] }>(b, findBody(q))));
  const parts: Row[][] = [];
  got.forEach((g, i) => {
    if (g.status !== "fulfilled") return;
    for (const r of g.value.docs) owners.set(`${q.name}/${r.id}`, list[i].url);
    parts.push(g.value.docs);
  });
  if (!parts.length) {
    const hard = got.find((g) => g.status === "rejected" && !(g.reason instanceof BridgeDown)) as PromiseRejectedResult | undefined;
    if (hard) throw hard.reason;
    return null;
  }
  const { order, limit: n } = shape(q);
  return mergeRows(parts, order?.field ?? "", order?.desc ?? false, n, q.name);
}
async function getAll(ref: DocRef): Promise<{ doc: Data | null } | null> {
  const list = await ups();
  if (!list.length) return null;
  const own = owners.get(ref.path);
  const ordered = [...list.filter((b) => b.url === own), ...list.filter((b) => b.url !== own)];
  let answered = false;
  for (const b of ordered) {
    try {
      const d = (await callBox<{ doc: Data | null }>(b, { op: "get", path: ref.path })).doc;
      answered = true;
      if (d) {
        owners.set(ref.path, b.url);
        return { doc: d };
      }
    } catch (e) {
      if (!(e instanceof BridgeDown)) throw e;
    }
  }
  return answered ? { doc: null } : null;
}

// Firestore itself: the backup while every box is off, or the database before the switch ---------------------------
function realQuery(q: Query): fb.Query {
  const { order } = shape(q);
  const cons = q.cons.map((c) =>
    c.t === "where" ? fb.where(c.f[0], c.f[1] as fb.WhereFilterOp, c.f[2])
    : c.t === "orderBy" ? fb.orderBy(c.field, c.desc ? "desc" : "asc")
    : c.t === "limit" ? fb.limit(c.n)
    : fb.startAfter(order ? fieldOf(c.snap.data(), order.field) : c.snap.id));
  return fb.query(fb.collection(realDb, q.name), ...cons);
}
const fromReal = (s: fb.QuerySnapshot): Row[] => s.docs.map((d) => ({ id: d.id, data: d.data() as Data }));

// one-shot reads -----------------------------------------------------------------------------------------------------
export async function getDoc(ref: DocRef): Promise<DocumentSnapshot> {
  const got = await getAll(ref);
  if (got) return docSnap(ref, got.doc);
  const s = await fb.getDoc(fb.doc(realDb, ref.coll, ref.id));
  return docSnap(ref, s.exists() ? (s.data() as Data) : null);
}
export async function getDocs(q: Query | CollRef): Promise<QuerySnapshot> {
  const qq = q.kind === "coll" ? query(q) : q;
  const rows = await findAll(qq);
  return querySnap(qq.name, rows ?? fromReal(await fb.getDocs(realQuery(qq))));
}
export async function getCountFromServer(c: CollRef) {
  const list = await ups();
  if (list.length) {
    const got = await Promise.allSettled(list.map((b) => callBox<{ count: number }>(b, { op: "count", coll: c.name })));
    const ok = got.filter((g) => g.status === "fulfilled") as PromiseFulfilledResult<{ count: number }>[];
    if (ok.length) {
      const n = ok.reduce((a, g) => a + g.value.count, 0);
      return { data: () => ({ count: n }) };
    }
  }
  const s = await fb.getCountFromServer(fb.collection(realDb, c.name));
  return { data: () => ({ count: s.data().count }) };
}

// writes: to the box that owns the record; Firestore only before the switch; the backup is read-only ---------------
const realRef = (path: string) => fb.doc(realDb, path.split("/")[0], path.split("/")[1]);
async function realWrite(ws: Write[]): Promise<void> {
  if (ws.length === 1) {
    const w = ws[0];
    if (w.op === "set") await fb.setDoc(realRef(w.path), w.data, { merge: w.merge });
    else if (w.op === "update") await fb.updateDoc(realRef(w.path), w.fields);
    else await fb.deleteDoc(realRef(w.path));
    return;
  }
  const b = fb.writeBatch(realDb);
  for (const w of ws) {
    if (w.op === "set") b.set(realRef(w.path), w.data, { merge: w.merge });
    else if (w.op === "update") b.update(realRef(w.path), w.fields);
    else b.delete(realRef(w.path));
  }
  await b.commit();
}
async function write(ws: Write[]): Promise<void> {
  if (source === "firestore") return realWrite(ws);
  if (source === "backup") throw new Error(READ_ONLY);
  const everyone = await all();
  const list = everyone.filter((b) => b.up);
  if (!list.length) throw new Error(READ_ONLY);
  const per = new Map<Live, Write[]>();
  const anywhere: Write[] = []; // an update or delete of a record no box has shown yet: every box is asked
  for (const w of ws) {
    const t = targetOf(w, owners, everyone.map((b) => ({ name: b.name, url: b.url })));
    if (t === "all") for (const b of list) per.set(b, [...(per.get(b) ?? []), w]);
    else if (t === "any") anywhere.push(w);
    else {
      const b = everyone.find((x) => x.url === t) ?? list[0];
      if (!b.up) throw new Error(`The box ${b.name || "that holds this record"} is off: try again when its bridge is back.`);
      per.set(b, [...(per.get(b) ?? []), w]);
    }
  }
  try {
    for (const [b, mine] of per) {
      const r = await callBox<{ ok?: boolean }>(b, mine.length === 1 ? mine[0] : { op: "batch", writes: mine });
      if (mine.length === 1 && mine[0].op === "update" && r.ok === false) throw Object.assign(new Error("No such record: it was deleted."), { code: "not-found" });
      for (const w of mine) if (w.op === "set") owners.set(w.path, b.url);
    }
    for (const w of anywhere) {
      const got = await Promise.allSettled(list.map((b) => callBox<{ ok?: boolean }>(b, w)));
      const hit = got.findIndex((g) => g.status === "fulfilled" && g.value.ok !== false);
      if (w.op === "update" && hit < 0) throw Object.assign(new Error("No such record: it was deleted."), { code: "not-found" });
      if (hit >= 0 && w.op === "update") owners.set(w.path, list[hit].url);
    }
  } catch (e) {
    if (e instanceof NoDataApi && (source as Source) === "firestore") return realWrite(ws); // callBox just found the bridge keeps Firestore
    throw e instanceof BridgeDown ? new Error(READ_ONLY) : e;
  }
}
export const setDoc = (ref: DocRef, data: Data, opts?: { merge?: boolean }) => write([{ op: "set", path: ref.path, data, merge: !!opts?.merge }]);
export const updateDoc = (ref: DocRef, fields: Data) => write([{ op: "update", path: ref.path, fields }]);
export const deleteDoc = (ref: DocRef) => write([{ op: "delete", path: ref.path }]);
export function writeBatch(_db: unknown) {
  const writes: Write[] = [];
  return {
    set: (ref: DocRef, data: Data, opts?: { merge?: boolean }) => void writes.push({ op: "set", path: ref.path, data, merge: !!opts?.merge }),
    update: (ref: DocRef, fields: Data) => void writes.push({ op: "update", path: ref.path, fields }),
    delete: (ref: DocRef) => void writes.push({ op: "delete", path: ref.path }),
    commit: () => write(writes),
  };
}

// listeners ----------------------------------------------------------------------------------------------------------
type Listener = {
  target: Query | DocRef; cb: (s: never) => void; before?: Map<string, string>; stopReal?: () => void; gone?: boolean;
};
const listeners = new Set<Listener>();
const collOf = (l: Listener) => (l.target.kind === "doc" ? l.target.coll : l.target.name);

async function refresh(l: Listener): Promise<void> {
  if (l.gone || source !== "bridge") return;
  try {
    if (l.target.kind === "doc") {
      const got = await getAll(l.target);
      if (!got) return;
      const key = JSON.stringify(got.doc);
      if (l.before?.get("doc") === key) return;
      l.before = new Map([["doc", key]]);
      if (!l.gone) (l.cb as (s: DocumentSnapshot) => void)(docSnap(l.target, got.doc));
    } else {
      const rows = await findAll(l.target);
      if (!rows) return;
      const snap = querySnap(l.target.name, rows, l.before);
      if (l.before && snap.docChanges().length === 0) return;
      l.before = new Map(rows.map((r) => [r.id, JSON.stringify(r.data)]));
      if (!l.gone) (l.cb as (s: QuerySnapshot) => void)(snap);
    }
  } catch {
    // a box went away: mark() asked every listener again, or moved them to the backup
  }
}
function restart(l: Listener) {
  l.stopReal?.();
  l.stopReal = undefined;
  l.before = undefined;
  if (l.gone) return;
  if (source === "bridge") void refresh(l);
  else if (l.target.kind === "doc") {
    const ref = l.target;
    l.stopReal = fb.onSnapshot(fb.doc(realDb, ref.coll, ref.id), (s) => (l.cb as (s: DocumentSnapshot) => void)(docSnap(ref, s.exists() ? (s.data() as Data) : null)), () => undefined);
  } else {
    const q = l.target;
    l.stopReal = fb.onSnapshot(realQuery(q), (s) => (l.cb as (s: QuerySnapshot) => void)(querySnap(q.name, fromReal(s))), () => undefined);
  }
}

// one open call per box for every listener: the box answers when something changed there, or after 25 s
async function pump(b: Live): Promise<void> {
  if (b.pumping) return;
  b.pumping = true;
  try {
    while (listeners.size > 0 && source === "bridge" && b.up && (live ?? []).includes(b)) {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        await new Promise((r) => setTimeout(r, 5000)); // a hidden tab asks nothing; its listeners refresh when it shows
        continue;
      }
      try {
        if (b.seq < 0) b.seq = (await callBox<{ seq: number }>(b, { op: "seq" })).seq;
        const r = await callBox<{ seq: number; changes: { path: string; coll: string }[]; reset?: boolean }>(b, { op: "changes", since: b.seq, wait: 25 });
        b.seq = r.seq;
        const colls = new Set(r.changes.map((c) => c.coll));
        const paths = new Set(r.changes.map((c) => c.path));
        for (const l of [...listeners]) {
          if (r.reset || (l.target.kind === "doc" ? paths.has(l.target.path) : colls.has(collOf(l)))) void refresh(l);
        }
      } catch (e) {
        if (!(e instanceof BridgeDown)) await new Promise((r) => setTimeout(r, 3000));
      }
    }
  } finally {
    b.pumping = false;
  }
}
async function pumpAll(): Promise<void> {
  if (source !== "bridge") return;
  for (const b of await all()) void pump(b);
}
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && source === "bridge") {
      for (const b of live ?? []) b.seq = -1; // changes while hidden were not followed: ask every listener once
      for (const l of listeners) void refresh(l);
      void pumpAll();
    }
  });
}

export function onSnapshot(target: DocRef, cb: (s: DocumentSnapshot) => void, onError?: (e: unknown) => void): () => void;
export function onSnapshot(target: Query | CollRef, cb: (s: QuerySnapshot) => void, onError?: (e: unknown) => void): () => void;
export function onSnapshot(target: DocRef | Query | CollRef, cb: ((s: DocumentSnapshot) => void) | ((s: QuerySnapshot) => void)): () => void {
  const l: Listener = { target: target.kind === "coll" ? query(target) : target, cb: cb as (s: never) => void };
  listeners.add(l);
  restart(l);
  void pumpAll();
  return () => {
    l.gone = true;
    l.stopReal?.();
    listeners.delete(l);
  };
}
