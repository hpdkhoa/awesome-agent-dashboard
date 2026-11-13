// Merging the answers of several boxes, and choosing the box a write goes to (fs.ts). Pure, so it is tested without a
// browser (the owner's words, 2026-11-13: "each bridge give out their data and dashboard will render all data after
// filter in dashboard side").

export type Row = { id: string; data: Record<string, unknown> };
export type Write =
  | { op: "set"; path: string; data: Record<string, unknown>; merge: boolean }
  | { op: "update"; path: string; fields: Record<string, unknown> }
  | { op: "delete"; path: string };

const fieldOf = (d: Record<string, unknown>, path: string) =>
  path.split(".").reduce<unknown>((cur, k) => (cur as Record<string, unknown> | undefined)?.[k], d);
const cmp = (a: unknown, b: unknown) => (a === b ? 0 : (a as never) < (b as never) ? -1 : 1);

// Totals every box keeps under the same id (a day's usage, a work type): the boxes' numbers are added.
export const SUMMED = new Set(["usage", "workTypes"]);
function addUp(a: unknown, b: unknown): unknown {
  if (typeof a === "number" && typeof b === "number") return a + b;
  if (Array.isArray(a) && Array.isArray(b)) return [...new Set([...a, ...b])];
  if (a && b && typeof a === "object" && typeof b === "object") {
    const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
    for (const [k, v] of Object.entries(b as Record<string, unknown>)) out[k] = k in out ? addUp(out[k], v) : v;
    return out;
  }
  return typeof a === "string" && typeof b === "string" ? (a > b ? a : b) : a ?? b; // dates and names: the later one
}

// One list from every box's answer: a record once (the first box that has it; totals added up), in the query's order,
// cut to its limit.
export function mergeRows(parts: Row[][], order: string, desc: boolean, limit: number, coll = ""): Row[] {
  const byId = new Map<string, Row>();
  for (const part of parts) {
    for (const r of part) {
      const had = byId.get(r.id);
      if (!had) byId.set(r.id, r);
      else if (SUMMED.has(coll)) byId.set(r.id, { id: r.id, data: addUp(had.data, r.data) as Record<string, unknown> });
    }
  }
  let rows = [...byId.values()];
  if (order) {
    rows.sort((a, b) => {
      const c = cmp(fieldOf(a.data, order), fieldOf(b.data, order)) || cmp(a.id, b.id);
      return desc ? -c : c;
    });
  }
  return limit ? rows.slice(0, limit) : rows;
}

// Settings every box needs: written to all of them.
export const EVERY_BOX = new Set(["meta", "pushSubs"]);

// Where one write goes: a box's url; "all": every box; "any": the box is not known, every box is asked.
// - a record a box gave: that box;
// - a new record with `machine`: the box of that name;
// - a record of a plan (planId in it, or an id that starts with the plan's id): the box that holds the plan;
// - an update or delete of a record nobody has shown: "any";
// - a new record with nothing to go by: the first box.
export function targetOf(w: Write, owners: Map<string, string>, boxes: { name: string; url: string }[]): string | "all" | "any" {
  const [coll, id] = w.path.split("/");
  if (EVERY_BOX.has(coll)) return "all";
  const own = owners.get(w.path);
  if (own) return own;
  const data = w.op === "set" ? w.data : w.op === "update" ? w.fields : {};
  const machine = typeof data.machine === "string" ? boxes.find((b) => b.name === data.machine) : undefined;
  if (machine) return machine.url;
  const planId = typeof data.planId === "string" ? data.planId : id.includes("_") ? id.slice(0, id.indexOf("_")) : coll.startsWith("plan") ? id : "";
  const planBox = planId ? owners.get(`plans/${planId}`) : undefined;
  if (planBox) return planBox;
  if (w.op !== "set") return "any";
  return boxes[0]?.url ?? "any";
}
