// Fails when a file git would commit holds an email, a key, a token or an env file.
// Runs before every commit (.githooks/pre-commit) and in CI. gitleaks runs beside it in CI.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const ALLOWED_EMAIL = /@(example\.com|users\.noreply\.github\.com)$/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const CHECKS = [
  { name: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "Google API key", re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: "OAuth refresh token", re: /\b1\/\/[0-9A-Za-z_-]{30,}/ },
  { name: "Anthropic key", re: /sk-ant-[0-9A-Za-z_-]{20,}/ },
  { name: "GitHub token", re: /\bgh[pousr]_[0-9A-Za-z]{30,}/ },
];
const SKIP = /(^|\/)(package-lock\.json)$/;

export function filesToCommit() {
  const out = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

export function scan(files) {
  const problems = [];
  for (const f of files) {
    if (/(^|\/)\.env($|\.)/.test(f) && !f.endsWith(".env.example")) problems.push(`${f}: env file`);
    if (f === "firestore.rules") problems.push(`${f}: built rules hold the owner's email`);
    if (SKIP.test(f)) continue;
    let text;
    try {
      if (statSync(f).size > 2_000_000) continue;
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const m of text.match(EMAIL) ?? []) {
      if (!ALLOWED_EMAIL.test(m)) problems.push(`${f}: email ${m.replace(/^[^@]+/, "***")}`);
    }
    for (const c of CHECKS) if (c.re.test(text)) problems.push(`${f}: ${c.name}`);
  }
  return problems;
}

if (process.argv[1]?.endsWith("check-secrets.mjs")) {
  const problems = scan(filesToCommit());
  if (problems.length) {
    console.error("Secret check FAILED:\n  " + problems.join("\n  "));
    process.exit(1);
  }
  console.log("Secret check passed");
}
