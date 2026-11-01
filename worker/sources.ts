// The other public price pages the owner picked (2026-11-01, "Do #1 ... for gold the target is SJC price"):
// HSBC Vietnam's rate table, and the SJC gold bar price from giavang.net, PNJ and Bảo Tín Mạnh Hải. Each is fetched by
// the Worker at most once per 5 minutes (the same cache as Vietcombank), for one person's private use. None needs a
// key; each URL is the one the site's own page loads.
import type { Rate } from "./vcb";

export const HSBC_URL = "https://www.hsbc.com.vn/foreign-exchange/rate/";
// SJL1L10: SJC's own price for 1 lượng and 10 lượng bars; SJ9999: SJC's own ring ("NHẪN SJC 999.9"), as giavang.net's
// table names them.
export const GIAVANG_URL = "https://api2.giavang.net/v1/gold/last-price?codes%5B%5D=SJL1L10&codes%5B%5D=SJ9999";
export const PNJ_URL = "https://edge-cf-api.pnj.io/ecom-frontend/v1/get-gold-price?zone=00";
export const BTMH_URL = "https://baotinmanhhai.vn/bang-gia-vang";

export type FxRates = { sourceId: string; source: string; sourceUrl: string; sourceTime: string; rates: Record<string, Rate> };
// One SJC bar price in VND per lượng (1 lượng = 10 chỉ), and the same source's plain 999.9 ring when it has one
// (the owner's list, 2026-11-01: "usd eur vnd gold bar and gold ring").
export type RingQuote = { product: string; buy: number; sell: number | null; sourceTime: string };
export type GoldQuote = { sourceId: string; source: string; sourceUrl: string; sourceTime: string; product: string; buy: number; sell: number | null; ring: RingQuote | null };

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
  const rows = (JSON.parse(body) as { data?: GiavangRow[] }).data ?? [];
  const row = rows.find((r) => r.type_code === "SJL1L10");
  if (!row || !(row.buy > 0)) throw new Error("giavang.net has no SJC price");
  // update_time rolls over each morning even with no change; the newest history entry is the last real change.
  const changed = (r: GiavangRow) => unixToVietnam(r.histories?.[0]?.update_time ?? r.update_time);
  const ring = rows.find((r) => r.type_code === "SJ9999" && r.buy > 0);
  return { sourceId: "giavang", source: "giavang.net (SJC's price)", sourceUrl: "https://giavang.net/", sourceTime: changed(row),
    product: "Vàng SJC 1L, 10L", buy: row.buy, sell: row.sell > 0 ? row.sell : null,
    ring: ring ? { product: "Nhẫn SJC 999.9", buy: ring.buy, sell: ring.sell > 0 ? ring.sell : null, sourceTime: changed(ring) } : null };
}

export function parsePnj(body: string): GoldQuote {
  const b = JSON.parse(body) as { data?: { masp: string; tensp: string; giamua: number; giaban: number }[]; updateDate?: string };
  const row = b.data?.find((r) => r.masp === "SJC");
  const t = b.updateDate?.match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!row || !t) throw new Error("PNJ has no SJC price");
  const [, d, m, y, h, mi, s] = t;
  const time = `${y}-${m}-${d}T${h}:${mi}:${s}+07:00`;
  const per = (n: number) => (n > 0 ? n * LUONG_PER_THOUSAND_PER_CHI : null);
  const ring = b.data?.find((r) => r.masp === "N24K" && r.giamua > 0); // "Nhẫn Trơn PNJ 999.9"
  return { sourceId: "pnj", source: "PNJ", sourceUrl: "https://www.pnj.com.vn/site/gia-vang", sourceTime: time,
    product: row.tensp, buy: row.giamua * LUONG_PER_THOUSAND_PER_CHI, sell: per(row.giaban),
    ring: ring ? { product: ring.tensp, buy: ring.giamua * LUONG_PER_THOUSAND_PER_CHI, sell: per(ring.giaban), sourceTime: time } : null };
}

export function parseBtmh(html: string): GoldQuote {
  // The gold table comes first (the silver table follows it); rows are role="row", prices are tabular-nums spans.
  const start = html.indexOf('id="gold_price_table-');
  if (start < 0) throw new Error("not the Bảo Tín Mạnh Hải price page");
  const rows = html.slice(start).split('role="row"');
  const named = (name: string) => rows.find((r) => text(r).replace(/^>\s*/, "").startsWith(name));
  const row = named("Vàng miếng SJC");
  const t = html.match(/Cập nhật lúc(?:<!--.*?-->|\s)*(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!row || !t) throw new Error("Bảo Tín Mạnh Hải has no SJC price");
  // the first number is the purity (99.99), then buy and sell; a row may have no sell price
  const read = (r: string, fallback: string) => {
    const nums = [...r.matchAll(/tabular-nums">([^<]+)</g)].map(([, n]) => viNumber(n));
    const [buy, sell] = nums.slice(1);
    return { product: text(r.match(/role="cell"><span[^>]*>([^<]+)<\/span>/)?.[1] ?? fallback),
      buy: buy == null ? null : buy * LUONG_PER_THOUSAND_PER_CHI, sell: sell == null ? null : sell * LUONG_PER_THOUSAND_PER_CHI };
  };
  const bar = read(row, "Vàng miếng SJC");
  if (bar.buy == null) throw new Error("Bảo Tín Mạnh Hải SJC row has no buy price");
  // Kim Gia Bảo 24K is the shop's own plain 999.9 ring (not the "Kim Gia Bảo Gift" row above it)
  const ringRow = named("Kim Gia Bảo 24K");
  const ring = ringRow ? read(ringRow, "Kim Gia Bảo 24K") : null;
  const [, y, m, d, h, mi, s] = t;
  const time = `${y}-${m}-${d}T${h}:${mi}:${s}+07:00`;
  return { sourceId: "btmh", source: "Bảo Tín Mạnh Hải", sourceUrl: BTMH_URL, sourceTime: time, product: bar.product, buy: bar.buy, sell: bar.sell,
    ring: ring?.buy != null ? { product: ring.product, buy: ring.buy, sell: ring.sell, sourceTime: time } : null };
}

export const SOURCES: Record<string, { label: string; url: string; accept: string; parse: (body: string) => FxRates | GoldQuote }> = {
  "/api/fx/hsbc": { label: "HSBC", url: HSBC_URL, accept: "text/html", parse: parseHsbc },
  "/api/gold/giavang": { label: "giavang.net", url: GIAVANG_URL, accept: "application/json", parse: parseGiavang },
  "/api/gold/pnj": { label: "PNJ", url: PNJ_URL, accept: "application/json", parse: parsePnj },
  "/api/gold/btmh": { label: "Bảo Tín Mạnh Hải", url: BTMH_URL, accept: "text/html", parse: parseBtmh },
};
