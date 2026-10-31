// P0 walls: only the owner's verified Google account reads or writes; everyone else is refused.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { fillRules } from "../scripts/build-rules.mjs";

const OWNER = "owner@example.com";
let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-agent-dashboard",
    firestore: { rules: fillRules(readFileSync("firestore.rules.template", "utf8"), OWNER), host: "127.0.0.1", port: 8080 },
  });
});
beforeEach(() => env.clearFirestore());
afterAll(() => env.cleanup());

function signedIn(email: string, verified = true, provider = "google.com") {
  return env
    .authenticatedContext("uid-" + email + provider, {
      email,
      email_verified: verified,
      firebase: { sign_in_provider: provider },
    })
    .firestore();
}

const paths = ["meta/owner", "work/labs", "work/labs/sessions/s1/items/q1", "moneyEntries/e1", "fxRates/r1", "goldPrices/g1"];

describe("the owner", () => {
  for (const p of paths)
    it(`reads and writes ${p}`, async () => {
      const db = signedIn(OWNER);
      await assertSucceeds(setDoc(doc(db, p), { ok: true }));
      await assertSucceeds(getDoc(doc(db, p)));
    });
});

describe("refused", () => {
  const cases: [string, () => ReturnType<typeof signedIn>][] = [
    ["another Google account", () => signedIn("someone@example.com")],
    ["the owner's email, not verified", () => signedIn(OWNER, false)],
    ["the owner's email by password sign-in", () => signedIn(OWNER, true, "password")],
    ["the owner's email by anonymous sign-in", () => signedIn(OWNER, true, "anonymous")],
    ["not signed in", () => env.unauthenticatedContext().firestore()],
  ];
  for (const [who, db] of cases)
    for (const p of paths)
      it(`${who}: read and write ${p}`, async () => {
        await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), p), { ok: true }));
        await assertFails(getDoc(doc(db(), p)));
        await assertFails(setDoc(doc(db(), p), { ok: false }));
      });
});
