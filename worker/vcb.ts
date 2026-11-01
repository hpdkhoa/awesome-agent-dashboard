// Vietcombank's public rate feed. Its own header asks for at most one request every 5 minutes.
export const VCB_URL = "https://portal.vietcombank.com.vn/Usercontrols/TVPortal.TyGia/pXML.aspx";
export const VCB_MIN_GAP_S = 300;

// buy: cash buy; transfer: transfer buy; sell: transfer sell; sellCash: cash sell, where the bank quotes it apart.
export type Rate = { name: string; buy: number | null; transfer: number | null; sell: number | null; sellCash?: number | null };
export type VcbRates = { source: string; sourceUrl: string; sourceTime: string; rates: Record<string, Rate> };

// "25,580.00" to 25580; "-" or "" to null (the bank does not quote that side).
const amount = (s: string | undefined) => {
  const v = (s ?? "").replace(/,/g, "").trim();
  return v === "" || v === "-" || Number.isNaN(Number(v)) ? null : Number(v);
};

// "11/1/2026 1:02:30 AM" (month/day/year, Vietnam time) to "2026-11-01T01:02:30+07:00".
export function vietnamTime(s: string): string {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)$/);
  if (!m) throw new Error(`unknown feed time: ${s}`);
  const [, mo, d, y, h, mi, sec, ap] = m;
  const hour = (Number(h) % 12) + (ap === "PM" ? 12 : 0);
  const p = (n: number | string) => String(n).padStart(2, "0");
  return `${y}-${p(mo)}-${p(d)}T${p(hour)}:${mi}:${sec}+07:00`;
}

export function parseVcb(xml: string): VcbRates {
  if (!xml.includes("<ExrateList>")) throw new Error("not a Vietcombank rate list");
  const time = xml.match(/<DateTime>([^<]+)<\/DateTime>/)?.[1];
  if (!time) throw new Error("rate list has no time");
  const rates: Record<string, Rate> = {};
  for (const [, attrs] of xml.matchAll(/<Exrate\s([^>]*?)\/>/g)) {
    const a = Object.fromEntries([...attrs.matchAll(/(\w+)="([^"]*)"/g)].map(([, k, v]) => [k, v]));
    if (!/^[A-Z]{3}$/.test(a.CurrencyCode ?? "")) continue;
    rates[a.CurrencyCode] = { name: (a.CurrencyName ?? "").trim(), buy: amount(a.Buy), transfer: amount(a.Transfer), sell: amount(a.Sell) };
  }
  if (!rates.USD) throw new Error("rate list has no USD");
  const source = xml.match(/<Source>([^<]+)<\/Source>/)?.[1]?.trim() ?? "Vietcombank";
  return { source, sourceUrl: VCB_URL, sourceTime: vietnamTime(time), rates };
}
