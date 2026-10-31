// Writes firestore.rules from firestore.rules.template with OWNER_EMAIL from .env or the environment.
// firestore.rules is in .gitignore: it holds the owner's email and never leaves this machine except to Firebase.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

export const EMAIL_RE = /^[^\s@"\\]+@[^\s@"\\]+\.[^\s@"\\]+$/;

export function readEnv(path = ".env") {
  const env = {};
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

export function fillRules(template, email) {
  if (!EMAIL_RE.test(email)) throw new Error("OWNER_EMAIL is missing or not an email");
  return template.replaceAll("__OWNER_EMAIL__", email.toLowerCase());
}

if (process.argv[1]?.endsWith("build-rules.mjs")) {
  const email = process.env.OWNER_EMAIL || readEnv().OWNER_EMAIL || "";
  const rules = fillRules(readFileSync("firestore.rules.template", "utf8"), email);
  writeFileSync("firestore.rules", rules);
  console.log("firestore.rules written for the owner's email (not shown)");
}
