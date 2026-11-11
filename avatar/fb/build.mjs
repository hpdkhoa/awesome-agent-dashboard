// node avatar/fb/build.mjs: bundles entry.js (Firebase from the repo's node_modules) into avatar/ui/fb.js
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
await build({ entryPoints: [join(here, "entry.js")], bundle: true, minify: true, format: "iife", target: "es2020",
  outfile: join(here, "..", "ui", "fb.js"), legalComments: "none" });
