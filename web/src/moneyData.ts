import { useEffect, useState } from "react";
import { collection, deleteDoc, doc, limit, onSnapshot, orderBy, query, setDoc, type QueryConstraint } from "firebase/firestore";
import { db } from "./firebase";

// Money flow in five assets (the owner's list, 2026-11-01: "usd eur vnd gold bar and gold ring"). Rates come only from
// what this page synced (Vietcombank, HSBC, three gold sources) or the owner typed (gold).
export type Asset = "VND" | "USD" | "EUR" | "GOLD_BAR" | "GOLD_RING";
export const ASSETS: Asset[] = ["VND", "USD", "EUR", "GOLD_BAR", "GOLD_RING"];
export const ASSET_LABEL: Record<Asset, string> = {
  VND: "VND (đồng)", USD: "USD (dollars)", EUR: "EUR (euros)", GOLD_BAR: "Gold bar, SJC (chỉ)", GOLD_RING: "Gold ring 999.9 (chỉ)",
};
export const ASSET_SHORT: Record<Asset, string> = { VND: "VND", USD: "USD", EUR: "EUR", GOLD_BAR: "Gold bar", GOLD_RING: "Gold ring" };
export const UNIT: Record<Asset, string> = { VND: "đ", USD: "$", EUR: "€", GOLD_BAR: "chỉ", GOLD_RING: "chỉ" };

// price: what was paid in đ per unit, for profit or loss (the owner's choice, 2026-11-01, "do 1 and 4"); none for VND.
export type Entry = {
  id: string; date: string; asset: Asset | "GOLD"; direction: "in" | "out"; amount: number; price?: number | null; note: string; createdAt: string;
};
export const assetOf = (e: Entry): Asset => (e.asset === "GOLD" ? "GOLD_BAR" : e.asset); // "GOLD" was the SJC bar before rings

