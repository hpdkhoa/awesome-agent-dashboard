// Generate and check, on every plan (the owner's words, 2026-11-04: "the button to manual check and generate in the
// existing plan session, not only in start new plan"; "the flow must be I start the plan, then explore the plan, when
// almost good or whenever I need I will ask to generate the images, diagrams, graph, screenshot, mockup, data"; choice
// "Kinds to tick + a note, one Generate"). The owner's order is a plain message to the plan's session; the session
// posts each kind with inbox_result(title "Generated <kind>", files). Check reads what came back for the last order and
// sends again only what is missing; with nothing missing, it resumes the plan.
//
// Purpose x format (the owner's picks, 2026-11-16, on "the generate feature in plan is stuck with the type, cannot do a
// flexible one ... I want the generated can show me what is the different and a bigger map of features and product":
// "Build S1" what it shows x format, "Build S2" Compare against a base, "Build S3" feature + product map, "Build S4"
// the owner's own kind, Check accepts any "Generated <name>").
import type { InboxItem, Parts, Plan, PlanVersion, Run } from "./data";
import { diffLines, PART_NAMES, partLines } from "./planDiff";

// A kind is a purpose id below, an older order's kind (mockup, diagram, image, chart, data) or the owner's own words.
export type Kind = string;
type KindDef = { id: string; name: string; makes: string; also?: string[]; pick?: boolean };
export const KINDS: KindDef[] = [
  { id: "compare", name: "Compare", pick: true, also: ["diff", "difference"],
    makes: "what is different between the base and this plan version: one row per feature or item, base and after side by side, each row tagged new, changed, removed or same, with a legend and the count of each tag" },
  { id: "featuremap", name: "Feature map", pick: true, also: ["features"],
    makes: "this plan's features grouped by product area, each tagged new, changed or kept, each linked to the plan steps that build it" },
  { id: "productmap", name: "Product map", pick: true, also: ["product"],
    makes: "the whole product as one zoomable map: the product in the middle, its areas around it, every feature as a leaf; this plan's features coloured new, changed or kept, the rest grey; a leaf names its plan step; a legend and the count of each colour" },
  { id: "flow", name: "Flow", pick: true, also: ["diagram", "sequence", "structure"], makes: "a flow, structure or sequence diagram" },
  { id: "stories", name: "User stories", pick: true, also: ["user-stories", "user story"],
    makes: "a user-stories diagram, in the user-stories-diagram skill's style (the owner's approved map)" },
  { id: "mockup", name: "Mockup", pick: true, makes: "how the screens of the user stories will look" },
  { id: "numbers", name: "Numbers", pick: true, also: ["chart", "graph"],
    makes: "a chart of the plan's numbers, with its points, a legend and the stats (first, last, min, max, mean, count, period)" },
  { id: "screenshot", name: "Screenshot", pick: true, makes: "a screenshot of the real page or app" },
  // older orders' kinds: still named and checked, no longer offered
  { id: "diagram", name: "Diagram", makes: "a flow, structure or sequence diagram, as SVG" },
  { id: "image", name: "Image", makes: "a picture of what the plan changes, PNG or SVG" },
  { id: "chart", name: "Chart / graph", also: ["graph"], makes: "a chart of the plan's numbers, as SVG or PNG" },
  { id: "data", name: "Data", makes: "sample or measured data, as CSV or JSON" },
];
export const PICK = KINDS.filter((k) => k.pick);
const def = (k: Kind) => KINDS.find((x) => x.id === k);
export const kindName = (k: Kind) => def(k)?.name ?? k;
// The owner's own kind: their words, trimmed and lower case ("Risk map " is "risk map").
export const ownKind = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase().slice(0, 40);
// A file name's first word for a kind: the id, or the owner's words without spaces ("risk map" is riskmap).
export const kindSlug = (k: Kind) => (def(k) ? k : k.replace(/[^a-z0-9]+/g, "")) || "file";

export type Format = "svg" | "png" | "html" | "csv";
export const FORMATS: { id: Format; name: string; makes: string }[] = [
  { id: "svg", name: "SVG", makes: "an SVG picture" },
  { id: "png", name: "PNG", makes: "a PNG picture" },
  { id: "html", name: "HTML (zoom)", makes: "one standalone HTML page that zooms and pans, built from the responsive-web-style skill" },
  { id: "csv", name: "CSV / JSON", makes: "the data behind it, as CSV or JSON" },
];

