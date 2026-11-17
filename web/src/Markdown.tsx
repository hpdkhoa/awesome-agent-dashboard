import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { isLocal, LocalImg, looksLikeFile, openFile } from "./FileView";

// Prompts, replies and inbox text are markdown. Raw HTML in them is not rendered (react-markdown's default), and links
// open in a new tab. With the folder the text was written in (cwd), a link, an image or a `path` that points at a file
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

export function Md({ text, className = "", cwd }: { text?: string | null; className?: string; cwd?: string }) {
  if (!text) return <p className="muted small">none</p>;
  return (
    <div className={"md " + className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // react-markdown blanks a link with an unknown protocol, and "K:\x" or "file:" reads as one: the blank href
        // reloaded the page on a phone (the owner, 2026-11-17: "everytime I click it then the page on mobile phone
        // reload and lost"). A PC path is kept for the file viewer; every other link is cleaned as before.
        // micromark writes "K:\x" as "K:%5Cx", so the path is read back before the check.
        urlTransform={(u) => (cwd !== undefined && isLocal(unescape(u)) ? unescape(u) : defaultUrlTransform(u))}
        components={{
          a: ({ href, children }) =>
            cwd !== undefined && isLocal(href) ? (
              <a href="#" className="file-link" onClick={(e) => (e.preventDefault(), openFile(href!, cwd))}>
                {children}
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
              <code className="file-link" role="button" onClick={() => openFile(s, cwd)}>
                {children}
              </code>
            ) : (
              <code className={c}>{children}</code>
            );
          },
        }}
      >
        {cwd !== undefined ? slashPaths(text) : text}
      </ReactMarkdown>
    </div>
  );
}
