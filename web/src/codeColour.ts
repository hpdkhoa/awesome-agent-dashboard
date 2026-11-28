// Colours for a quoted piece of code on a review card (the owner, 2026-11-29: pick "B: chips + status pill", note
// "use b and c together": the Quote code coloured by kind). Four kinds, as in the preview the owner picked: keyword,
// string, comment, function name; the rest stays plain. The language comes from the file's extension; a file of
// another kind (markdown, text) stays plain. Returns tokens; the page renders them as text (never as HTML).

export type Tok = { t: string; k?: "k" | "s" | "c" | "f" };

const PY = "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield";
const JS = "as async await break case catch class const continue default delete do else export extends false finally for from function if import in instanceof let new null of return switch this throw true try type typeof undefined var void while yield interface enum";
const RS = "as break const continue crate else enum false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while";
const GO = "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false";
const SH = "if then else elif fi for while do done case esac function in return local export echo";

type Lang = { kw: Set<string>; line: string[]; block: boolean };
const lang = (kw: string, line: string[], block: boolean): Lang => ({ kw: new Set(kw.split(" ")), line, block });
const LANGS: Record<string, Lang> = {
  py: lang(PY, ["#"], false),
  ts: lang(JS, ["//"], true), tsx: lang(JS, ["//"], true), js: lang(JS, ["//"], true), jsx: lang(JS, ["//"], true),
  mjs: lang(JS, ["//"], true), css: lang("", [], true), rs: lang(RS, ["//"], true), go: lang(GO, ["//"], true),
  sh: lang(SH, ["#"], false), ps1: lang(SH, ["#"], false), toml: lang("true false", ["#"], false),
  yml: lang("true false null", ["#"], false), yaml: lang("true false null", ["#"], false),
};

export function langOf(file: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(file);
  return m && LANGS[m[1].toLowerCase()] ? m[1].toLowerCase() : "";
}

export function colourCode(text: string, file: string): Tok[] {
  const L = LANGS[langOf(file)];
  if (!L) return [{ t: text }];
  const out: Tok[] = [];
  const push = (t: string, k?: Tok["k"]) => {
    const last = out[out.length - 1];
    if (!k && last && !last.k) last.t += t;
    else out.push(k ? { t, k } : { t });
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const line = L.line.find((p) => rest.startsWith(p));
    if (line) {
      const end = text.indexOf("\n", i);
      const j = end < 0 ? text.length : end;
      push(text.slice(i, j), "c");
      i = j;
      continue;
    }
    if (L.block && rest.startsWith("/*")) {
      const end = text.indexOf("*/", i + 2);
      const j = end < 0 ? text.length : end + 2;
      push(text.slice(i, j), "c");
      i = j;
      continue;
    }
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch && !(text[j] === "\n" && ch !== "`")) j += text[j] === "\\" ? 2 : 1;
      j = Math.min(j + 1, text.length);
      push(text.slice(i, j), "s");
      i = j;
      continue;
    }
    const w = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (w) {
      const word = w[0];
      const after = text.slice(i + word.length).match(/^\s*\(/);
      push(word, L.kw.has(word) ? "k" : after ? "f" : undefined);
      i += word.length;
      continue;
    }
    push(ch);
    i += 1;
  }
  return out;
}
