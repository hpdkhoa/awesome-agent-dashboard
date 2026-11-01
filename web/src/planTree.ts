// The plan as a tree (the owner's words, 2026-11-01: "the best is can show the tree or graph of each choice, not only
// linear show version"): versions with their parents, the round of questions asked on each version, and the steps.
import type { Decision, InboxItem, Plan, PlanVersion } from "./data";

// A version's parent: the stored one, else the version before it (versions saved before branching).
export const parentOf = (v: PlanVersion) => (v.parent !== undefined ? v.parent : v.n - 1);

export type Laid = { v: PlanVersion; depth: number; lane: number };

// Depth left to right; the first child goes on in its parent's lane, each other child opens a new lane below.
export function layout(versions: PlanVersion[]): { nodes: Laid[]; lanes: number } {
  const kids = new Map<number, PlanVersion[]>();
  for (const v of [...versions].sort((a, b) => a.n - b.n)) kids.set(parentOf(v), [...(kids.get(parentOf(v)) ?? []), v]);
  const nodes: Laid[] = [];
  let lanes = 0;
  const walk = (parent: number, depth: number, lane: number) => {
    (kids.get(parent) ?? []).forEach((v, i) => {
      const l = i === 0 ? lane : lanes++;
      nodes.push({ v, depth, lane: l });
      walk(v.n, depth + 1, l);
    });
  };
  lanes = 1;
  walk(0, 0, 0);
  return { nodes, lanes };
}

// The chosen line: the chosen version (else the newest) and its parents back to v1.
export function chosenLine(plan: Plan, versions: PlanVersion[]): Set<number> {
  const byN = new Map(versions.map((v) => [v.n, v]));
  const line = new Set<number>();
  for (let n = plan.chosen ?? plan.current; n > 0 && byN.has(n) && !line.has(n); n = parentOf(byN.get(n)!)) line.add(n);
  return line;
}

// Lines added and removed from a to b (longest common subsequence over lines).
export function lineDiff(a: string, b: string): { op: "same" | "add" | "del"; line: string }[] {
  const x = a.split("\n"), y = b.split("\n");
  const m = x.length, n = y.length;
  const t = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const out: { op: "same" | "add" | "del"; line: string }[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (x[i] === y[j]) out.push({ op: "same", line: x[i++] }), j++;
    else if (t[i + 1][j] >= t[i][j + 1]) out.push({ op: "del", line: x[i++] });
    else out.push({ op: "add", line: y[j++] });
  }
  while (i < m) out.push({ op: "del", line: x[i++] });
  while (j < n) out.push({ op: "add", line: y[j++] });
  return out;
}

export const diffCount = (a: string, b: string) => {
  const d = lineDiff(a, b);
  return { add: d.filter((l) => l.op === "add").length, del: d.filter((l) => l.op === "del").length };
};

// A step (the owner's answer, 2026-11-01, "correct"): the round of questions asked on one version, and the version
// those answers made. Only your answers show; the session's work (the version's note and lines) shows on hover.
export type Step = { round: number; answers: Decision[]; waiting: number; made?: PlanVersion; add: number; del: number };

export function steps(plan: Plan, versions: PlanVersion[], items: InboxItem[]): Step[] {
  const byN = new Map(versions.map((v) => [v.n, v]));
  const line = chosenLine(plan, versions);
  const rounds = [...new Set(items.filter((i) => i.planId === plan.id).map((i) => i.round ?? 0))].sort((a, b) => a - b);
  return rounds.map((round) => {
    const qs = items.filter((i) => i.planId === plan.id && (i.round ?? 0) === round);
    // the version this round made: the child on the chosen line, else the newest child
    const kids = versions.filter((v) => parentOf(v) === round).sort((a, b) => b.n - a.n);
    const made = kids.find((v) => line.has(v.n)) ?? kids[0];
    const { add, del } = made ? diffCount(byN.get(round)?.text ?? "", made.text) : { add: 0, del: 0 };
    // the answers as they were when the version was made; before that, the answers so far
    const answers = made?.madeBy ?? qs.filter((q) => q.answer).map((q) => ({ id: q.id, title: q.title, choice: q.answer!.choice, text: q.answer!.text }));
    return { round, answers, waiting: qs.filter((q) => q.status === "open").length, made, add, del };
  });
}

// An answer as one short chip: the choice, and the note cut to 6 words (the owner's words: "least verbose").
export function chip(d: Decision): string {
  const words = (d.text ?? "").split(/\s+/).filter(Boolean);
  const note = words.slice(0, 6).join(" ") + (words.length > 6 ? "…" : "");
  return [d.choice, note].filter(Boolean).join(": ") || "answered";
}
