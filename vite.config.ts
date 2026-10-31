import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { vcbRoute } from "./worker/index";

// `npm run dev` only: answer /api/fx/vcb with the same code the Worker runs, so the local page can sync rates.
function devRates(): Plugin {
  const store = new Map<string, { res: Response; at: number }>();
  const cache = {
    match: async (k: Request) => {
      const hit = store.get(k.url);
      return hit && Date.now() - hit.at < 300_000 ? hit.res.clone() : undefined;
    },
    put: async (k: Request, res: Response) => void store.set(k.url, { res, at: Date.now() }),
  };
  return {
    name: "dev-rates",
    configureServer(server) {
      server.middlewares.use("/api/fx/vcb", async (_req, res) => {
        const r = await vcbRoute(cache);
        res.statusCode = r.status;
        res.setHeader("content-type", r.headers.get("content-type") ?? "application/json");
        res.end(await r.text());
      });
    },
  };
}

// The page lives in web/; .env sits at the repo root; Cloudflare serves dist/ and runs worker/index.ts for /api/*.
export default defineConfig({
  root: fileURLToPath(new URL("web", import.meta.url)),
  envDir: "..",
  plugins: [react(), devRates()],
  build: { outDir: "../dist", emptyOutDir: true },
});
