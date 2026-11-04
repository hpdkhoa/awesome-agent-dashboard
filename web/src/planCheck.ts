// The plan-start check (the owner's words, 2026-11-04: "for fix 1 I will need the button to manual trigger the check and
// generate missing or resume it"). Fix 1 is the "Start a plan" prompt (Runs.tsx planPrompt): one mockup before round 1,
// posted with inbox_result, and image examples for the options the owner will see. The check counts what the plan has;
// the session judges which options need a picture, since only it knows what each option changes.
import type { InboxItem, Plan } from "./data";

const PIC = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;

export type PlanCheck = {
  mockup: string | null; // the first picture the plan's session posted with inbox_result after the plan opened
  questions: number;
  options: number;
  pictures: number; // options whose example is an image (before and after)
  missing: ("mockup" | "pictures")[];
};

export function checkPlan(plan: Plan, items: InboxItem[]): PlanCheck {
  const results = items
    .filter((i) => i.kind === "result" && i.sessionId === plan.sessionId && i.createdAt >= plan.createdAt)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const mockup = results.flatMap((i) => i.files ?? []).find((f) => PIC.test(f)) ?? null;
  const qs = items.filter((i) => i.kind === "question" && i.planId === plan.id);
  const opts = qs.flatMap((q) => q.options ?? []);
  const pictures = opts.filter((o) => o.example?.type === "image").length;
  const missing: PlanCheck["missing"] = [];
  if (!mockup) missing.push("mockup");
  if (opts.length > 0 && pictures === 0) missing.push("pictures");
  return { mockup, questions: qs.length, options: opts.length, pictures, missing };
}

// The message the button sends to the plan's session: make what is missing, or go on where it stopped.
export function checkPrompt(c: PlanCheck): string {
  if (c.missing.length === 0) return "Go on with the plan from where it stopped.";
  const found = `The owner pressed Check on this plan: mockup ${c.mockup ? "found" : "missing"}; ${c.pictures} of ${c.options} options in ${c.questions} questions have an image example.`;
  const make = [
    c.missing.includes("mockup") &&
      "Make one mockup of how the user stories in this plan will look, as a PNG or SVG picture in this folder, and post it with inbox_result.",
    c.missing.includes("pictures") &&
      "Check every option asked so far: each option that changes what the owner will see (a screen, a layout, a picture) needs an image example with before and after pictures (the mockup as it is, and the mockup with that option). Ask those questions again with the pictures.",
  ].filter(Boolean);
  return [found, ...make, "Then go on with the plan."].join("\n\n");
}
