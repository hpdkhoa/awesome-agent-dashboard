// The site's Worker. It serves the built page from ./dist and one route of its own:
// GET /api/fx/vcb fetches Vietcombank's public rate feed (the browser cannot: the bank allows only its own origin)
// and returns it as JSON. The answer is cached for 5 minutes, so the bank sees at most one request per 5 minutes
// from this site, as its feed asks. The rates are public; the page saves them to Firestore under the owner's lock.
import { parseVcb, VCB_MIN_GAP_S, VCB_URL } from "./vcb";

type Env = { ASSETS: { fetch(request: Request): Promise<Response> } };
type EdgeCache = { match(key: Request): Promise<Response | undefined>; put(key: Request, res: Response): Promise<void> };

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...extra } });

export async function vcbRoute(cache: EdgeCache, fetcher: typeof fetch = fetch, now = () => new Date()): Promise<Response> {
  const key = new Request("https://cache.internal/fx/vcb");
  const hit = await cache.match(key);
  if (hit) return hit;
  let xml: string;
  try {
    const res = await fetcher(VCB_URL, { headers: { accept: "text/xml" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return json({ error: `Vietcombank answered ${res.status}` }, 502);
    xml = await res.text();
  } catch (e) {
    return json({ error: `Vietcombank did not answer: ${(e as Error).message}` }, 502);
  }
  let body;
  try {
    body = { ...parseVcb(xml), fetchedAt: now().toISOString() };
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
  const res = json(body, 200, { "cache-control": `public, max-age=${VCB_MIN_GAP_S}` });
  await cache.put(key, res.clone());
  return res;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/fx/vcb") {
      if (request.method !== "GET") return json({ error: "GET only" }, 405);
      return vcbRoute((caches as unknown as { default: EdgeCache }).default);
    }
    if (url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404);
    return env.ASSETS.fetch(request);
  },
};
