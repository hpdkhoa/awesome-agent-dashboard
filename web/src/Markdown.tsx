import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { SANITIZE, splitDrawings, svgSrc } from "./richText";
import { fileName, isLocal, LocalImg, looksLikeFile, openFile } from "./FileView";

// Prompts, replies and inbox text are markdown. Safe raw HTML in them renders (tables, details, b, br; rehype-sanitize),
// a drawing (<svg> or a ```svg fence) shows as a picture (richText.ts, the owner 2026-11-20: "make sure not display
// <svg> or raw text without render again"), and links open in a new tab. With the folder the text was written in (cwd), a link, an image or a `path` that points at a file
// on the PC opens in the file viewer (FileView.tsx).
const unescape = (u: string) => {
  try {
    return decodeURI(u).replace(/%5C/gi, "\\");
  } catch {
    return u;
  }
};

// In markdown "\." is an escape, so a link to "K:\cc\.plan_data\x.png" reached the bridge as "K:\cc.plan_data\x.png"
// (the owner, 2026-11-17: "outside WORK_ROOTS"). A link or picture to a Windows path gets / before it is read.
export const slashPaths = (t: string) =>
  t.replace(/\]\((<?)([a-zA-Z]:\\[^)>\n]*)(>?)\)/g, (_m, a: string, p: string, b: string) => `](${a}${p.replace(/\\/g, "/")}${b})`);

// line: a short text inside a line (an option's detail, a note): rendered the same, its paragraphs as spans, so it sits
// in the line and shows nothing when empty.
export function Md({ text, className = "", cwd, line }: { text?: string | null; className?: string; cwd?: string; line?: boolean }) {
  if (!text) return line ? null : <p className="muted small">none</p>;
  const Box = line ? "span" : "div";
  return (
    <Box className={(line ? "md md-line " : "md ") + className}>
      {splitDrawings(text).map((p, i) =>
        "svg" in p ? (
          <img key={i} className="md-drawing" alt="drawing" src={svgSrc(p.svg)} />
        ) : (
          <MdPiece key={i} text={p.md} cwd={cwd} line={line} />
        ),
      )}
    </Box>
  );
}

function MdPiece({ text, cwd, line }: { text: string; cwd?: string; line?: boolean }) {
  return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, SANITIZE]]}
        // react-markdown blanks a link with an unknown protocol, and "K:\x" or "file:" reads as one: the blank href
        // reloaded the page on a phone (the owner, 2026-11-17: "everytime I click it then the page on mobile phone
        // reload and lost"). A PC path is kept for the file viewer; every other link is cleaned as before.
        // micromark writes "K:\x" as "K:%5Cx", so the path is read back before the check.
        urlTransform={(u) => (cwd !== undefined && isLocal(unescape(u)) ? unescape(u) : defaultUrlTransform(u))}
        components={{
          ...(line ? { p: ({ children }) => <span>{children}</span> } : {}),
          a: ({ href, children }) =>
            cwd !== undefined && isLocal(href) ? (
              <a href="#" className="file-link" title={href} onClick={(e) => (e.preventDefault(), openFile(href!, cwd))}>
                {String(children) === href ? fileName(href!) : children}
              </a>
            ) : !href ? (
              <span>{children}</span>
            ) : (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ),
          img: ({ src, alt }) =>
            cwd !== undefined && typeof src === "string" && isLocal(src) ? <LocalImg src={src} alt={alt} cwd={cwd} /> : <img src={src as string} alt={alt} />,
          code: ({ className: c, children }) => {
            const s = String(children ?? "");
            return cwd !== undefined && !c && looksLikeFile(s) ? (
              <code className="file-link" role="button" title={s} onClick={() => openFile(s, cwd)}>
                {fileName(s)}
              </code>
            ) : (
              <code className={c}>{children}</code>
            );
          },
        }}
      >
        {cwd !== undefined ? slashPaths(text) : text}
      </ReactMarkdown>
  );
}
