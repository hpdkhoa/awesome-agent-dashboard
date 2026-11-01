// The site's Worker. It serves the built page from ./dist and its own price routes:
// GET /api/fx/vcb fetches Vietcombank's public rate feed (the browser cannot: the bank allows only its own origin);
// GET /api/fx/hsbc and /api/gold/{giavang,pnj,btmh} fetch the other public pages the owner picked (sources.ts).
// Each answer is cached for 5 minutes, so each site sees at most one request per 5 minutes from this site, as
// Vietcombank's feed asks. The prices are public; the page saves them to Firestore under the owner's lock.
import { SOURCES } from "./sources";
import { parseVcb, VCB_MIN_GAP_S, VCB_URL } from "./vcb";

type Env = { ASSETS: { fetch(request: Request): Promise<Response> } };
type EdgeCache = { match(key: Request): Promise<Response | undefined>; put(key: Request, res: Response): Promise<void> };

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...extra } });

// One source: answer from the 5-minute cache, or fetch, parse and cache. A failed fetch or parse is never cached.
// Every error names its own source and step (the owner's rule, 2026-11-01: each parser reports its own error).
export async function sourceRoute(
  label: string, path: string, url: string, accept: string, parse: (body: string) => object,
  cache: EdgeCache, fetcher: typeof fetch = fetch, now = () => new Date(),
): Promise<Response> {
  const key = new Request(`https://cache.internal${path}`);
  const hit = await cache.match(key);
  if (hit) return hit;
  let body: string;
  try {
    const res = await fetcher(url, { headers: { accept, "user-agent": "Mozilla/5.0 (compatible; personal-rates/1.0)" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return json({ source: label, error: `${label}: the site answered ${res.status}` }, 502);
    body = await res.text();
  } catch (e) {
    return json({ source: label, error: `${label}: no answer (${(e as Error).message})` }, 502);
  }
  let out;
  try {
    out = { ...parse(body), fetchedAt: now().toISOString() };
  } catch (e) {
    return json({ source: label, error: `${label}: could not read the prices (${(e as Error).message})` }, 502);
  }
  const res = json(out, 200, { "cache-control": `public, max-age=${VCB_MIN_GAP_S}` });
  await cache.put(key, res.clone());
  return res;
}

export const vcbRoute = (cache: EdgeCache, fetcher: typeof fetch = fetch, now = () => new Date()) =>
  sourceRoute("Vietcombank", "/fx/vcb", VCB_URL, "text/xml", (xml) => ({ sourceId: "vcb", ...parseVcb(xml) }), cache, fetcher, now);

// Every price route by path, for the Worker and the dev server.
export function priceRoute(path: string, cache: EdgeCache, fetcher: typeof fetch = fetch): Promise<Response> | null {
  if (path === "/api/fx/vcb") return vcbRoute(cache, fetcher);
  const s = SOURCES[path];
  return s ? sourceRoute(s.label, path.slice(4), s.url, s.accept, s.parse, cache, fetcher) : null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname !== "/api/fx/vcb" && !(url.pathname in SOURCES)) return json({ error: "not found" }, 404);
      if (request.method !== "GET") return json({ error: "GET only" }, 405);
      return priceRoute(url.pathname, (caches as unknown as { default: EdgeCache }).default)!;
    }
    return env.ASSETS.fetch(request);
  },
};
