// hayaku's text view (the owner, 2026-11-20: "improve this to be markdown preview and show images, tables when display
// to user, and check all places to make sure not display <svg> or raw text without render again"). The same rules as
// the page (web/src/richText.ts): markdown with GFM tables, safe HTML through rehype-sanitize, every drawing (<svg> or
// a ```svg fence) as an <img> of a data: URL. Links never move the hayaku window: each one becomes a FILES entry the
// app opens (web in the browser, a picture or text here); a picture on the PC is read from its box like any picture.
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import { SANITIZE, splitDrawings, svgSrc } from "../../web/src/richText.ts";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ref(url, isWeb) -> the app's FILES index for that link or picture (app.js nRef); null: shown as plain text
function hooks(ref) {
  return () => (tree) => {
    const walk = (n) => {
      if (n.type === "element") {
        const p = n.properties || {};
        if (n.tagName === "a") {
          const href = String(p.href || "");
          delete p.href;
          const web = /^https?:\/\//i.test(href);
          const f = href && !href.startsWith("#") && !/^(javascript|data|vbscript):/i.test(href) ? ref(href.replace(/^file:\/+/i, ""), web) : null;
          if (f != null) Object.assign(p, { dataAct: "file", dataF: String(f), className: ["mdlink"], title: href });
        } else if (n.tagName === "img") {
          const src = String(p.src || "");
          delete p.src;
          const f = src && !/^(https?|data|javascript):/i.test(src) ? ref(src.replace(/^file:\/+/i, ""), false) : null;
          if (f != null) Object.assign(p, { dataAct: "full", dataF: String(f), dataPic: String(f), title: src });
          else Object.assign(p, { alt: `${p.alt || "picture"} (${src})` });
        }
        n.properties = p;
      }
      for (const c of n.children || []) walk(c);
    };
    walk(tree);
  };
}

// The text as safe HTML for innerHTML. line: inside a line (an option's detail), paragraphs as spans.
export function mdHtml(text, ref, line = false) {
  const s = String(text ?? "");
  if (!s.trim()) return "";
  const run = unified().use(remarkParse).use(remarkGfm).use(remarkRehype, { allowDangerousHtml: true }).use(rehypeRaw)
    .use(rehypeSanitize, SANITIZE).use(hooks(ref)).use(rehypeStringify);
  let h = splitDrawings(s).map((p) => ("svg" in p ? `<img class="md-drawing" alt="drawing" src="${esc(svgSrc(p.svg))}">`
    : String(run.processSync(p.md.replace(/\]\((<?)([a-zA-Z]:\\[^)>\n]*)(>?)\)/g, (_m, a, q, b) => `](${a}${q.replace(/\\/g, "/")}${b})`))))).join("");
  if (line) h = h.replace(/<p>/g, "<span>").replace(/<\/p>/g, "</span>");
  return `<${line ? "span" : "div"} class="md${line ? " md-line" : ""}">${h}</${line ? "span" : "div"}>`;
}
