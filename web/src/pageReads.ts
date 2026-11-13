// This tab's Firestore reads, and whether its listeners should be on (the owner's words, 2026-11-12: "Page listeners
// only while their tab is open"; "A per-tab read capture written to the PC counter through the bridge, so next time
// the page side shows too").
//
// - Every listener counts the documents it receives, by name. Every minute, and when the tab hides, the counts since
//   the last flush go to the bridge (POST /usage {what: "page"}), which adds them to its counter as "page:<name>".
// - A tab that is hidden for more than GRACE_MS turns its listeners off; they come back when it shows again (a
//   re-open re-reads the documents a query holds, so a quick tab switch keeps them on).
import { useEffect, useState } from "react";
import { bridgePost } from "./bridge";
import { usingBackup } from "./fs";

const GRACE_MS = 2 * 60 * 1000;
const FLUSH_MS = 60 * 1000;
const TAB = Math.random().toString(36).slice(2, 10);

let total = 0;
const pending: Record<string, number> = {};
export const pageReads = () => total;
export function countReads(n: number, name = "other"): void {
  // the bridge's local database costs no Firestore read: only the backup's reads (the PC is off) are counted
  if (n <= 0 || !usingBackup()) return;
  total += n;
  pending[name] = (pending[name] ?? 0) + n;
}

let flushing = false;
export async function flushReads(): Promise<void> {
  const by = { ...pending };
  if (flushing || Object.keys(by).length === 0) return;
  for (const k of Object.keys(pending)) delete pending[k];
  flushing = true;
  try {
    await bridgePost("/usage", { what: "page", tab: TAB, by });
  } catch {
    for (const [k, n] of Object.entries(by)) pending[k] = (pending[k] ?? 0) + n; // the bridge is off: keep them for next time
  } finally {
    flushing = false;
  }
}

// active: the tab is visible, or hidden for less than GRACE_MS.
let active = typeof document === "undefined" || document.visibilityState !== "hidden";
const listeners = new Set<(a: boolean) => void>();
let hideTimer: ReturnType<typeof setTimeout> | null = null;
function setActive(a: boolean) {
  if (a === active) return;
  active = a;
  listeners.forEach((l) => l(a));
}
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      void flushReads();
      hideTimer = setTimeout(() => setActive(false), GRACE_MS);
    } else {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = null;
      setActive(true);
    }
  });
  window.addEventListener("pagehide", () => void flushReads());
  setInterval(() => void flushReads(), FLUSH_MS);
}

// Hooks that listen to Firestore depend on this: off while the tab is away, on again when it shows.
export function useActive(): boolean {
  const [a, setA] = useState(active);
  useEffect(() => {
    listeners.add(setA);
    setA(active);
    return () => {
      listeners.delete(setA);
    };
  }, []);
  return a;
}
