import { useEffect, useState } from "react";
import { collection, deleteDoc, doc, limit, onSnapshot, orderBy, query, setDoc, type QueryConstraint } from "firebase/firestore";
import { db } from "./firebase";

// Money flow in three assets. Rates come only from what this page synced (Vietcombank, HSBC, three SJC gold sources)
// or the owner typed (gold).
export type Asset = "VND" | "USD" | "GOLD";
export const UNIT: Record<Asset, string> = { VND: "đ", USD: "$", GOLD: "chỉ" };

export type Entry = { id: string; date: string; asset: Asset; direction: "in" | "out"; amount: number; note: string; createdAt: string };
export type Rate = { name: string; buy: number | null; transfer: number | null; sell: number | null; sellCash?: number | null };
// One manual sync of Vietcombank's feed (worker/index.ts returns everything but id and savedAt).
export type FxSnapshot = {
  id: string;
  sourceId?: string; // "vcb" or "hsbc"; missing on the first Vietcombank syncs
  source: string;
  sourceUrl: string;
  sourceTime: string;
  fetchedAt: string;
  savedAt: string;
  rates: Record<string, Rate>;
};
// A gold price in VND per lượng (1 lượng = 10 chỉ): synced (the SJC bar price of one source) or typed by the owner.
export type GoldPrice = {
  id: string; date: string; product: string; buy: number; sell: number | null; note: string; enteredAt: string;
  sourceId?: string; source?: string; sourceUrl?: string; sourceTime?: string; fetchedAt?: string;
};

export const MIN_GAP_MS = 5 * 60 * 1000; // Vietcombank: one request every 5 minutes at most

// Listens only while `on` (its tab is open), so the other tabs never pay reads for money data.
function useRows<T>(name: string, on: boolean, ...constraints: QueryConstraint[]): T[] | null {
  const [rows, setRows] = useState<T[] | null>(null);
  useEffect(() => {
    if (!on) return;
    return onSnapshot(query(collection(db, name), ...constraints), (s) => setRows(s.docs.map((d) => d.data() as T)));
  }, [name, on]);
  return rows;
}

export const useEntries = (on: boolean) => useRows<Entry>("moneyEntries", on, orderBy("date", "desc"), limit(500));
export const useFx = (on: boolean) => useRows<FxSnapshot>("fxRates", on, orderBy("savedAt", "desc"), limit(200));
export const useGold = (on: boolean) => useRows<GoldPrice>("goldPrices", on, orderBy("enteredAt", "desc"), limit(200));

const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 20);
const now = () => new Date().toISOString();

export const addEntry = (e: Omit<Entry, "id" | "createdAt">) => {
  const id = newId();
  return setDoc(doc(db, "moneyEntries", id), { ...e, id, createdAt: now() });
};
export const removeEntry = (id: string) => deleteDoc(doc(db, "moneyEntries", id));

export const addGold = (g: Omit<GoldPrice, "id" | "enteredAt">) => {
  const id = newId();
  return setDoc(doc(db, "goldPrices", id), { ...g, id, enteredAt: now() });
};

const sameRates = (a: Record<string, Rate>, b: Record<string, Rate>) => JSON.stringify(a) === JSON.stringify(b);

// The sources behind the one Sync button (the owner's choice, 2026-11-01, "Do #1"), each saved as its own source.
export const FX_SOURCES = [
  { id: "vcb", label: "Vietcombank", path: "/api/fx/vcb" },
  { id: "hsbc", label: "HSBC", path: "/api/fx/hsbc" },
];
export const GOLD_SOURCES = [
  { id: "giavang", label: "giavang.net", path: "/api/gold/giavang" },
  { id: "pnj", label: "PNJ", path: "/api/gold/pnj" },
  { id: "btmh", label: "Bảo Tín Mạnh Hải", path: "/api/gold/btmh" },
];
export const fxSource = (s: FxSnapshot) => s.sourceId ?? "vcb"; // the first syncs were Vietcombank only
export const goldSource = (g: GoldPrice) => g.sourceId ?? "typed";

// One line per source: what it saved, or its own error (the owner's rule, 2026-11-01).
export type SyncLine = { label: string; ok: boolean; text: string };

const tooSoon = (savedAt: string | undefined) => {
  const wait = savedAt ? MIN_GAP_MS - (Date.now() - Date.parse(savedAt)) : 0;
  return wait > 0 ? `wait ${Math.ceil(wait / 60000)} min: one request every 5 minutes.` : "";
};

