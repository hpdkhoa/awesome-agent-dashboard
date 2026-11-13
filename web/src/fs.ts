// The page's database calls, with the names the Firestore SDK has, served by the bridge's local database (the owner's
// words, 2026-11-13: "switch firestore into local DB in the place bridge is hosted, and then use the bridge to read and
// write to that DB, firestore can keep as backup but I want to least the read request from firestore").
//
// - The bridge answers (POST /data, bridge/agent_bridge/dataapi.py): every read and write goes there; live updates come
//   from one open "changes" call, and a listener asks again only when its collection changed. 0 Firestore reads.
// - The PC is off (the owner's pick 1b): reads fall back to the Firestore backup, read-only; a write says so. Every 30 s
//   the page tries the bridge again and moves back.
// Money (moneyData.ts) stays on Firestore itself (the owner's pick 2b) and does not come through here.
import * as fb from "firebase/firestore";
import { useEffect, useState } from "react";
import { BridgeDown, bridgePost } from "./bridge";

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

// where the data comes from now -------------------------------------------------------------------------------------
export type Source = "bridge" | "backup";
let source: Source = "bridge";
const sourceSeen = new Set<(s: Source) => void>();
export const usingBackup = () => source === "backup";
export function useSource(): Source {
  const [s, setS] = useState(source);
  useEffect(() => {
    sourceSeen.add(setS);
    setS(source);
    return () => {
      sourceSeen.delete(setS);
    };
  }, []);
  return s;
}
let retry: ReturnType<typeof setTimeout> | null = null;
function setSource(s: Source) {
  if (s === source) return;
  source = s;
  sourceSeen.forEach((f) => f(s));
  for (const l of listeners) restart(l);
  if (s === "backup") tryBridgeLater();
  else void pump();
}
function tryBridgeLater() {
  if (retry) return;
  retry = setTimeout(async () => {
    retry = null;
    try {
      await bridgePost("/data", { op: "seq" });
      setSource("bridge");
    } catch {
      if (source === "backup") tryBridgeLater();
    }
  }, 30000);
}
const READ_ONLY = "The PC is off: the page shows the Firestore backup, read-only. Try again when the bridge is back.";

async function call<T>(body: unknown, signal?: AbortSignal): Promise<T> {
  try {
    const r = await bridgePost<T>("/data", body, signal);
    if (source === "backup") setSource("bridge");
    return r;
  } catch (e) {
    if (e instanceof BridgeDown && !signal?.aborted) setSource("backup");
    throw e;
  }
}

// snapshots ---------------------------------------------------------------------------------------------------------
const docSnap = (ref: DocRef, data: Data | null | undefined): DocumentSnapshot =>
  ({ id: ref.id, data: () => data ?? undefined, exists: () => data != null, ref });
function querySnap(name: string, rows: { id: string; data: Data }[], before?: Map<string, string>): QuerySnapshot {
  const docs = rows.map((r) => ({ id: r.id, data: () => r.data, exists: () => true as const, ref: doc(null, name, r.id) }));
  const changed = before ? docs.filter((d) => before.get(d.id) !== JSON.stringify(d.data())) : docs;
  const gone = before ? [...before.keys()].filter((id) => !rows.some((r) => r.id === id)).length : 0;
  return {
    docs, size: docs.length, empty: docs.length === 0, forEach: (fn) => docs.forEach(fn),
    docChanges: () => [...changed.map((d) => ({ doc: d })), ...Array.from({ length: gone }, () => ({ doc: docs[0] }))],
  };
}

function findBody(q: Query) {
  const order = q.cons.find((c) => c.t === "orderBy") as Extract<QueryConstraint, { t: "orderBy" }> | undefined;
  const after = q.cons.find((c) => c.t === "startAfter") as Extract<QueryConstraint, { t: "startAfter" }> | undefined;
  const lim = q.cons.find((c) => c.t === "limit") as Extract<QueryConstraint, { t: "limit" }> | undefined;
  return {
    op: "find", coll: q.name, filters: q.cons.filter((c) => c.t === "where").map((c) => (c as { f: Filter }).f),
    order: order?.field ?? "", desc: order?.desc ?? false, limit: lim?.n ?? 0,
    ...(after && order ? { after: [fieldOf(after.snap.data(), order.field), after.snap.id] } : {}),
  };
}
const fieldOf = (d: Data, path: string) => path.split(".").reduce<unknown>((cur, k) => (cur as Data | undefined)?.[k], d);

// the Firestore backup, for reads while the PC is off --------------------------------------------------------------
import { db as realDb } from "./firebase";
function realQuery(q: Query): fb.Query {
  const order = q.cons.find((c) => c.t === "orderBy") as Extract<QueryConstraint, { t: "orderBy" }> | undefined;
  const cons = q.cons.map((c) =>
    c.t === "where" ? fb.where(c.f[0], c.f[1] as fb.WhereFilterOp, c.f[2])
    : c.t === "orderBy" ? fb.orderBy(c.field, c.desc ? "desc" : "asc")
    : c.t === "limit" ? fb.limit(c.n)
    : fb.startAfter(order ? fieldOf(c.snap.data(), order.field) : c.snap.id));
  return fb.query(fb.collection(realDb, q.name), ...cons);
}
const fromReal = (name: string, s: fb.QuerySnapshot) => s.docs.map((d) => ({ id: d.id, data: d.data() as Data }));

