// The bridge's address and one signed call to it. The address (meta/files on Firestore) is read once per browser and
// kept in localStorage, so a load costs no Firestore read (the owner's words, 2026-11-13: "I want to least the read
// request from firestore").
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "./firebase";

const KEY = "aad.filesUrl";
let base: Promise<string | null> | null = null;

function remembered(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export const filesUrl = (): Promise<string | null> =>
  (base ??= (async () => {
    const kept = remembered();
    if (kept) return kept;
    const url = await getDoc(doc(db, "meta", "files")).then((d) => (d.data()?.url as string | undefined) ?? null, () => null);
    try {
      if (url) localStorage.setItem(KEY, url);
    } catch {
      // private window: asked again next load
    }
    return url;
  })());

// The address changed on the bridge (a new tunnel): forget it, so the next load reads meta/files once more.
export function forgetFilesUrl(): void {
  base = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing kept
  }
}

export class BridgeDown extends Error {}

// One signed POST. Throws BridgeDown when the PC does not answer at all (off, no tunnel), Error on a refusal.
export async function bridgePost<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const url = await filesUrl();
  if (!url) throw new BridgeDown("The file viewer is off: set FILES_URL on the bridge.");
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
    throw new BridgeDown("The PC does not answer: is the bridge running and the tunnel up?");
  }
  if (r.status === 502 || r.status === 503 || r.status === 504 || r.status === 530) throw new BridgeDown("The PC does not answer: is the bridge running and the tunnel up?");
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `The bridge answered ${r.status}.`);
  return j as T;
}
