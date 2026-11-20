// One way to show text to the owner, on the page (Markdown.tsx) and in hayaku (avatar/fb/entry.js): markdown with its
// tables, pictures and safe HTML rendered, and every drawing shown as a picture (the owner, 2026-11-20: "improve this
// to be markdown preview and show images, tables when display to user, and check all places to make sure not display
// <svg> or raw text without render again").
// A drawing (an inline <svg>...</svg>, or a ```svg fence) becomes an <img> of a data: URL, so nothing in it can run.
// Other raw HTML goes through rehype-sanitize (GitHub's list: tables, details, b, br, ...; never script, style or on*).
import { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";

export type Piece = { md: string } | { svg: string };

const DRAWING = /```svg[^\n]*\n([\s\S]*?)```|(<svg[\s>][\s\S]*?<\/svg>)/gi;

// The text cut into markdown and drawings, in order. An <svg> inside a code span or a non-svg code fence stays code.
export function splitDrawings(text: string): Piece[] {
  const out: Piece[] = [];
  let at = 0;
  const fences = codeRanges(text);
  for (const m of text.matchAll(DRAWING)) {
    const i = m.index ?? 0;
    if (!m[1] && fences.some(([a, b]) => i >= a && i < b)) continue;
    if (i > at) out.push({ md: text.slice(at, i) });
    out.push({ svg: (m[1] ?? m[2]).trim() });
    at = i + m[0].length;
  }
  if (at < text.length) out.push({ md: text.slice(at) });
  return out.filter((p) => !("md" in p) || p.md.trim());
}

// Code fences (not ```svg) and inline code spans, where an <svg> is shown as code on purpose.
function codeRanges(text: string): [number, number][] {
  const r: [number, number][] = [];
  for (const m of text.matchAll(/```(?!svg)[^\n]*\n[\s\S]*?```|`[^`\n]+`/gi)) r.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  return r;
}

export const svgSrc = (svg: string) =>
  "data:image/svg+xml;charset=utf-8," + encodeURIComponent(/xmlns=/.test(svg) ? svg : svg.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"'));

// GitHub's safe list, plus links and pictures to a PC path: "K:\x.png" reads as the protocol "k", so each drive letter
// and file: are allowed; javascript:, data: and the like stay out.
const DRIVES = [..."abcdefghijklmnopqrstuvwxyz", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"]; // the check is case-sensitive
const base = defaultSchema.protocols ?? {};
export const SANITIZE: SanitizeSchema = {
  ...defaultSchema,
  protocols: { ...base, href: [...(base.href ?? []), "file", ...DRIVES], src: [...(base.src ?? []), "file", ...DRIVES] },
};
