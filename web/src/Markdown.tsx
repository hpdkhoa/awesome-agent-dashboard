import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { isLocal, LocalImg, looksLikeFile, openFile } from "./FileView";

// Prompts, replies and inbox text are markdown. Raw HTML in them is not rendered (react-markdown's default), and links
// open in a new tab. With the folder the text was written in (cwd), a link, an image or a `path` that points at a file
// on the PC opens in the file viewer (FileView.tsx).
export function Md({ text, className = "", cwd }: { text?: string | null; className?: string; cwd?: string }) {
  if (!text) return <p className="muted small">none</p>;
  return (
    <div className={"md " + className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) =>
            cwd !== undefined && isLocal(href) ? (
              <a href="#" className="file-link" onClick={(e) => (e.preventDefault(), openFile(href!, cwd))}>
                {children}
              </a>
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
        {text}
      </ReactMarkdown>
    </div>
  );
}
