import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The page lives in web/; .env sits at the repo root; Cloudflare Pages serves dist/.
export default defineConfig({
  root: "web",
  envDir: "..",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true },
});
