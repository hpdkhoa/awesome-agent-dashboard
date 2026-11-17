// The board's Materials list (the owner's words, 2026-11-17: "Add material section in report board, in this section only
// keep the latest version of each file/material and stories"; picks "sửa web + bridge chọn session ghi", then "Cả hai":
// "Thêm tự gom từ báo cáo; file session chưa ghi hiện nhãn 'tự gom'"). The session's list (parts.board.materials) plus the
// files the plan's reports point to (step reports and replies, the newest evidence set of each step, the plan's results);
// one entry per file family (the name without its -vN), the newest version kept. Pure: no React, no store.
import type { InboxItem, Material, PlanStep, StepEvidence } from "./data";

export type BoardMaterial = Material & { auto?: boolean }; // auto: gathered from a report, the session did not list it

// the page's file-link rules (FileView.tsx isLocal, looksLikeFile; bridge filelinks.py file_refs)
const FENCE = /^(```|~~~).*?^\1/gms;
const LINK = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const CODE = /(?<!`)`([^`\n]+)`(?!`)/g;
const FILE_RE = /^[\w.\-\\/:~ ]+\.(png|jpe?g|gif|webp|svg|avif|html?|pdf|md|mp4|webm|mov|txt|log|json|csv|py|ts|tsx|go)(:\d+)?$/i;
const isLocal = (h: string) => !!h && !h.startsWith("#") && (/^[a-zA-Z]:[\\/]/.test(h) || h.startsWith("file:") || !/^[a-z][a-z0-9+.-]*:/i.test(h));
const looksLikeFile = (s: string) => FILE_RE.test(s) && /[\\/.]/.test(s);

export function fileRefs(text: string): string[] {
  const body = (text || "").replace(FENCE, "");
  const out: string[] = [];
  for (const m of body.matchAll(LINK)) if (isLocal(m[1]) && !out.includes(m[1])) out.push(m[1]);
  for (const m of body.matchAll(CODE)) if (looksLikeFile(m[1]) && !out.includes(m[1])) out.push(m[1]);
  return out;
}

const SEP = /[\\/]/;
const VER = /[-_. ]?v(\d+)(?=\.[^.\\/]+$|$)/i;
const isAbs = (p: string) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\");

// a full path: no file: prefix, no :line ending, a relative one read from cwd
export function fullPath(ref: string, cwd: string): string {
  let p = ref.trim().replace(/^file:\/*/i, "").replace(/:\d+$/, "");
  try { p = decodeURI(p); } catch { /* keep as written */ }
  if (!isAbs(p) && cwd) p = cwd.replace(/[\\/]+$/, "") + "\\" + p.replace(/^\.[\\/]/, "");
  return p.replace(/\//g, "\\");
}

// (family key, version): the folder and the file name without its -vN, and N (0 when none); bridge inbox.py material_family
export function family(m: { name: string; path?: string }): [string, number] {
  const parts = (m.path ?? "").split(SEP);
  const base = parts[parts.length - 1] || m.name;
  const hit = VER.exec(base);
  const key = hit ? base.slice(0, hit.index) + base.slice(hit.index + hit[0].length) : base;
  return [parts.slice(0, -1).join("/").toLowerCase() + "|" + key.toLowerCase().trim(), hit ? Number(hit[1]) : 0];
}

const strings = (x: unknown): string[] =>
  typeof x === "string" ? [x] : Array.isArray(x) ? x.flatMap(strings) : x && typeof x === "object" ? Object.values(x).flatMap(strings) : [];

// the files the plan's reports point to, full paths, once each, oldest report first
export function gathered(cwd: string, steps: PlanStep[], evidence: StepEvidence[], asked: InboxItem[]): string[] {
  const out: string[] = [];
  const add = (ref: string, from: string) => { const p = fullPath(ref, from); if (p && !out.some((x) => x.toLowerCase() === p.toLowerCase())) out.push(p); };
  for (const sv of steps) for (const v of sv.versions ?? []) for (const t of strings([v.reply, v.report])) fileRefs(t).forEach((r) => add(r, cwd));
  for (const e of evidence) (e.sets?.[0]?.pictures ?? []).forEach((p) => add(p, cwd));
  for (const it of [...asked].filter((x) => x.kind === "result").sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    (it.files ?? []).forEach((f) => add(f, it.cwd || cwd));
    fileRefs(it.text).forEach((r) => add(r, it.cwd || cwd));
  }
  return out;
}

// the session's list and the gathered files, one per family: the higher vN wins; the same N: the session's entry. A
// gathered file that wins over a session entry of its family keeps the session's kind and note.
export function boardMaterials(listed: Material[], found: string[]): BoardMaterial[] {
  const keep = new Map<string, { n: number; m: BoardMaterial }>();
  const put = (m: BoardMaterial) => {
    const [k, n] = family(m);
    const had = keep.get(k);
    if (!had) return void keep.set(k, { n, m });
    if (n > had.n) keep.set(k, { n, m: m.auto && !had.m.auto ? { ...m, kind: had.m.kind, note: had.m.note } : m });
    else if (n === had.n && !m.auto) keep.set(k, { n, m });
  };
  listed.forEach(put);
  found.forEach((p) => put({ name: p.split(SEP).pop() || p, path: p, kind: "file", auto: true }));
  return [...keep.values()].map((x) => x.m);
}
