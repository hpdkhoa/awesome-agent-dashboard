// The run report card's fields (the owner's pick, 2026-11-15: "A + exact report fields"; the owner's words: "I want
// better report but not losing data"). A report made with the fields (bridge inbox.py clean_report) shows them as they
// are. An older report has only its free reply: each of its lines is placed in exactly one field by the rules below and
// the card says "read from the reply"; the reply stays whole beside it. Pure, so it is tested without a browser.
import type { StepReport } from "./data";

export type Item = { kind: "line"; text: string; sub: boolean } | { kind: "table"; rows: string[] };
export type Sorted = { built: Item[]; numbers: Item[]; tests: Item[]; pictures: Item[]; notDone: Item[]; notes: Item[] };
export type FieldKey = keyof Sorted;

export const NUM = /\d[\d.,:/%x×]*/g;
const MEASURE = /\d[\d.,]*\s*(%|ms\b|s\b|min\b|tok|tokens|MB|GB|KB|px|chars|reads|x\b|×)|\$\d|\d+\/\d+|\d+ of \d+/;
const TESTS = /\b(pass|passes|passed|fail|fails|failed|pytest|tests?|checks?|checked)\b/;
const NOT_DONE = /^(not done|question|open|still open|not tested|untested)/;

export function sortReply(reply: string): { fields: Sorted; lines: number } {
  const f: Sorted = { built: [], numbers: [], tests: [], pictures: [], notDone: [], notes: [] };
  const lines = reply.split(/\r?\n/).filter((l) => l.trim());
  let parent: FieldKey | null = null;
  for (let i = 0; i < lines.length; ) {
    const l = lines[i];
    if (l.trimStart().startsWith("|")) {
      const rows: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith("|")) rows.push(lines[i++]);
      f.numbers.push({ kind: "table", rows });
      continue;
    }
    const sub = l.length - l.trimStart().length > 0;
    const text = l.replace(/^\s*[-*]\s+/, "").trim();
    let k: FieldKey;
    if (!sub || !parent) {
      const low = text.toLowerCase();
      if (NOT_DONE.test(low)) k = "notDone";
      else if (TESTS.test(low)) k = "tests";
      else if (/\.png|\.jpg|\bpictures?\b/.test(low)) k = "pictures";
      else if (/^(built|added|new |made|fixed|changed)/.test(low)) k = "built";
      else if (MEASURE.test(text)) k = "numbers";
      else k = "built";
      parent = k;
    } else k = parent;
    f[k].push({ kind: "line", text, sub });
    i++;
  }
  return { fields: f, lines: lines.length };
}

// Lines placed (a table counts its rows) and the number tokens of the reply not found in the fields: the card's data
// check, so a reader sees nothing was dropped.
export function sortCheck(reply: string): { lines: number; placed: number; numbers: number; missing: string[] } {
  const { fields, lines } = sortReply(reply);
  const all = Object.values(fields).flat();
  const placed = all.reduce((n, it) => n + (it.kind === "table" ? it.rows.length : 1), 0);
  const text = all.map((it) => (it.kind === "table" ? it.rows.join(" ") : it.text)).join(" ");
  const inReply = reply.match(NUM) ?? [];
  const inCard = new Set(text.match(NUM) ?? []);
  return { lines, placed, numbers: inReply.length, missing: [...new Set(inReply.filter((n) => !inCard.has(n)))] };
}

const cut = (t: string, n = 90) => (t.length > n ? t.slice(0, n) + "…" : t);
const firstText = (items: Item[]) => {
  for (const it of items) {
    if (it.kind === "table") {
      const row = it.rows.find((r, i) => i > 1 && !/^\s*\|[\s:|-]+\|\s*$/.test(r));
      if (row) return row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).join(" · ");
      continue;
    }
    const t = it.text.replace(/^(Built|Done|Not done)[^:]{0,30}:\s*/i, "");
    if (t.trim()) return t;
  }
  return "";
};

// One board row's cells: from the fields when the report has them, else the first line of each sorted field.
export function boardCells(reply: string, report?: StepReport | null) {
  if (report && (report.numbers?.length || report.tests?.length || report.built?.length)) {
    const n = report.numbers?.[0];
    const t = report.tests?.[0];
    return {
      exact: true,
      built: cut(report.built?.[0] ?? ""),
      number: n ? cut(`${n.metric}: ${n.before ? n.before + " → " : ""}${n.after}`) : "",
      tested: t ? cut(`${t.method}: ${t.result}`) : "",
      open: report.not_done?.length ?? 0,
    };
  }
  const f = sortReply(reply).fields;
  return {
    exact: false, built: cut(firstText(f.built)), number: cut(firstText(f.numbers)), tested: cut(firstText(f.tests)),
    open: f.notDone.filter((it) => !(it.kind === "line" && /^(not done|open)[^:]*:?$/i.test(it.text))).length,
  };
}

// What is not done, as lines: from the fields, or the sorted Not done lines without their bare "Not done:" header.
export function openItems(reply: string, report?: StepReport | null): string[] {
  if (report?.not_done?.length) return report.not_done.map((r) => (r.fix ? `${r.item} → ${r.fix}` : r.item));
  if (report && (report.numbers?.length || report.tests?.length)) return [];
  return sortReply(reply).fields.notDone
    .filter((it): it is Extract<Item, { kind: "line" }> => it.kind === "line")
    .map((it) => it.text.replace(/^(not done|open)[^:]{0,20}:\s*/i, ""))
    .filter((t) => t.trim());
}
