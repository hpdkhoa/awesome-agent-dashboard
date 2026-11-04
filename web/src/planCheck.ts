// Generate and check, on every plan (the owner's words, 2026-11-04: "the button to manual check and generate in the
// existing plan session, not only in start new plan"; "the flow must be I start the plan, then explore the plan, when
// almost good or whenever I need I will ask to generate the images, diagrams, graph, screenshot, mockup, data"; choice
// "Kinds to tick + a note, one Generate"). The owner's order is a plain message to the plan's session; the session
// posts each kind with inbox_result(title "Generated <kind>", files). Check reads what came back for the last order and
// sends again only what is missing; with nothing missing, it resumes the plan.
import type { InboxItem, Plan, Run } from "./data";

export type Kind = "mockup" | "diagram" | "image" | "chart" | "screenshot" | "data";
export const KINDS: { id: Kind; name: string; makes: string }[] = [
  { id: "mockup", name: "Mockup", makes: "how the user stories will look, as a PNG or SVG picture" },
  { id: "diagram", name: "Diagram", makes: "a flow, structure or sequence diagram, as SVG" },
  { id: "image", name: "Image", makes: "a picture of what the plan changes, PNG or SVG" },
  { id: "chart", name: "Chart / graph", makes: "a chart of the plan's numbers, as SVG or PNG" },
  { id: "screenshot", name: "Screenshot", makes: "a screenshot of the real page or app, PNG" },
  { id: "data", name: "Data", makes: "sample or measured data, as CSV or JSON" },
];
export const kindName = (k: Kind) => KINDS.find((x) => x.id === k)?.name ?? k;

export type GenerateOrder = { kinds: Kind[]; note: string; at: string };

// The owner's last Generate order on this plan.
export function lastOrder(plan: Plan, runs: Run[]): GenerateOrder | null {
  const r = runs
    .filter((x) => x.planId === plan.id && x.generate?.kinds?.length)
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))[0];
  return r?.generate ? { kinds: r.generate.kinds, note: r.generate.note ?? "", at: r.createdAt ?? "" } : null;
}

export type GenerateCheck = { order: GenerateOrder; got: Partial<Record<Kind, string[]>>; missing: Kind[] };

// What came back for the order: the plan session's "Generated <kind>" results with files, posted after the order.
export function checkGenerate(plan: Plan, order: GenerateOrder, items: InboxItem[]): GenerateCheck {
  const got: Partial<Record<Kind, string[]>> = {};
  for (const i of items) {
    if (i.kind !== "result" || i.sessionId !== plan.sessionId || i.createdAt < order.at || !i.files?.length) continue;
    const word = /^generated\s+(.+?)(?:[:\s]|$)/i.exec(i.title)?.[1]?.toLowerCase() ?? "";
    const k = KINDS.find((x) => x.id === word || x.name.toLowerCase().startsWith(word) || (word === "graph" && x.id === "chart"))?.id;
    if (k && order.kinds.includes(k)) got[k] = [...(got[k] ?? []), ...i.files];
  }
  return { order, got, missing: order.kinds.filter((k) => !got[k]?.length) };
}

// Where the files go (the owner's choice, 2026-11-04: "use The project folder and add .gitignore"; approved: "Name the
// folder by plan id, not session id", "Never overwrite inside a version", "Delete keeps the files"): one folder per
// plan version, inside the plan's project folder. The bridge adds .plan_data/ to the project's .gitignore.
export const generateFolder = (plan: Pick<Plan, "id" | "current">) => `.plan_data/${plan.id}/v${plan.current}`;

// The order the Generate button sends, and Make the missing sends again for the kinds still missing.
export function generatePrompt(kinds: Kind[], note: string, folder: string): string {
  const list = kinds.map((k) => `- ${kindName(k)}: ${KINDS.find((x) => x.id === k)?.makes}`).join("\n");
  return [
    "The owner asks you to generate these for this plan:",
    list,
    note.trim() ? `The owner's note: "${note.trim()}"` : "",
    `Save each file in ${folder}/ (make the folder), named <kind>-<what>.<ext>. Never overwrite: if the name is taken, add -2, -3.`,
    'Post each kind with inbox_result(title="Generated <kind>: what it shows", files=[the paths]), one result per kind. Then go on with the plan; do not change the plan unless the owner asks.',
  ].filter(Boolean).join("\n\n");
}

export const resumePrompt = "Go on with the plan from where it stopped.";