// one-shot reads -----------------------------------------------------------------------------------------------------
export async function getDoc(ref: DocRef): Promise<DocumentSnapshot> {
  if (source === "bridge") {
    try {
      return docSnap(ref, (await call<{ doc: Data | null }>({ op: "get", path: ref.path })).doc);
    } catch (e) {
      if (!(e instanceof BridgeDown)) throw e;
    }
  }
  const s = await fb.getDoc(fb.doc(realDb, ref.coll, ref.id));
  return docSnap(ref, s.exists() ? (s.data() as Data) : null);
}
export async function getDocs(q: Query | CollRef): Promise<QuerySnapshot> {
  const qq = q.kind === "coll" ? query(q) : q;
  if (source === "bridge") {
    try {
      return querySnap(qq.name, (await call<{ docs: { id: string; data: Data }[] }>(findBody(qq))).docs);
    } catch (e) {
      if (!(e instanceof BridgeDown)) throw e;
    }
  }
  return querySnap(qq.name, fromReal(qq.name, await fb.getDocs(realQuery(qq))));
}
export async function getCountFromServer(c: CollRef) {
  if (source === "bridge") {
    try {
      const n = (await call<{ count: number }>({ op: "count", coll: c.name })).count;
      return { data: () => ({ count: n }) };
    } catch (e) {
      if (!(e instanceof BridgeDown)) throw e;
    }
  }
  const s = await fb.getCountFromServer(fb.collection(realDb, c.name));
  return { data: () => ({ count: s.data().count }) };
}

// writes: the bridge only; the backup is read-only -------------------------------------------------------------------
async function write(body: unknown): Promise<void> {
  if (source === "backup") throw new Error(READ_ONLY);
  try {
    await call(body);
  } catch (e) {
    throw e instanceof BridgeDown ? new Error(READ_ONLY) : e;
  }
}
export const setDoc = (ref: DocRef, data: Data, opts?: { merge?: boolean }) => write({ op: "set", path: ref.path, data, merge: !!opts?.merge });
export async function updateDoc(ref: DocRef, fields: Data): Promise<void> {
  if (source === "backup") throw new Error(READ_ONLY);
  let r: { ok: boolean };
  try {
    r = await call<{ ok: boolean }>({ op: "update", path: ref.path, fields });
  } catch (e) {
    throw e instanceof BridgeDown ? new Error(READ_ONLY) : e;
  }
  if (!r.ok) throw Object.assign(new Error("No such record: it was deleted."), { code: "not-found" });
}
export const deleteDoc = (ref: DocRef) => write({ op: "delete", path: ref.path });
export function writeBatch(_db: unknown) {
  const writes: unknown[] = [];
  return {
    set: (ref: DocRef, data: Data, opts?: { merge?: boolean }) => void writes.push({ op: "set", path: ref.path, data, merge: !!opts?.merge }),
    update: (ref: DocRef, fields: Data) => void writes.push({ op: "update", path: ref.path, fields }),
    delete: (ref: DocRef) => void writes.push({ op: "delete", path: ref.path }),
    commit: () => write({ op: "batch", writes }),
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
      const d = (await call<{ doc: Data | null }>({ op: "get", path: l.target.path })).doc;
      const key = JSON.stringify(d);
      if (l.before?.get("doc") === key) return;
      l.before = new Map([["doc", key]]);
      if (!l.gone) (l.cb as (s: DocumentSnapshot) => void)(docSnap(l.target, d));
    } else {
      const rows = (await call<{ docs: { id: string; data: Data }[] }>(findBody(l.target))).docs;
      const snap = querySnap(l.target.name, rows, l.before);
      const first = !l.before;
      if (!first && snap.docChanges().length === 0) return;
      l.before = new Map(rows.map((r) => [r.id, JSON.stringify(r.data)]));
      if (!l.gone) (l.cb as (s: QuerySnapshot) => void)(snap);
    }
  } catch {
    // the bridge went away: setSource("backup") restarted this listener on the backup
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
    l.stopReal = fb.onSnapshot(realQuery(q), (s) => (l.cb as (s: QuerySnapshot) => void)(querySnap(q.name, fromReal(q.name, s))), () => undefined);
  }
}

// one open call for every listener: the bridge answers when something changed, or after 25 s
let pumping = false;
let seq = -1;
async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (listeners.size > 0 && source === "bridge") {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        await new Promise((r) => setTimeout(r, 5000)); // a hidden tab asks nothing; its listeners refresh when it shows
        continue;
      }
      try {
        if (seq < 0) seq = (await call<{ seq: number }>({ op: "seq" })).seq;
        const r = await call<{ seq: number; changes: { path: string; coll: string }[]; reset?: boolean }>({ op: "changes", since: seq, wait: 25 });
        seq = r.seq;
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
    pumping = false;
  }
}
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && source === "bridge") {
      seq = -1; // changes while hidden were not followed: ask every listener once
      for (const l of listeners) void refresh(l);
      void pump();
    }
  });
}

export function onSnapshot(target: DocRef, cb: (s: DocumentSnapshot) => void, onError?: (e: unknown) => void): () => void;
export function onSnapshot(target: Query | CollRef, cb: (s: QuerySnapshot) => void, onError?: (e: unknown) => void): () => void;
export function onSnapshot(target: DocRef | Query | CollRef, cb: ((s: DocumentSnapshot) => void) | ((s: QuerySnapshot) => void)): () => void {
  const l: Listener = { target: target.kind === "coll" ? query(target) : target, cb: cb as (s: never) => void };
  listeners.add(l);
  restart(l);
  void pump();
  return () => {
    l.gone = true;
    l.stopReal?.();
    listeners.delete(l);
  };
}
