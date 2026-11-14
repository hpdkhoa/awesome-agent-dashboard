// Dates, times and numbers as this browser's settings say (prefs.ts: clock 24h / 12h, numbers en / vi, ago relative
// or exact). Money and the day keys (en-CA) keep their own fixed formats.
import { getSettings } from "./prefs";

const loc = () => ({ system: undefined, en: "en-US", vi: "vi-VN" })[getSettings().numbers];
const h12 = () => ({ system: undefined, "24h": false, "12h": true })[getSettings().clock];
const date = (v: string | number | Date) => (v instanceof Date ? v : new Date(v));

/** a date and time */
export const dt = (v: string | number | Date) => date(v).toLocaleString(loc(), h12() === undefined ? undefined : { hour12: h12(), year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
/** a time */
export const tm = (v: string | number | Date) => date(v).toLocaleTimeString(loc(), h12() === undefined ? undefined : { hour12: h12() });
/** a date */
export const dd = (v: string | number | Date) => date(v).toLocaleDateString(loc());
/** a plain number */
export const nf = (n: number, o?: Intl.NumberFormatOptions) => n.toLocaleString(loc(), o);

/** how long ago, or the exact time when the setting says exact */
export function ago(iso?: string): string {
  if (!iso) return "";
  if (getSettings().ago === "exact") return dt(iso);
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}
