// The other public price pages the owner picked (2026-11-01, "Do #1 ... for gold the target is SJC price"):
// HSBC Vietnam's rate table, and the SJC gold bar price from giavang.net, PNJ and Bảo Tín Mạnh Hải. Each is fetched by
// the Worker at most once per 5 minutes (the same cache as Vietcombank), for one person's private use. None needs a
// key; each URL is the one the site's own page loads.
import type { Rate } from "./vcb";

export const HSBC_URL = "https://www.hsbc.com.vn/foreign-exchange/rate/";
// SJL1L10: SJC's own price for 1 lượng and 10 lượng bars, as giavang.net's table shows it.
export const GIAVANG_URL = "https://api2.giavang.net/v1/gold/last-price?codes%5B%5D=SJL1L10";
export const PNJ_URL = "https://edge-cf-api.pnj.io/ecom-frontend/v1/get-gold-price?zone=00";
export const BTMH_URL = "https://baotinmanhhai.vn/bang-gia-vang";

export type FxRates = { sourceId: string; source: string; sourceUrl: string; sourceTime: string; rates: Record<string, Rate> };
// One SJC bar price in VND per lượng (1 lượng = 10 chỉ).
export type GoldQuote = { sourceId: string; source: string; sourceUrl: string; sourceTime: string; product: string; buy: number; sell: number | null };

const LUONG_PER_THOUSAND_PER_CHI = 10 * 1000; // a price in thousand đ per chỉ, times this, is đ per lượng
const p2 = (n: number | string) => String(n).padStart(2, "0");
const unixToVietnam = (s: number) => {
  const d = new Date((s + 7 * 3600) * 1000);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}+07:00`;
};
const text = (html: string) => html.replace(/<!--.*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

// "25.676" or "160,01" (Vietnamese: dot for thousands, comma for decimals) to a number.
export const viNumber = (s: string) => {
  const v = s.replace(/\./g, "").replace(",", ".").trim();
  return v === "" || Number.isNaN(Number(v)) ? null : Number(v);
};

export function parseHsbc(html: string): FxRates {
  const time = html.match(/Cập nhật lúc:\s*(\d{2})\/(\d{2})\/(\d{4}),\s*(\d{2}):(\d{2})/);
  if (!time) throw new Error("not the HSBC rate page: no update time");
  const [, d, m, y, h, mi] = time;
  // the page has more than one desktop table (the first holds only the update time); take the one with the rates
  const table = [...html.matchAll(/<table class="desktop">([\s\S]*?)<\/table>/g)].map(([, t]) => t).find((t) => t.includes("(USD)")) ?? "";
  const rates: Record<string, Rate> = {};
  for (const [, row] of table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const head = row.match(/<th scope="row">([\s\S]*?)<\/th>/)?.[1];
    const code = head && text(head).match(/\(([A-Z]{3})\)/)?.[1];
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, c]) => viNumber(text(c)));
    if (!code || cells.length !== 4) continue;
    const [buyCash, buyTransfer, sellCash, sellTransfer] = cells;
    rates[code] = { name: text(head!).replace(/\s*\([A-Z]{3}\)\s*$/, ""), buy: buyCash, transfer: buyTransfer, sell: sellTransfer, sellCash };
  }
  if (!rates.USD) throw new Error("HSBC rate page has no USD");
  return { sourceId: "hsbc", source: "HSBC Vietnam", sourceUrl: HSBC_URL, sourceTime: `${y}-${m}-${d}T${h}:${mi}:00+07:00`, rates };
}

type GiavangRow = { type_code: string; buy: number; sell: number; update_time: number; histories?: { update_time: number }[] };

export function parseGiavang(body: string): GoldQuote {
  const row = (JSON.parse(body) as { data?: GiavangRow[] }).data?.find((r) => r.type_code === "SJL1L10");
  if (!row || !(row.buy > 0)) throw new Error("giavang.net has no SJC price");
  // update_time rolls over each morning even with no change; the newest history entry is the last real change.
  const changed = row.histories?.[0]?.update_time ?? row.update_time;
  return { sourceId: "giavang", source: "giavang.net (SJC's price)", sourceUrl: "https://giavang.net/", sourceTime: unixToVietnam(changed),
    product: "Vàng SJC 1L, 10L", buy: row.buy, sell: row.sell > 0 ? row.sell : null };
}

export function parsePnj(body: string): GoldQuote {
  const b = JSON.parse(body) as { data?: { masp: string; tensp: string; giamua: number; giaban: number }[]; updateDate?: string };
  const row = b.data?.find((r) => r.masp === "SJC");
  const t = b.updateDate?.match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!row || !t) throw new Error("PNJ has no SJC price");
  const [, d, m, y, h, mi, s] = t;
  return { sourceId: "pnj", source: "PNJ", sourceUrl: "https://www.pnj.com.vn/site/gia-vang", sourceTime: `${y}-${m}-${d}T${h}:${mi}:${s}+07:00`,
    product: row.tensp, buy: row.giamua * LUONG_PER_THOUSAND_PER_CHI, sell: row.giaban > 0 ? row.giaban * LUONG_PER_THOUSAND_PER_CHI : null };
}

export function parseBtmh(html: string): GoldQuote {
  // The gold table comes first (the silver table follows it); rows are role="row", prices are tabular-nums spans.
  const start = html.indexOf('id="gold_price_table-');
  if (start < 0) throw new Error("not the Bảo Tín Mạnh Hải price page");
  const rows = html.slice(start).split('role="row"');
  const row = rows.find((r) => text(r).replace(/^>\s*/, "").startsWith("Vàng miếng SJC"));
  const t = html.match(/Cập nhật lúc(?:<!--.*?-->|\s)*(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!row || !t) throw new Error("Bảo Tín Mạnh Hải has no SJC price");
  const name = text(row.match(/role="cell"><span[^>]*>([^<]+)<\/span>/)?.[1] ?? "Vàng miếng SJC");
  // the first number is the purity (99.99), then buy and sell; a row may have no sell price
  const nums = [...row.matchAll(/tabular-nums">([^<]+)</g)].map(([, n]) => viNumber(n));
  const [buy, sell] = nums.slice(1);
  if (buy == null) throw new Error("Bảo Tín Mạnh Hải SJC row has no buy price");
  const [, y, m, d, h, mi, s] = t;
  return { sourceId: "btmh", source: "Bảo Tín Mạnh Hải", sourceUrl: BTMH_URL, sourceTime: `${y}-${m}-${d}T${h}:${mi}:${s}+07:00`,
    product: name, buy: buy * LUONG_PER_THOUSAND_PER_CHI, sell: sell == null ? null : sell * LUONG_PER_THOUSAND_PER_CHI };
}

export const SOURCES: Record<string, { label: string; url: string; accept: string; parse: (body: string) => FxRates | GoldQuote }> = {
  "/api/fx/hsbc": { label: "HSBC", url: HSBC_URL, accept: "text/html", parse: parseHsbc },
  "/api/gold/giavang": { label: "giavang.net", url: GIAVANG_URL, accept: "application/json", parse: parseGiavang },
  "/api/gold/pnj": { label: "PNJ", url: PNJ_URL, accept: "application/json", parse: parsePnj },
  "/api/gold/btmh": { label: "Bảo Tín Mạnh Hải", url: BTMH_URL, accept: "text/html", parse: parseBtmh },
};
