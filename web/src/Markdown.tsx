import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Prompts, replies and inbox text are markdown. Raw HTML in them is not rendered (react-markdown's default), and links
// open in a new tab.
export function Md({ text, className = "" }: { text?: string | null; className?: string }) {
  if (!text) return <p className="muted small">none</p>;
  return (
    <div className={"md " + className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
