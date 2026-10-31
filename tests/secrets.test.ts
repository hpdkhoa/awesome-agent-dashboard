// The repo is public-ready: the checker must catch each kind of leak, and the repo itself must be clean.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { filesToCommit, scan } from "../scripts/check-secrets.mjs";
import { fillRules } from "../scripts/build-rules.mjs";

function fileWith(name: string, text: string) {
  const dir = mkdtempSync(join(tmpdir(), "aad-"));
  const p = join(dir, name).replace(/\\/g, "/");
  writeFileSync(p, text);
  return p;
}

describe("the secret check catches", () => {
  const leaks: [string, string, string][] = [
    ["a real email", "notes.md", "write to a.person@" + "gmail.com"],
    ["a private key", "k.txt", "-----BEGIN " + "PRIVATE KEY-----"],
    ["a Google API key", "c.ts", "const k = 'AIza" + "x".repeat(35) + "'"],
    ["a refresh token", "t.json", '{"refresh_token":"1//' + "y".repeat(40) + '"}'],
    ["an Anthropic key", "a.txt", "sk-ant-" + "z".repeat(30)],
    ["an env file", ".env", "X=1"],
  ];
  for (const [what, name, text] of leaks)
    it(what, () => expect(scan([fileWith(name, text)]).length).toBeGreaterThan(0));
});

describe("the secret check allows", () => {
  it("example.com and GitHub no-reply addresses", () =>
    expect(scan([fileWith("ok.md", "owner@example.com 1+x@users.noreply.github.com")])).toEqual([]));
});

it("the repo has no leak", () => expect(scan(filesToCommit())).toEqual([]));

describe("rules build", () => {
  it("refuses a missing or broken email", () => {
    expect(() => fillRules("x", "")).toThrow();
    expect(() => fillRules("x", 'a"@b.co')).toThrow();
  });
  it("fills the email, lower case", () => expect(fillRules('"__OWNER_EMAIL__"', "Owner@Example.com")).toBe('"owner@example.com"'));
});
