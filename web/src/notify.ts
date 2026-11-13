import { useEffect, useState } from "react";
import { doc, getDoc, setDoc } from "./fs";
import { db } from "./firebase";

// Web Push on this device (the owner's choice, 2026-11-01: "do the web push"). The bridge sends a push when a run needs
// an approval and when a run ends; this page only subscribes and saves its push address to pushSubs. On iOS this works
// only in the Home Screen app (iOS 16.4 or newer).

export type PushState = "unsupported" | "home-screen" | "off" | "denied" | "on" | "no-key";

const standalone = () =>
  window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

const b64url = (s: string) => {
  const raw = atob((s + "=".repeat((4 - (s.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

async function idOf(endpoint: string) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint)));
  return [...h.slice(0, 10)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function current(): Promise<PushState> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window))
    return isIos() && !standalone() ? "home-screen" : "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration("/");
  return (await reg?.pushManager.getSubscription()) ? "on" : "off";
}

// Must run from a tap: iOS asks for permission only on a user gesture.
export async function turnOn(): Promise<PushState> {
  const key = (await getDoc(doc(db, "meta", "push"))).data()?.publicKey as string | undefined;
  if (!key) return "no-key";
  const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  if ((await Notification.requestPermission()) !== "granted") return "denied";
  await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64url(key) });
  const j = sub.toJSON();
  const id = await idOf(j.endpoint!);
  await setDoc(doc(db, "pushSubs", id), {
    id, kind: "webpush", endpoint: j.endpoint, keys: j.keys, device: navigator.userAgent.slice(0, 160), createdAt: new Date().toISOString(),
  });
  return "on";
}

export function usePush(): [PushState | null, () => void] {
  const [state, setState] = useState<PushState | null>(null);
  useEffect(() => {
    current().then(setState, () => setState("unsupported"));
  }, []);
  const on = () => {
    turnOn().then(setState, () => setState("off"));
  };
  return [state, on];
}