// What Compare compares against: the plan version before, a chosen version, or the product as it is now.
export type Base = "last" | "product" | `v${number}`;

export type GenerateOrder = { kinds: Kind[]; formats: Format[]; base: Base; note: string; at: string };

// The owner's last Generate order on this plan.
export function lastOrder(plan: Plan, runs: Run[]): GenerateOrder | null {
  const r = runs
    .filter((x) => x.planId === plan.id && x.generate?.kinds?.length)
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))[0];
  const g = r?.generate;
  return g ? { kinds: g.kinds, formats: g.formats ?? [], base: g.base ?? "last", note: g.note ?? "", at: r.createdAt ?? "" } : null;
}

export type GenerateCheck = {
  order: GenerateOrder; got: Partial<Record<Kind, string[]>>; missing: Kind[];
  results: { id: string; kind: Kind; files: string[] }[]; // the "Generated" results the check read
};

// The asked kind a result's title names: "Generated <name>: what it shows", by the kind's name, id or other words,
// the longest match first (so "feature map" never counts as "map").
export function kindOfTitle(title: string, asked: Kind[]): Kind | null {
  const rest = /^generated\s+(.+)$/i.exec(title.trim())?.[1]?.toLowerCase() ?? "";
  if (!rest) return null;
  const words = asked.flatMap((k) => [k, kindName(k), ...(def(k)?.also ?? [])].map((w) => ({ k, w: w.toLowerCase() })));
  words.sort((a, b) => b.w.length - a.w.length);
  const hit = words.find(({ w }) => rest === w || rest.startsWith(w + ":") || rest.startsWith(w + " ") || rest.startsWith(w + ","));
  return hit?.k ?? null;
}

// What came back for the order: the plan session's "Generated <kind>" results with files, posted after the order.
export function checkGenerate(plan: Plan, order: GenerateOrder, items: InboxItem[]): GenerateCheck {
  const got: Partial<Record<Kind, string[]>> = {};
  const results: GenerateCheck["results"] = [];
  for (const i of items) {
    if (i.kind !== "result" || i.sessionId !== plan.sessionId || i.createdAt < order.at || !i.files?.length) continue;
    const k = kindOfTitle(i.title, order.kinds);
    if (k) {
      got[k] = [...(got[k] ?? []), ...i.files];
      results.push({ id: i.id, kind: k, files: i.files });
    }
  }
  return { order, got, missing: order.kinds.filter((k) => !got[k]?.length), results };
}

// The base version Compare reads: "last" is the version before the current one; none when the plan has no such version.
export function baseVersion(base: Base, current: number): number | null {
  if (base === "product") return null;
  const n = base === "last" ? current - 1 : Number(base.slice(1));
  return Number.isInteger(n) && n >= 0 && n < current ? n : null;
}

// The plan's own difference between two versions, part by part, for the Compare prompt: only the lines that changed.
export function partsDiffText(a: Parts | undefined, b: Parts | undefined, max = 6000): string {
  if (!a || !b) return "";
  const out: string[] = [];
  for (const [k, name] of PART_NAMES) {
    const d = diffLines(partLines(a, k), partLines(b, k)).filter((l) => l.op !== "same");
    if (d.length) out.push(`${name}:`, ...d.map((l) => `${l.op === "add" ? "+" : "-"} ${l.text}`));
  }
  const t = out.join("\n");
  return t.length > max ? t.slice(0, max) + "\n… (cut; read the rest from the plan versions)" : t;
}

// The base for the prompt: its words, and the plan's own diff when the base is a plan version.
export function compareBase(base: Base, current: number, versions: PlanVersion[] | null): { says: string; diff: string } {
  const n = baseVersion(base, current);
  if (n === null)
    return { says: "the product as it is now (read the project folder: the code and pages that exist today)", diff: "" };
  const at = (m: number) => versions?.find((v) => v.n === m)?.parts;
  return { says: `plan version v${n}`, diff: partsDiffText(at(n), at(current)) };
}

