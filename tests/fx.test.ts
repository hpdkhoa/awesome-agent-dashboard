// The Vietcombank route: parse the real feed, keep the bank's 5-minute rule, fail clearly.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseVcb, vietnamTime, VCB_URL } from "../worker/vcb";
import { vcbRoute } from "../worker/index";

const XML = readFileSync("tests/fixtures/vcb-2026-11-01.xml", "utf8");

function memoryCache() {
  const store = new Map<string, Response>();
  return {
    store,
    match: async (k: Request) => store.get(k.url)?.clone(),
    put: async (k: Request, r: Response) => void store.set(k.url, r),
  };
}

describe("parseVcb", () => {
  const r = parseVcb(XML);
  it("reads all 20 currencies with numbers", () => {
    expect(Object.keys(r.rates)).toHaveLength(20);
    expect(r.rates.USD).toEqual({ name: "US DOLLAR", buy: 25580, transfer: 25610, sell: 25990 });
  });
  it("keeps a side the bank does not quote as null", () => {
    expect(r.rates.KWD.buy).toBeNull();
    expect(r.rates.KWD.transfer).toBe(83230.83);
  });
  it("reads the feed time as Vietnam time", () => {
    expect(r.sourceTime).toBe("2026-11-01T01:07:44+07:00");
    expect(vietnamTime("12/31/2026 12:05:00 PM")).toBe("2026-12-31T12:05:00+07:00");
    expect(vietnamTime("1/2/2026 12:05:00 AM")).toBe("2026-01-02T00:05:00+07:00");
  });
  it("refuses a page that is not the rate list", () => {
    expect(() => parseVcb("<html>Request Rejected</html>")).toThrow(/not a Vietcombank/);
  });
});

describe("vcbRoute", () => {
  it("asks the bank once, then answers from the 5-minute cache", async () => {
    const cache = memoryCache();
    const calls: string[] = [];
    const fetcher = (async (u: string) => (calls.push(u), new Response(XML))) as unknown as typeof fetch;
    const a = await vcbRoute(cache, fetcher);
    const b = await vcbRoute(cache, fetcher);
    expect(calls).toEqual([VCB_URL]);
    expect(a.headers.get("cache-control")).toBe("public, max-age=300");
    const [ja, jb] = [await a.json(), await b.json()];
    expect(jb).toEqual(ja);
    expect(ja.rates.USD.transfer).toBe(25610);
  });
  it("returns 502 and caches nothing when the bank refuses", async () => {
    const cache = memoryCache();
    const fetcher = (async () => new Response("<html>Request Rejected</html>")) as unknown as typeof fetch;
    const r = await vcbRoute(cache, fetcher);
    expect(r.status).toBe(502);
    expect((await r.json()).error).toMatch(/not a Vietcombank/);
    expect(cache.store.size).toBe(0);
  });
  it("returns 502 when the bank does not answer", async () => {
    const fetcher = (async () => {
      throw new Error("timeout");
    }) as unknown as typeof fetch;
    const r = await vcbRoute(memoryCache(), fetcher);
    expect(r.status).toBe(502);
  });
});
