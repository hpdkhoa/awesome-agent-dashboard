// The harness (the owner's words, 2026-11-04: "I need the list as a section in the plan so I can review and see the
// diff everytime the plan change what harness will be change, and at last I'll need to approve every single harness
// item"; the owner's choice "Small approvals record"; "UI will need to render the checkbox for me to tick it"). The
// list rides on each plan version; the ticks live in one small record, planHarness/<plan id>. A tick holds a hash of
// the item, so an item whose text changes in a later version shows unticked until the owner approves it again.
export type HarnessItem = { id: string; item: string; kind: "tool" | "check" };
export type Tick = { ok: boolean; at: string; hash: string; v: number };
export type HarnessTicks = { planId: string; items: Record<string, Tick> };

// FNV-1a, 32 bits: enough to tell that an item's text changed; not a security check.
export function itemHash(h: HarnessItem): string {
  let x = 0x811c9dc5;
  for (const c of `${h.kind}:${h.item}`) {
    x ^= c.codePointAt(0)!;
    x = Math.imul(x, 0x01000193) >>> 0;
  }
  return x.toString(16).padStart(8, "0");
}

// Step i8: a step's check command is ticked the same way; the tick holds this hash (bridge stepcheck.py check_hash).
export const checkHash = (command: string) => itemHash({ id: "", kind: "check", item: command });

export const approved = (h: HarnessItem, ticks?: HarnessTicks | null) => {
  const t = ticks?.items?.[h.id];
  return !!t?.ok && t.hash === itemHash(h);
};

export const harnessLine = (h: HarnessItem) => `${h.id} [${h.kind}] ${h.item}`;

export function harnessCount(list: HarnessItem[], ticks?: HarnessTicks | null) {
  return { done: list.filter((h) => approved(h, ticks)).length, all: list.length };
}

// What Run step tells the session (the owner's words, 2026-11-04: "the unticked item won't be used or added into build
// phase"): only the approved items go into the work.
export function buildNote(list: HarnessItem[] | undefined, ticks?: HarnessTicks | null): string {
  if (!list?.length) return "";
  const ok = list.filter((h) => approved(h, ticks)).map((h) => h.id);
  const left = list.filter((h) => !ok.includes(h.id)).map((h) => h.id);
  return ` Use only the approved harness items: ${ok.join(", ") || "none"}.` + (left.length ? ` Not approved, left out: ${left.join(", ")}.` : "");
}