// Where the files go (the owner's choice, 2026-11-04: "use The project folder and add .gitignore"; approved: "Name the
// folder by plan id, not session id", "Never overwrite inside a version", "Delete keeps the files"): one folder per
// plan version, inside the plan's project folder. The bridge adds .plan_data/ to the project's .gitignore.
export const generateFolder = (plan: Pick<Plan, "id" | "current">) => `.plan_data/${plan.id}/v${plan.current}`;

// The order the Generate button sends, and Make the missing sends again for the kinds still missing.
export type PromptOpts = { formats?: Format[]; current?: number; base?: Base; baseSays?: string; baseDiff?: string };
export function generatePrompt(kinds: Kind[], note: string, folder: string, o: PromptOpts = {}): string {
  const list = kinds.map((k) => {
    const d = def(k);
    return d ? `- ${d.name}: ${d.makes}` : `- ${k}: the owner's own kind; make what these words ask for, read with the owner's note`;
  }).join("\n");
  const formats = o.formats ?? [];
  const asFormat = formats.length
    ? `Make each one as ${formats.map((f) => FORMATS.find((x) => x.id === f)?.makes).join(", and as ")}.`
    : "Make each one in the format that shows it best (SVG, PNG, an HTML page that zooms, CSV or JSON).";
  const compare = kinds.includes("compare")
    ? [`Compare: the base is ${o.baseSays ?? "the plan version before this one"}; the after is plan version v${o.current ?? "now"}.`,
       o.baseDiff ? `The plan's own lines that changed from the base to v${o.current} (+ added, - removed):\n${o.baseDiff}` : "",
       "Tag each row new, changed, removed or same; count each tag on the picture."].filter(Boolean).join("\n")
    : "";
  return [
    "The owner asks you to generate these for this plan:",
    list,
    asFormat,
    compare,
    note.trim() ? `The owner's note: "${note.trim()}"` : "",
    // the owner's words, 2026-11-06: "make it so next time I ask any plan session to generate user stories diagram then I
    // can get the same style as result"; since 2026-11-16 ("Build S4") only when User stories is asked
    kinds.includes("stories") || kinds.includes("diagram") ? "A user-stories diagram follows the user-stories-diagram skill (the owner's approved map style)." : "",
    "Every chart, map or compare shows its legend and its counts (the owner's global rule for graphs and charts).",
    `Save each file in ${folder}/tmp/ (make the folder), named <kind>-<what>.<ext>, with these kinds: ${kinds.map(kindSlug).join(", ")}. Never overwrite: if the name is taken, add -2, -3. The files stay in tmp/ until the owner approves them.`,
    `Post each kind with inbox_result(title="Generated <kind>: what it shows", files=[the paths]), one result per kind, <kind> being one of: ${kinds.map(kindName).join(", ")}. Then go on with the plan; do not change the plan unless the owner asks.`,
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
// Each kept file carries its result's kind, so the plan's Generated section files it under that kind, the owner's own
// kinds too.
export function approvals(c: GenerateCheck, ticked: string[], planId: string, cwd = "", approved = new Set<string>()):
  { folder: string; keep: string[]; drop: string[]; kinds: Record<string, Kind> }[] {
  const byFolder = new Map<string, { keep: string[]; drop: Set<string>; kinds: Record<string, Kind> }>();
  const keep = new Set(ticked.map((f) => relPath(f, cwd)));
  for (const r of c.results) {
    const rel = r.files.map((f) => relPath(f, cwd));
    const folders = [...new Set(rel.map((f) => versionFolderOf(f, planId)).filter((x): x is string => !!x))];
    const left = rel.some((f) => !tmpFolderOf(f) && !keep.has(f) && !approved.has(f));
    for (const folder of folders) {
      const g = byFolder.get(folder) ?? { keep: [], drop: new Set<string>(), kinds: {} };
      for (const f of rel)
        if (keep.has(f) && !approved.has(f) && versionFolderOf(f, planId) === folder && !g.keep.includes(f)) (g.keep.push(f), (g.kinds[f] = r.kind));
      if (!left) g.drop.add(r.id);
      byFolder.set(folder, g);
    }
  }
  return [...byFolder].filter(([, g]) => g.keep.length).map(([folder, g]) => ({ folder, keep: g.keep, drop: [...g.drop], kinds: g.kinds }));
}
