// Settings of this browser only (the owner's words, 2026-11-14: "the dashboard need to have a config/setting page to
// change the font, font size, etc... think about the performance and I'll want this setting is browser/instance only";
// picks: "use rem. open own settings tab."). One localStorage key; nothing goes to Firestore or the bridge. index.html
// applies the saved settings to <html> before the first paint (window.aadApplySettings), so the page never flashes
// the old look; a change here calls the same function: one repaint, no data read.
import { useEffect, useState } from "react";

export const SETTINGS_KEY = "aad.settings";

export type TabId = "inbox" | "plans" | "sessions" | "runs" | "money" | "rates" | "storage" | "settings";
export const HIDEABLE: TabId[] = ["money", "rates", "storage"];

export type Settings = {
  font: "system" | "tahoma" | "verdana" | "georgia" | "custom";
  fontCustom: string;
  size: number; // root px: 16 = the page as it was
  lineHeight: number;
  mono: "default" | "consolas" | "cascadia" | "custom";
  monoCustom: string;
  codeScale: number;
  tabular: boolean;
  theme: "system" | "light" | "dark";
  accent: string; // "" = the theme's own
  contrast: "normal" | "high";
  density: "compact" | "normal" | "roomy";
  width: "full" | "wide" | "narrow";
  startTab: TabId;
  hiddenTabs: TabId[];
  reduceMotion: boolean;
  foldDefault: boolean; // sections start folded unless this browser remembers them open
  clock: "system" | "24h" | "12h";
  ago: "relative" | "exact";
  numbers: "system" | "en" | "vi"; // money stays Vietnamese always
  phoneSize: number;
  phoneDensity: "compact" | "normal" | "roomy";
  lazyImages: boolean;
  phoneGraph: boolean;
};

// The defaults keep the page exactly as it was before the Settings tab.
export const DEFAULTS: Settings = {
  font: "system", fontCustom: "", size: 16, lineHeight: 1.5, mono: "default", monoCustom: "", codeScale: 1,
  tabular: false, theme: "system", accent: "", contrast: "normal", density: "normal", width: "full",
  startTab: "inbox", hiddenTabs: [], reduceMotion: false, foldDefault: false, clock: "system", ago: "relative",
  numbers: "system", phoneSize: 16, phoneDensity: "normal", lazyImages: false, phoneGraph: true,
};

export const LIMITS = { size: [12, 24], lineHeight: [1.2, 2], codeScale: [0.8, 1.5], phoneSize: [13, 22] } as const;

const ONE_OF: { [K in keyof Settings]?: readonly string[] } = {
  font: ["system", "tahoma", "verdana", "georgia", "custom"], mono: ["default", "consolas", "cascadia", "custom"],
  theme: ["system", "light", "dark"], contrast: ["normal", "high"], density: ["compact", "normal", "roomy"],
  width: ["full", "wide", "narrow"], startTab: ["inbox", "plans", "sessions", "runs", "money", "rates", "storage", "settings"],
  clock: ["system", "24h", "12h"], ago: ["relative", "exact"], numbers: ["system", "en", "vi"],
  phoneDensity: ["compact", "normal", "roomy"],
};

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));
const nameOk = (s: string) => s.replace(/[^\w ,'"-]/g, "").slice(0, 80); // a font name only: no ; { } url( in the style

/** Any object (saved, imported) to valid settings: unknown keys dropped, wrong values back to the default. */
export function normalize(x: unknown): Settings {
  const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  const s: Settings = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    const v = o[k], d = DEFAULTS[k];
    if (v === undefined) continue;
    if (ONE_OF[k]) { if (typeof v === "string" && ONE_OF[k]!.includes(v)) (s as Record<string, unknown>)[k] = v; }
    else if (typeof d === "number") { if (typeof v === "number" && Number.isFinite(v)) (s as Record<string, unknown>)[k] = clamp(v, LIMITS[k as keyof typeof LIMITS]); }
    else if (typeof d === "boolean") { if (typeof v === "boolean") (s as Record<string, unknown>)[k] = v; }
    else if (k === "hiddenTabs") { if (Array.isArray(v)) s.hiddenTabs = HIDEABLE.filter((t) => v.includes(t)); }
    else if (k === "accent") { if (typeof v === "string" && /^(#[0-9a-fA-F]{6})?$/.test(v)) s.accent = v; }
    else if (typeof v === "string") (s as Record<string, unknown>)[k] = nameOk(v);
  }
  if (s.hiddenTabs.includes(s.startTab)) s.startTab = "inbox";
  return s;
}

/** Only the keys that differ from the defaults are saved, so a later default change reaches this browser too. */
export function diff(s: Settings): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(DEFAULTS) as (keyof Settings)[])
    if (JSON.stringify(s[k]) !== JSON.stringify(DEFAULTS[k])) out[k] = s[k];
  return out as Partial<Settings>;
}

let current: Settings = DEFAULTS;
try {
  current = normalize(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}"));
} catch {
  // no storage (tests, a blocked private window): the defaults
}
const subs = new Set<(s: Settings) => void>();

export const getSettings = () => current;

declare global {
  interface Window { aadApplySettings?: (s: Partial<Settings>) => void }
}

export function setSettings(next: Settings): void {
  current = normalize(next);
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(diff(current)));
  } catch {
    // blocked storage: the change still shows on this page view
  }
  if (typeof window !== "undefined") window.aadApplySettings?.(current);
  for (const f of subs) f(current);
}

export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const [s, set] = useState(current);
  useEffect(() => {
    subs.add(set);
    return () => void subs.delete(set);
  }, []);
  return [s, (patch) => setSettings({ ...current, ...patch })];
}
