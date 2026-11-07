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

export type GenerateCheck = {
  order: GenerateOrder; got: Partial<Record<Kind, string[]>>; missing: Kind[];
  results: { id: string; kind: Kind; files: string[] }[]; // the "Generated" results the check read
};

// What came back for the order: the plan session's "Generated <kind>" results with files, posted after the order.
export function checkGenerate(plan: Plan, order: GenerateOrder, items: InboxItem[]): GenerateCheck {
  const got: Partial<Record<Kind, string[]>> = {};
  const results: GenerateCheck["results"] = [];
  for (const i of items) {
    if (i.kind !== "result" || i.sessionId !== plan.sessionId || i.createdAt < order.at || !i.files?.length) continue;
    const word = /^generated\s+(.+?)(?:[:\s]|$)/i.exec(i.title)?.[1]?.toLowerCase() ?? "";
    const k = KINDS.find((x) => x.id === word || x.name.toLowerCase().startsWith(word) || (word === "graph" && x.id === "chart"))?.id;
    if (k && order.kinds.includes(k)) {
      got[k] = [...(got[k] ?? []), ...i.files];
      results.push({ id: i.id, kind: k, files: i.files });
    }
  }
  return { order, got, missing: order.kinds.filter((k) => !got[k]?.length), results };
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
    // the owner's words, 2026-11-06: "make it so next time I ask any plan session to generate user stories diagram then I
    // can get the same style as result"
    kinds.includes("diagram") ? "A user-stories diagram follows the user-stories-diagram skill (the owner's approved map style)." : "",
    `Save each file in ${folder}/tmp/ (make the folder), named <kind>-<what>.<ext>. Never overwrite: if the name is taken, add -2, -3. The files stay in tmp/ until the owner approves them.`,
    'Post each kind with inbox_result(title="Generated <kind>: what it shows", files=[the paths]), one result per kind. Then go on with the plan; do not change the plan unless the owner asks.',
  ].filter(Boolean).join("\n\n");
}

export const resumePrompt = "Go on with the plan from where it stopped.";

// Approval (the owner's words, 2026-11-04: "the generated files I'm not approved must stay in a tmp folder inside
// current folder structure of generated files; then when I approve the final result of the generated step then only
// approved items go to plan, tmp files need to be removed (tmp folder and dashboard)"). A file waits for approval while
// it is not on the plan's approved record.
const TMP = /^(\.plan_data\/[A-Za-z0-9]+\/v\d+)\/tmp\//;
const VERSION = /^(\.plan_data\/([A-Za-z0-9]+)\/v\d+)\/(?:tmp\/)?[^/]+$/;
// A result's path inside the plan's project folder: forward slashes, the project folder cut off (results may carry
// absolute paths).
export function relPath(file: string, cwd = ""): string {
  const f = file.replace(/\\/g, "/");
  const base = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  return base && f.toLowerCase().startsWith(base.toLowerCase() + "/") ? f.slice(base.length + 1) : f.replace(/^\.\//, "");
}
export const tmpFolderOf = (file: string, cwd = "") => TMP.exec(relPath(file, cwd))?.[1] ?? null;
// The version folder of a file in this plan's own .plan_data folder (in tmp/ or not); null for any other file.
export function versionFolderOf(file: string, planId: string, cwd = ""): string | null {
  const m = VERSION.exec(relPath(file, cwd));
  return m && m[2] === planId ? m[1] : null;
}
// The owner's words, 2026-11-08: "I don't want the checkbox is approved I want tick the checkbox and at the end click
// approve button". A file is approved only when the owner's approval is on record: the plan's Generated section
// (planGenerated). Every other file waits for a tick, wherever it sits.
export const approvedFiles = (rec: { versions?: Record<string, { file: string }[]> } | null) =>
  new Set(Object.values(rec?.versions ?? {}).flat().map((x) => x.file));

// One approval per version folder: the ticked files are approved (from tmp/ they move up), tmp/ goes with the rest;
// a result is dropped from the dashboard once none of its files still waits outside tmp/.
export function approvals(c: GenerateCheck, ticked: string[], planId: string, cwd = "", approved = new Set<string>()):
  { folder: string; keep: string[]; drop: string[] }[] {
  const byFolder = new Map<string, { keep: string[]; drop: Set<string> }>();
  const keep = new Set(ticked.map((f) => relPath(f, cwd)));
  for (const r of c.results) {
    const rel = r.files.map((f) => relPath(f, cwd));
    const folders = [...new Set(rel.map((f) => versionFolderOf(f, planId)).filter((x): x is string => !!x))];
    const left = rel.some((f) => !tmpFolderOf(f) && !keep.has(f) && !approved.has(f));
    for (const folder of folders) {
      const g = byFolder.get(folder) ?? { keep: [], drop: new Set<string>() };
      for (const f of rel) if (keep.has(f) && !approved.has(f) && versionFolderOf(f, planId) === folder && !g.keep.includes(f)) g.keep.push(f);
      if (!left) g.drop.add(r.id);
      byFolder.set(folder, g);
    }
  }
  return [...byFolder].filter(([, g]) => g.keep.length).map(([folder, g]) => ({ folder, keep: g.keep, drop: [...g.drop] }));
}
