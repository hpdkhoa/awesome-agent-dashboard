// HSBC and the SJC gold sources: parse the real pages (saved 2026-10-30 / 2026-11-01), convert units, fail clearly.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseBtmh, parseGiavang, parseHsbc, parsePnj, viNumber } from "../worker/sources";
import { priceRoute } from "../worker/index";

const read = (f: string) => readFileSync(`tests/fixtures/${f}`, "utf8");

describe("HSBC", () => {
  const r = parseHsbc(read("hsbc-2026-10-30.html"));
  it("reads 11 currencies in Vietnamese number format", () => {
    expect(Object.keys(r.rates)).toHaveLength(11);
    expect(r.rates.USD).toEqual({ name: "Ðô la Mỹ", buy: 25676, transfer: 25676, sell: 25986, sellCash: 25986 });
    expect(r.rates.JPY).toMatchObject({ buy: 160.01, transfer: 160.83, sell: 167.4 });
    expect(r.rates.GBP).toMatchObject({ buy: 33753, transfer: 34065 });
  });
  it("reads the update time as Vietnam time", () => expect(r.sourceTime).toBe("2026-10-30T08:45:00+07:00"));
  it("refuses another page", () => expect(() => parseHsbc("<html>Access denied</html>")).toThrow(/not the HSBC/));
  it("reads Vietnamese numbers", () => {
    expect(viNumber("25.676")).toBe(25676);
    expect(viNumber("160,01")).toBe(160.01);
    expect(viNumber("")).toBeNull();
  });
});

describe("SJC gold, in đ per lượng", () => {
  it("giavang.net: SJC's own price, timed at its last real change", () => {
    const g = parseGiavang(read("giavang-2026-11-01.json"));
    expect(g).toMatchObject({ sourceId: "giavang", buy: 136_000_000, sell: 139_000_000 });
    expect(g.sourceTime).toBe("2026-10-31T08:12:06+07:00");
    expect(g.ring).toEqual({ product: "Nhẫn SJC 999.9", buy: 131_800_000, sell: 135_800_000, sourceTime: "2026-10-31T08:18:06+07:00" });
  });
  it("PNJ: thousand đ per chỉ times 10,000", () => {
    const g = parsePnj(read("pnj-2026-11-01.json"));
    expect(g).toMatchObject({ sourceId: "pnj", product: "Vàng miếng SJC 999.9", buy: 136_000_000, sell: 139_000_000 });
    expect(g.sourceTime).toBe("2026-10-31T10:38:15+07:00");
    expect(g.ring).toMatchObject({ product: "Nhẫn Trơn PNJ 999.9", buy: 133_600_000, sell: 137_600_000 });
  });
  it("Bảo Tín Mạnh Hải: the SJC row, not the purity column", () => {
    const g = parseBtmh(read("btmh-2026-11-01.html"));
    expect(g).toMatchObject({ sourceId: "btmh", product: "Vàng miếng SJC (Cty CP BTMH)", buy: 136_000_000, sell: 139_000_000 });
    expect(g.sourceTime).toBe("2026-10-31T18:14:58+07:00");
    // the plain ring row, not "Kim Gia Bảo Gift 24K" (138.8M) above it
    expect(g.ring).toMatchObject({ product: "Kim Gia Bảo 24K", buy: 133_800_000, sell: 137_800_000 });
  });
  it("refuse pages without an SJC price", () => {
    expect(() => parseGiavang('{"data":[]}')).toThrow(/no SJC/);
    expect(() => parsePnj('{"data":[]}')).toThrow(/no SJC/);
    expect(() => parseBtmh("<html></html>")).toThrow(/not the Bảo Tín/);
  });
  it("a missing ring row leaves the bar price and ring null", () => {
    const body = JSON.parse(read("giavang-2026-11-01.json"));
    body.data = body.data.filter((r: { type_code: string }) => r.type_code !== "SJ9999");
    expect(parseGiavang(JSON.stringify(body))).toMatchObject({ buy: 136_000_000, ring: null });
  });
});

describe("priceRoute", () => {
  const cache = () => {
    const m = new Map<string, Response>();
    return { m, match: async (k: Request) => m.get(k.url)?.clone(), put: async (k: Request, r: Response) => void m.set(k.url, r) };
  };
  it("asks each site once per 5 minutes", async () => {
    const c = cache();
    const calls: string[] = [];
    const fetcher = (async (u: string) => (calls.push(u), new Response(read("pnj-2026-11-01.json")))) as unknown as typeof fetch;
    await priceRoute("/api/gold/pnj", c, fetcher);
    const b = await priceRoute("/api/gold/pnj", c, fetcher)!;
    expect(calls).toHaveLength(1);
    expect((await b.json()).buy).toBe(136_000_000);
  });
  it("knows no other path", () => expect(priceRoute("/api/gold/sjc", cache())).toBeNull());
  it("names its own source in every error", async () => {
    const page = (async () => new Response("<html>maintenance</html>")) as unknown as typeof fetch;
    const down = (async () => new Response("", { status: 403 })) as unknown as typeof fetch;
    const errors = [];
    for (const p of ["/api/fx/vcb", "/api/fx/hsbc", "/api/gold/giavang", "/api/gold/pnj", "/api/gold/btmh"]) {
      errors.push((await (await priceRoute(p, cache(), page))!.json()).error);
    }
    expect(errors.map((e: string) => e.split(":")[0])).toEqual(["Vietcombank", "HSBC", "giavang.net", "PNJ", "Bảo Tín Mạnh Hải"]);
    expect(errors.every((e: string) => e.includes("could not read the prices"))).toBe(true);
    expect((await (await priceRoute("/api/gold/pnj", cache(), down))!.json()).error).toBe("PNJ: the site answered 403");
  });
});
