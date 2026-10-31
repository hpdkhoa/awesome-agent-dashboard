// Deploys the built firestore.rules to the owner's own Firebase project (FIREBASE_PROJECT_ID in .env).
import { spawnSync } from "node:child_process";
import { readEnv } from "./build-rules.mjs";

const project = process.env.FIREBASE_PROJECT_ID || readEnv().FIREBASE_PROJECT_ID;
if (!project) {
  console.error("FIREBASE_PROJECT_ID is missing in .env");
  process.exit(1);
}
const r = spawnSync("npx", ["firebase", "deploy", "--only", "firestore:rules", "--project", project], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(r.status ?? 1);