// no-store: the site's edge may tell browsers to keep the answer for hours; the Worker's 5-minute cache is the only one.
async function ask(path: string, label: string) {
  const res = await fetch(path, { cache: "no-store" });
  const body = await res.json().catch(() => ({ error: `${label}: the answer was not JSON (${res.status})` }));
  if (!res.ok) throw new Error(body.error ?? `${label}: sync failed (${res.status})`);
  return body;
}

async function syncFx(src: (typeof FX_SOURCES)[number], latest: FxSnapshot | undefined): Promise<string> {
  const wait = tooSoon(latest?.savedAt);
  if (wait) return wait;
  const body = await ask(src.path, src.label);
  // The feed's time moves on every few minutes even when no rate changed, so compare the rates themselves.
  if (latest && sameRates(latest.rates, body.rates)) return `no rate changed since ${new Date(latest.sourceTime).toLocaleString()}.`;
  const id = newId();
  await setDoc(doc(db, "fxRates", id), { ...body, sourceId: src.id, id, savedAt: now() });
  return `saved ${Object.keys(body.rates).length} rates from ${new Date(body.sourceTime).toLocaleString()}.`;
}

async function syncGold(src: (typeof GOLD_SOURCES)[number], latest: GoldPrice | undefined): Promise<string> {
  const wait = tooSoon(latest?.enteredAt);
  if (wait) return wait;
  const q = await ask(src.path, src.label);
  if (latest && latest.buy === q.buy && latest.sell === q.sell) return `SJC price unchanged since ${new Date(latest.sourceTime ?? latest.enteredAt).toLocaleString()}.`;
  const id = newId();
  await setDoc(doc(db, "goldPrices", id), { ...q, id, date: q.sourceTime.slice(0, 10), note: "", enteredAt: now() });
  return `saved SJC buy ${fmt(q.buy, 0)} / sell ${fmt(q.sell, 0)} đ per lượng (${new Date(q.sourceTime).toLocaleString()}).`;
}

// Manual sync of every source at once. Each runs on its own, so one failing source never stops the others.
export function syncAll(fx: FxSnapshot[], gold: GoldPrice[]): Promise<SyncLine[]> {
  const run = (label: string, job: () => Promise<string>) =>
    job().then(
      (text) => ({ label, ok: true, text: `${label}: ${text}` }),
      (e: Error) => ({ label, ok: false, text: e.message.startsWith(label) ? e.message : `${label}: ${e.message}` }),
    );
  return Promise.all([
    ...FX_SOURCES.map((s) => run(s.label, () => syncFx(s, fx.find((x) => fxSource(x) === s.id)))),
    ...GOLD_SOURCES.map((s) => run(s.label, () => syncGold(s, gold.find((x) => goldSource(x) === s.id)))),
  ]);
}
// Balances per asset, and their value in VND at the latest Vietcombank USD cash-buy rate and the gold buy price the
// caller passes: SJC's own price (giavang.net, the owner's choice 2026-11-01), else the newest gold price saved.
export function balances(entries: Entry[], fx: FxSnapshot | undefined, gold: GoldPrice | undefined) {
  const bal: Record<Asset, number> = { VND: 0, USD: 0, GOLD: 0 };
  for (const e of entries) bal[e.asset] += e.direction === "in" ? e.amount : -e.amount;
  const usdRate = fx?.rates.USD?.buy ?? fx?.rates.USD?.transfer ?? null;
  const goldRate = gold ? gold.buy / 10 : null; // per chỉ
  // A zero balance is worth 0 đ even before its rate is known.
  const inVnd: Record<Asset, number | null> = {
    VND: bal.VND,
    USD: bal.USD === 0 ? 0 : usdRate === null ? null : bal.USD * usdRate,
    GOLD: bal.GOLD === 0 ? 0 : goldRate === null ? null : bal.GOLD * goldRate,
  };
  const total = Object.values(inVnd).every((v) => v !== null) ? (inVnd.VND ?? 0) + (inVnd.USD ?? 0) + (inVnd.GOLD ?? 0) : null;
  return { bal, inVnd, total, usdRate, goldRate };
}

export const vnd = (n: number | null) => (n === null ? "-" : Math.round(n).toLocaleString("vi-VN") + " đ");
export const fmt = (n: number | null, digits = 2) =>
  n === null ? "-" : n.toLocaleString("vi-VN", { maximumFractionDigits: digits });
