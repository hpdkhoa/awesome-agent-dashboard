// The boxes that run a bridge, and signed calls to them (the owner's words, 2026-11-13: "use firestore as control plane,
// the bridge and data on dashboard will select directly from each bridge"; "make it in the way I can plug and play
// another box in this dashboard, same with unplug").
//
// Firestore holds only the registry: one small document per box, bridges/<name> {name, url, db, seenAt, plugged}. A
// bridge writes its own (bridge/agent_bridge/registry.py); `plugged` belongs to the owner, set here on the page. The
// registry is read at most every 10 minutes per browser and kept in localStorage, so a load costs no Firestore read.
// Before any box registered, the one address in meta/files is used, as before.
import { collection, doc, getDoc, getDocs, setDoc } from "firebase/firestore";
import { auth, db } from "./firebase";

export type Box = { name: string; url: string; plugged: boolean; db?: string; seenAt?: string };

const KEY = "aad.boxes";
const LEGACY = "aad.filesUrl";
const FRESH_MS = 10 * 60 * 1000;

function kept<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") as T | null;
  } catch {
    return null;
  }
}
function keep(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // private window: asked again next load
  }
}

let reading: Promise<Box[]> | null = null;
// Every registered box, plugged or not. force: read Firestore now (the Boxes panel's Refresh, or after a plug).
export function registry(force = false): Promise<Box[]> {
  const c = kept<{ at: number; boxes: Box[] }>(KEY);
  if (!force && c && Date.now() - c.at < FRESH_MS) return Promise.resolve(c.boxes);
  if (!force && c) {
    void registry(true); // older than 10 minutes: use it now, refresh behind
    return Promise.resolve(c.boxes);
  }
  return (reading ??= getDocs(collection(db, "bridges"))
    .then((s) => {
      const boxes = s.docs.map((d) => ({ plugged: true, ...(d.data() as Omit<Box, "plugged">), name: d.id }) as Box).filter((b) => b.url);
      keep(KEY, { at: Date.now(), boxes });
      return boxes;
    }, () => c?.boxes ?? [])
    .finally(() => {
      reading = null;
    }));
}

async function legacyUrl(): Promise<string | null> {
  const k = kept<string>(LEGACY);
  if (k) return k;
  const url = await getDoc(doc(db, "meta", "files")).then((d) => (d.data()?.url as string | undefined) ?? null, () => null);
  if (url) keep(LEGACY, url);
  return url;
}

// The boxes the page talks to: the plugged ones that keep their data locally; else the one legacy address.
export async function boxes(): Promise<Box[]> {
  const live = (await registry()).filter((b) => b.plugged !== false && b.db === "local");
  if (live.length) return live;
  const url = await legacyUrl();
  return url ? [{ name: "", url, plugged: true }] : [];
}
export const filesUrl = async (): Promise<string | null> => (await boxes())[0]?.url ?? null;

// Plug or unplug a box: its registry document's `plugged`, written by the owner; the page then leaves that box out, or
// takes it in again. Works while the box is off. The box's own data and bridge are not touched.
export async function setPlugged(name: string, plugged: boolean): Promise<Box[]> {
  await setDoc(doc(db, "bridges", name), { plugged }, { merge: true });
  return registry(true);
}

export class BridgeDown extends Error {}
// The bridge answers but has no data API: it still uses Firestore as its database (before the import, or DB=firestore).
export class NoDataApi extends BridgeDown {}
const DOWN = "The PC does not answer: is the bridge running and the tunnel up?";

// One signed POST to one box. Throws BridgeDown when it does not answer at all (off, no tunnel), Error on a refusal.
export async function postTo<T>(url: string, path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const token = await auth.currentUser?.getIdToken();
  let r: Response;
  try {
    r = await fetch(url + path, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    throw new BridgeDown(DOWN);
  }
  if (r.status === 502 || r.status === 503 || r.status === 504 || r.status === 530) throw new BridgeDown(DOWN);
  const j = await r.json().catch(() => ({}));
  if (r.status === 404 && path === "/data") throw new NoDataApi("The bridge keeps its data on Firestore.");
  if (!r.ok) throw Object.assign(new Error(j.error ?? `The bridge answered ${r.status}.`), { status: r.status });
  return j as T;
}

// The first box (usage, health, search: this PC's own things).
export async function bridgePost<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const url = await filesUrl();
  if (!url) throw new BridgeDown("The file viewer is off: set FILES_URL on the bridge.");
  return postTo<T>(url, path, body, signal);
}

// Something that lives on one box only (a file, a run's text, a session's log): each box is asked until one has it.
export async function bridgePostAny<T>(path: string, body: unknown): Promise<{ answer: T; url: string }> {
  const list = await boxes();
  if (!list.length) throw new BridgeDown("The file viewer is off: set FILES_URL on the bridge.");
  let last: unknown = new BridgeDown(DOWN);
  for (const b of list) {
    try {
      return { answer: await postTo<T>(b.url, path, body), url: b.url };
    } catch (e) {
      last = e; // not on this box, or this box is off: the next one
    }
  }
  throw last;
}
