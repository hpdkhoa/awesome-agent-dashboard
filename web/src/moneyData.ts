import { useEffect, useState } from "react";
import { collection, deleteDoc, doc, limit, onSnapshot, orderBy, query, setDoc, type QueryConstraint } from "firebase/firestore";
import { db } from "./firebase";

// Money flow in three assets. Rates come only from what this page synced (Vietcombank) or the owner typed (gold).
export type Asset = "VND" | "USD" | "GOLD";
export const UNIT: Record<Asset, string> = { VND: "đ", USD: "$", GOLD: "chỉ" };

export type Entry = { id: string; date: string; asset: Asset; direction: "in" | "out"; amount: number; note: string; createdAt: string };
export type Rate = { name: string; buy: number | null; transfer: number | null; sell: number | null };
// One manual sync of Vietcombank's feed (worker/index.ts returns everything but id and savedAt).
export type FxSnapshot = {
  id: string;
  source: string;
  sourceUrl: string;
  sourceTime: string;
  fetchedAt: string;
  savedAt: string;
  rates: Record<string, Rate>;
};
// A gold price the owner typed, in VND per lượng (1 lượng = 10 chỉ).
export type GoldPrice = { id: string; date: string; product: string; buy: number; sell: number; note: string; enteredAt: string };

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

// Manual sync: ask the site's Worker for Vietcombank's feed and save it, unless the last save is under 5 minutes old
// or no rate changed since.
export async function syncRates(latest: FxSnapshot | undefined): Promise<string> {
  if (latest) {
    const wait = MIN_GAP_MS - (Date.now() - Date.parse(latest.savedAt));
    if (wait > 0) return `Wait ${Math.ceil(wait / 60000)} min: Vietcombank allows one request every 5 minutes.`;
  }
  const res = await fetch("/api/fx/vcb");
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `sync failed (${res.status})`);
  // The feed's time moves on every few minutes even when no rate changed, so compare the rates themselves.
  if (latest && sameRates(latest.rates, body.rates)) return `No rate changed since ${new Date(latest.sourceTime).toLocaleString()}.`;
  const id = newId();
  await setDoc(doc(db, "fxRates", id), { ...body, id, savedAt: now() });
  return `Saved ${Object.keys(body.rates).length} rates from ${new Date(body.sourceTime).toLocaleString()}.`;
}

// Balances per asset, and their value in VND at the latest synced USD cash-buy rate and typed gold buy price.
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
