// The six parts of a plan as lines, a line diff between two plan versions, and links from #n to the page that holds
// log entry n (plan from a session, the owner's words 2026-11-03 in cc/dashboard/SESSION_PLAN.md).
import type { Parts, Plan } from "./data";

export const PART_NAMES: [keyof Parts, string][] = [
  ["goal", "1. Goal"], ["summary", "2. Summary"], ["rules", "3. Rules"], ["lessons", "4. Lessons"],
  ["leftover", "5. Leftover"], ["steps", "6. Steps"],
];

export function partLines(parts: Parts, k: keyof Parts): string[] {
  switch (k) {
    case "goal":
    case "summary":
      return parts[k].split("\n").filter((l) => l.trim());
    case "rules":
      return parts.rules.map((r) => `${r.rule} (${r.source})`);
    case "lessons":
      return parts.lessons.map((l) => `${l.lesson} · taught by ${l.taughtBy} · applied in ${l.appliedIn}`);
    case "leftover":
      return parts.leftover;
    case "steps":
      return parts.steps.map((s) => `${s.id} ${s.title}: ${s.does} · check: ${s.check}`);
  }
}

export type DiffLine = { op: "same" | "add" | "del"; text: string };

// Longest common subsequence over lines: what was removed and added, in order.
export function diffLines(a: string[], b: string[]): DiffLine[] {
  const m = a.length, n = b.length;
  const t = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) (out.push({ op: "same", text: a[i] }), i++, j++);
    else if (t[i + 1][j] >= t[i][j + 1]) out.push({ op: "del", text: a[i++] });
    else out.push({ op: "add", text: b[j++] });
  }
  while (i < m) out.push({ op: "del", text: a[i++] });
  while (j < n) out.push({ op: "add", text: b[j++] });
  return out;
}

// "#123" becomes a link to the page file that holds entry 123, which opens in the file viewer.
export function linkEntries(text: string, plan: Plan): string {
  const src = plan.source;
  if (!src?.pages?.length) return text;
  const dir = src.pagesDir.replace(/\\/g, "/");
  return text.replace(/(^|[\s(])#(\d+)\b/g, (all, pre: string, num: string) => {
    const n = Number(num);
    const page = src.pages.find((p) => p.first <= n && n <= p.last);
    return page ? `${pre}[#${num}](<${dir}/${page.file}>)` : all;
  });
}
