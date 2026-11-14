import { useState, type ReactNode } from "react";
import { getSettings } from "./prefs";

const KEY = "aad.sections";

function remembered(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
}

// A section with a header that collapses and expands it. The open or closed state of each section id is remembered
// in this browser, so the page opens the way it was left.
export function Section({
  id,
  title,
  extra,
  open = true,
  tools,
  stale,
  children,
}: {
  id: string;
  title: ReactNode;
  extra?: ReactNode;
  open?: boolean;
  tools?: ReactNode; // beside the header, outside its button (a button cannot hold another)
  stale?: string; // the plan's update check: why this section is behind the current version (planStale.ts)
  children: ReactNode;
}) {
  // a section this browser never folded or opened starts as the Settings tab says (Sections start: Open or Folded)
  const [isOpen, setOpen] = useState<boolean>(() => remembered()[id] ?? (getSettings().foldDefault ? false : open));

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
