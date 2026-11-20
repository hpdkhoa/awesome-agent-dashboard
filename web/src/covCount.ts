// No-data-lost check on the report board (plan 44fc4979 s4). The owner's picks: round 1 "Coverage bar + missing list"
// ("Count source items (goal lines, rules, decisions, step results, notes) vs items the board covers; list the
// missing"); 2026-11-20 "Reachable through a chip" (an item is covered when a chip on the board opens text that holds
// it), "Chip targets only" (project files are where chips point; their lines are not counted as items), "Board header +
// list under bar".
//
// Items (the truth sources, s3 "both a and c"): every goal line, rule, lesson and leftover item of the plan; every step
// report that exists; every KB record whose plan field is this plan; every feedback log row that names this plan.
// Reachable: a part chip (goal, rules, lessons, leftover) opens its whole part; a step chip opens that step's report; a
// record chip opens that record; a whole-file chip opens every row of the file; path#"words" opens the row holding the
// words; path:N opens line N.

export type CovItem = { label: string; covered: boolean; chip: string };
export type CovGroup = { source: string; items: CovItem[] };
export type LogRow = { path: string; line: number; text: string };
export type CovInput = {
  boardIds: string[];
  goal: string; rules: string[]; lessons: string[]; leftover: string[];
  reports: { id: string; title: string }[];
  records: { id: string; title: string }[];
  logRows: LogRow[];
};

const FILE = /^(?<path>[A-Za-z]:[\\/][^#]+?)(?::(?<line>\d+)|#(?<quote>.+))?$/;
const norm = (p: string) => p.replace(/\//g, "\\").toLowerCase();

export const LOG_NAME = /OWNER_FEEDBACK\.md$/i;
// a feedback log row: a table row that starts with a date
export const isLogRow = (l: string) => /^\|\s*20\d\d-\d\d-\d\d\s*\|/.test(l);

export function coverage(c: CovInput): CovGroup[] {
  const ids = new Set(c.boardIds);
  const files = c.boardIds.map((id) => FILE.exec(id)?.groups).filter(Boolean) as { path: string; line?: string; quote?: string }[];
  const rowCovered = (r: LogRow) => files.some((f) => norm(f.path) === norm(r.path) && (
    (!f.line && !f.quote) || (f.line && +f.line === r.line) || (f.quote && r.text.includes(f.quote.trim().replace(/^"|"$/g, "").trim()))));
  const part = (name: string, list: string[]) => list.map((t) => ({ label: t, covered: ids.has(name), chip: name }));
  const goalLines = c.goal.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return [
    { source: "goal lines", items: part("goal", goalLines) },
    { source: "rules", items: part("rules", c.rules) },
    { source: "lessons", items: part("lessons", c.lessons) },
    { source: "leftover", items: part("leftover", c.leftover) },
    { source: "step reports", items: c.reports.map((r) => ({ label: `${r.id} ${r.title}`, covered: ids.has(r.id) || ids.has("step:" + r.id), chip: r.id })) },
    { source: "KB records", items: c.records.map((r) => ({ label: `${r.id} ${r.title}`, covered: ids.has(r.id), chip: r.id })) },
    { source: "feedback log rows", items: c.logRows.map((r) => ({ label: r.text.split("|").filter((x) => x.trim())[1]?.trim() ?? r.text, covered: rowCovered(r), chip: `${r.path}:${r.line}` })) },
  ];
}

export type CovStats = {
  total: number; covered: number; missing: number; pct: number; sources: number;
  lowest?: { source: string; pct: number }; highest?: { source: string; pct: number }; meanPct: number;
};

export function covStats(groups: CovGroup[]): CovStats {
  const used = groups.filter((g) => g.items.length);
  const pctOf = (g: CovGroup) => Math.round((100 * g.items.filter((i) => i.covered).length) / g.items.length);
  const total = used.reduce((n, g) => n + g.items.length, 0);
  const covered = used.reduce((n, g) => n + g.items.filter((i) => i.covered).length, 0);
  const sorted = [...used].sort((a, b) => pctOf(a) - pctOf(b));
  return {
    total, covered, missing: total - covered, pct: total ? Math.round((100 * covered) / total) : 100, sources: used.length,
    lowest: sorted[0] && { source: sorted[0].source, pct: pctOf(sorted[0]) },
    highest: sorted.length ? { source: sorted[sorted.length - 1].source, pct: pctOf(sorted[sorted.length - 1]) } : undefined,
    meanPct: used.length ? Math.round(used.reduce((n, g) => n + pctOf(g), 0) / used.length) : 100,
  };
}

// the first full sentence of a text: up to the first ". ", "! " or "? " (a dot inside "3.1" is not an end), else the
// first line whole; never cut mid-word (rule B8)
export function firstSentence(text: string): string {
  const line = text.trim().split(/\r?\n/)[0] ?? "";
  const m = /^(.+?[.!?])(\s|$)/.exec(line);
  return (m ? m[1] : line).trim();
}