// "1.000.000" or "1,5": Vietnamese format, dot for thousands and comma for decimals. "1.5" is refused, not guessed.
export function parseAmount(s: string): { value: number; error?: undefined } | { value?: undefined; error: string } {
  const t = s.replace(/\s/g, "");
  if (t === "") return { error: "type an amount" };
  if (!/^(\d{1,3}(\.\d{3})+|\d+)(,\d+)?$/.test(t)) return { error: "use . for thousands and , for decimals: 1.000.000 or 1,5" };
  const value = Number(t.replace(/\./g, "").replace(",", "."));
  return value > 0 ? { value } : { error: "the amount must be above 0" };
}
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
// A gold price in VND per lượng (1 lượng = 10 chỉ): synced (one source's SJC bar price, and its ring price when it has
// one) or typed by the owner (kind says bar or ring; missing on the first typed prices, which were bars).
export type RingPrice = { product: string; buy: number; sell: number | null; sourceTime: string };
export type GoldPrice = {
  id: string; date: string; product: string; buy: number; sell: number | null; note: string; enteredAt: string;
  sourceId?: string; source?: string; sourceUrl?: string; sourceTime?: string; fetchedAt?: string;
  ring?: RingPrice | null; kind?: "bar" | "ring";
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

// Firestore hands maps back with their keys sorted, so compare with sorted keys, not in the order they were written.
const sorted = (_: string, v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v;
export const same = (a: unknown, b: unknown) => JSON.stringify(a, sorted) === JSON.stringify(b, sorted);

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
  if (latest && same(latest.rates, body.rates)) return `no rate changed since ${new Date(latest.sourceTime).toLocaleString()}.`;
  const id = newId();
  await setDoc(doc(db, "fxRates", id), { ...body, sourceId: src.id, id, savedAt: now() });
  return `saved ${Object.keys(body.rates).length} rates from ${new Date(body.sourceTime).toLocaleString()}.`;
}

async function syncGold(src: (typeof GOLD_SOURCES)[number], latest: GoldPrice | undefined): Promise<string> {
  const wait = tooSoon(latest?.enteredAt);
  if (wait) return wait;
  const q = await ask(src.path, src.label);
  if (latest && latest.buy === q.buy && latest.sell === q.sell && same(latest.ring ?? null, q.ring))
    return `prices unchanged since ${new Date(latest.sourceTime ?? latest.enteredAt).toLocaleString()}.`;
  const id = newId();
  await setDoc(doc(db, "goldPrices", id), { ...q, id, date: q.sourceTime.slice(0, 10), note: "", enteredAt: now() });
  const ring = q.ring ? `, ring ${fmt(q.ring.buy, 0)} / ${fmt(q.ring.sell, 0)}` : " (no ring price on the page)";
  return `saved SJC bar ${fmt(q.buy, 0)} / ${fmt(q.sell, 0)}${ring} đ per lượng, buy / sell (${new Date(q.sourceTime).toLocaleString()}).`;
}

// At most one sync every 5 minutes from this browser, for the Sync button and every Save together (the owner's rule,
// 2026-11-01: "the sync must constraint the 5 mins between each sync so not spam my firestore"). A failed sync counts
// too. Another device gets the Worker's 5-minute cached answer, which matches what was saved, so it writes nothing.
const LAST_SYNC = "moneyLastSync";
let lastSync = 0;
const lastSyncAt = () => {
  try {
    lastSync = Math.max(lastSync, Number(localStorage.getItem(LAST_SYNC)) || 0);
  } catch {
    // private window: the in-page time still holds the gap
  }
  return lastSync;
};
export const nextSyncAt = () => lastSyncAt() + MIN_GAP_MS;
const hm = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// Sync of every source at once. Each runs on its own, so one failing source never stops the others.
export function syncAll(fx: FxSnapshot[], gold: GoldPrice[], clock = Date.now): Promise<SyncLine[]> {
  const t = clock();
  if (t < nextSyncAt())
    return Promise.resolve([{ label: "gap", ok: true, text: `Rates were synced at ${hm(lastSync)}; the next sync is after ${hm(nextSyncAt())}. Nothing was asked or written.` }]);
  lastSync = t;
  try {
    localStorage.setItem(LAST_SYNC, String(t));
  } catch {
    // as above
  }
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
// The price each asset is valued at, from the newest saved syncs: USD and EUR at Vietcombank cash buy (else transfer);
// gold at SJC's own buy price on giavang.net (the owner's choice 2026-11-01, "for gold the target is SJC price"),
// bar or ring, else the newest saved price of that kind. All per unit: đ per dollar, euro or chỉ.
export type Valuation = { rate: number; label: string; time: string };
export function valuations(fx: FxSnapshot[], gold: GoldPrice[]): Record<Asset, Valuation | null> {
  const vcb = fx.find((s) => fxSource(s) === "vcb");
  const cur = (code: string): Valuation | null => {
    const r = vcb?.rates[code];
    const rate = r?.buy ?? r?.transfer ?? null;
    return vcb && rate !== null ? { rate, label: `Vietcombank, ${r?.buy != null ? "cash buy" : "transfer buy"}`, time: vcb.sourceTime } : null;
  };
  const is = (g: GoldPrice, k: "bar" | "ring") => (goldSource(g) === "typed" ? (g.kind ?? "bar") === k : k === "bar" || !!g.ring);
  const of = (k: "bar" | "ring"): Valuation | null => {
    const g = gold.find((x) => goldSource(x) === "giavang" && is(x, k)) ?? gold.find((x) => is(x, k));
    if (!g) return null;
    const typed = goldSource(g) === "typed";
    const p = k === "ring" && !typed ? g.ring! : { product: g.product, buy: g.buy, sourceTime: g.sourceTime ?? g.date };
    const from = typed ? "typed by you" : GOLD_SOURCES.find((x) => x.id === goldSource(g))?.label ?? g.source;
    return { rate: p.buy / 10, label: `${from}, ${p.product}, buy`, time: p.sourceTime };
  };
  return { VND: { rate: 1, label: "", time: "" }, USD: cur("USD"), EUR: cur("EUR"), GOLD_BAR: of("bar"), GOLD_RING: of("ring") };
}

// Each asset's balance, its value at that rate, and what the balance cost: the average buy price of the "in" entries,
// each "out" entry taking its share at that average. The cost is unknown while any "in" entry has no price.
export type Holding = { asset: Asset; qty: number; val: Valuation | null; value: number | null; cost: number | null; unpriced: number };
export function holdings(entries: Entry[], vals: Record<Asset, Valuation | null>) {
  const h = Object.fromEntries(ASSETS.map((a) => [a, { asset: a, qty: 0, val: vals[a], value: 0, cost: 0, unpriced: 0 }])) as Record<Asset, Holding>;
  const oldest = [...entries].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
  for (const e of oldest) {
    const x = h[assetOf(e)];
    if (e.direction === "in") {
      if (e.price == null) x.unpriced++;
      else x.cost! += e.amount * e.price;
      x.qty += e.amount;
    } else {
      x.cost = x.qty > 0 ? x.cost! * Math.max(0, 1 - e.amount / x.qty) : 0;
      x.qty -= e.amount;
    }
  }
  for (const x of Object.values(h)) {
    // A zero balance is worth 0 đ even before its rate is known.
    x.value = x.qty === 0 ? 0 : x.val === null ? null : x.qty * x.val.rate;
    x.cost = x.asset === "VND" ? x.qty : x.unpriced > 0 ? null : x.cost;
  }
  const rows = ASSETS.map((a) => h[a]);
  const total = rows.every((x) => x.value !== null) ? rows.reduce((t, x) => t + x.value!, 0) : null;
  // profit or loss over the assets whose cost is known; VND has none
  const priced = rows.filter((x) => x.asset !== "VND" && x.qty !== 0 && x.cost !== null && x.value !== null);
  const profit = priced.reduce((t, x) => t + x.value! - x.cost!, 0);
  return { rows, total, profit, profitOf: priced.length };
}

export const vnd = (n: number | null) => (n === null ? "-" : Math.round(n).toLocaleString("vi-VN") + " đ");
export const fmt = (n: number | null, digits = 2) =>
  n === null ? "-" : n.toLocaleString("vi-VN", { maximumFractionDigits: digits });
