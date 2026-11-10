import { useEffect, useState } from "react";
import { askAbout, quoteWords } from "./quote";

// Select words anywhere on the dashboard: a small "Ask about this" button appears at the selection and quotes just them
// into the message box of what the words belong to (the owner's words, 2026-11-10: "The cite to ask feature need to
// apply dashboard wide, when in sessions and run then the cite will direct to the message box"). The nearest
// data-quote-plan or data-quote-session above the words names the box; inside a plan, data-step and data-part name
// where the reply shows. Words with neither above them get no button.
type At = { x: number; y: number; text: string; planId?: string; sessionId?: string; stepId?: string; part?: string };

export function SelectAsk({ root }: { root: React.RefObject<HTMLElement | null> }) {
  const [at, setAt] = useState<At | null>(null);
  useEffect(() => {
    const look = () => {
      const sel = document.getSelection();
      const text = sel?.toString().trim() ?? "";
      if (!sel || !text || sel.rangeCount === 0 || !root.current) return setAt(null);
      const range = sel.getRangeAt(0);
      const node = range.commonAncestorContainer;
      const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
      if (!el || !root.current.contains(el) || el.closest("textarea, input, select, .on-msgs, .float-ask")) return setAt(null);
      const target = el.closest<HTMLElement>("[data-quote-plan],[data-quote-session]");
      if (!target) return setAt(null);
      const rect = range.getBoundingClientRect();
      const host = el.closest<HTMLElement>("[data-step],[data-part]");
      const planId = target.dataset.quotePlan || undefined;
      setAt({ x: rect.left + rect.width / 2, y: Math.max(8, rect.top - 34), text, planId,
        sessionId: planId ? undefined : target.dataset.quoteSession || undefined,
        stepId: planId ? host?.dataset.step : undefined, part: planId ? host?.dataset.part : undefined });
    };
    document.addEventListener("selectionchange", look);
    document.addEventListener("mouseup", look);
    window.addEventListener("scroll", look, true);
    return () => {
      document.removeEventListener("selectionchange", look);
      document.removeEventListener("mouseup", look);
      window.removeEventListener("scroll", look, true);
    };
  }, [root]);
  if (!at) return null;
  return (
    <button
      className="float-ask"
      style={{ left: at.x, top: at.y }}
      title={at.planId ? "Quote these words in the plan's message box (Q&A)" : "Quote these words in the session's message box"}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        askAbout({ text: quoteWords(at.text), ...(at.planId ? { kind: "qa" as const } : {}), planId: at.planId,
          sessionId: at.sessionId, stepId: at.stepId, part: at.part });
        document.getSelection()?.removeAllRanges();
        setAt(null);
      }}
    >
      Ask about this
    </button>
  );
}
