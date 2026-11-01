// The Money tab: Vietnamese number input, the rate each asset is valued at, and the profit or loss from the price paid.
import { describe, expect, it } from "vitest";
import { holdings, parseAmount, same, syncAll, valuations, type Entry, type FxSnapshot, type GoldPrice } from "../web/src/moneyData";

describe("amount input", () => {
  it("reads Vietnamese format", () => {
    expect(parseAmount("1,5").value).toBe(1.5);
    expect(parseAmount("1.000.000").value).toBe(1_000_000);
    expect(parseAmount("1.234,5").value).toBe(1234.5);
    expect(parseAmount("250000").value).toBe(250_000);
  });
  it("refuses what it would have to guess, with a reason", () => {
    expect(parseAmount("1.5").error).toMatch(/thousands/);
    expect(parseAmount("1,000,000").error).toMatch(/thousands/);
    expect(parseAmount("0").error).toMatch(/above 0/);
    expect(parseAmount("").error).toBe("type an amount");
  });
});

const fx = [{ sourceId: "vcb", sourceTime: "2026-11-01T09:00:00+07:00", rates: {
  USD: { name: "", buy: 25_000, transfer: 25_100, sell: 25_400 },
  EUR: { name: "", buy: 28_000, transfer: 28_200, sell: 29_000 },
} } as unknown as FxSnapshot];
const gold = [
  { sourceId: "pnj", source: "PNJ", product: "Vàng miếng SJC 999.9", buy: 136_500_000, sell: null, sourceTime: "2026-11-01T10:00:00+07:00" },
  { sourceId: "giavang", source: "giavang.net (SJC's price)", product: "Vàng SJC 1L, 10L", buy: 136_000_000, sell: 139_000_000,
    sourceTime: "2026-10-31T08:12:06+07:00", ring: { product: "Nhẫn SJC 999.9", buy: 131_800_000, sell: 135_800_000, sourceTime: "2026-10-31T08:18:06+07:00" } },
] as GoldPrice[];
let n = 0;
const entry = (asset: Entry["asset"], direction: "in" | "out", amount: number, price?: number): Entry =>
  ({ id: String(++n), date: "2026-11-01", createdAt: `2026-11-01T00:00:0${n}Z`, asset, direction, amount, price, note: "" });

describe("balance", () => {
  const vals = valuations(fx, gold);
  it("values gold at SJC's own price on giavang.net, bar and ring apart", () => {
    expect(vals.GOLD_BAR?.rate).toBe(13_600_000);
    expect(vals.GOLD_RING?.rate).toBe(13_180_000);
    expect(vals.EUR?.rate).toBe(28_000);
  });
  it("gives profit or loss from the average price paid", () => {
    const h = holdings([
      entry("VND", "in", 10_000_000),
      entry("GOLD_RING", "in", 2, 13_000_000),
      entry("GOLD_RING", "in", 2, 13_400_000),
      entry("GOLD_RING", "out", 1),
      entry("USD", "in", 100, 25_500),
    ], vals);
    const ring = h.rows.find((x) => x.asset === "GOLD_RING")!;
    expect(ring.qty).toBe(3);
    expect(ring.cost).toBeCloseTo(3 * 13_200_000);
    expect(ring.value).toBe(3 * 13_180_000);
    expect(h.total).toBe(10_000_000 + 3 * 13_180_000 + 100 * 25_000);
    expect(h.profit).toBeCloseTo(3 * -20_000 + 100 * -500);
  });
  it("shows no profit for an asset with an entry missing its price", () => {
    const h = holdings([entry("EUR", "in", 50, 27_000), entry("EUR", "in", 10)], vals);
    expect(h.rows.find((x) => x.asset === "EUR")).toMatchObject({ cost: null, unpriced: 1, value: 60 * 28_000 });
    expect(h.profitOf).toBe(0);
  });
  it("reads the first gold entries as the SJC bar", () => {
    expect(holdings([entry("GOLD", "in", 1)], vals).rows.find((x) => x.asset === "GOLD_BAR")?.value).toBe(13_600_000);
  });
});

describe("sync compare", () => {
  it("sees Firestore's sorted keys as the same rates", () => {
    expect(same({ USD: { name: "x", buy: 1, transfer: 2 } }, { USD: { buy: 1, name: "x", transfer: 2 } })).toBe(true);
    expect(same({ USD: { buy: 1 } }, { USD: { buy: 2 } })).toBe(false);
  });
});

describe("sync gap", () => {
  it("runs at most once every 5 minutes, Save and the Sync button together", async () => {
    let asked = 0;
    globalThis.fetch = (async () => (asked++, new Response(JSON.stringify({ error: "offline" }), { status: 502 }))) as unknown as typeof fetch;
    const t0 = Date.parse("2026-11-01T10:00:00Z");
    expect(await syncAll([], [], () => t0)).toHaveLength(5);
    expect(asked).toBe(5);
    const second = await syncAll([], [], () => t0 + 4 * 60_000);
    expect(second).toHaveLength(1);
    expect(second[0].text).toMatch(/Nothing was asked or written/);
    expect(asked).toBe(5);
    expect(await syncAll([], [], () => t0 + 5 * 60_000)).toHaveLength(5);
    expect(asked).toBe(10);
  });
});
