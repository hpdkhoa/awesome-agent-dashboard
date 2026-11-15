import { createContext, useContext, useState, type ReactNode } from "react";
import { getSettings } from "./prefs";

const KEY = "aad.sections";

function remembered(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
}

// Inside a plan page every section, card and step starts folded, whatever this browser remembered or the Settings tab
// says (the owner's words, 2026-11-15: "make sure every section every card every step every category got the collapsed
// as default and I'll open them manually"; the pick: "Fold all, always").
export const FoldAll = createContext(false);

// A section with a header that collapses and expands it. The open or closed state of each section id is remembered
// in this browser, so the page opens the way it was left.
export function Section({
  id,
  title,
  extra,
  open = true,
  tools,
  stale,
  main,
  children,
}: {
  id: string;
  title: ReactNode;
  extra?: ReactNode;
  open?: boolean;
  tools?: ReactNode; // beside the header, outside its button (a button cannot hold another)
  stale?: string; // the plan's update check: why this section is behind the current version (planStale.ts)
  // open on every load, over fold-all, the remembered state and Settings (the owner's pick, 2026-11-16, for the plan's
  // Report board: "Board open, rest folded")
  main?: boolean;
  children: ReactNode;
}) {
  // a section this browser never folded or opened starts as the Settings tab says (Sections start: Open or Folded)
  const foldAll = useContext(FoldAll);
  const [isOpen, setOpen] = useState<boolean>(() => (main ? true : foldAll ? false : remembered()[id] ?? (getSettings().foldDefault ? false : open)));

  function toggle() {
    const next = !isOpen;
    setOpen(next);
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...remembered(), [id]: next }));
    } catch {
      // private window or blocked storage: the section still toggles, it just is not remembered
    }
  }

  return (
    <section className={(isOpen ? "sec open" : "sec") + (stale ? " stale" : "")} title={stale}>
      <div className="sec-wrap">
        <button className="sec-head" onClick={toggle} aria-expanded={isOpen}>
          <span className="chev" aria-hidden="true">
            ▸
          </span>
          <span className="sec-title">{title}</span>
          {extra && <span className="sec-extra">{extra}</span>}
          {stale && <span className="stale-note">{stale}</span>}
        </button>
        {tools}
      </div>
      {isOpen && <div className="sec-body">{children}</div>}
    </section>
  );
}
