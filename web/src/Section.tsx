import { useState, type ReactNode } from "react";

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
  children,
}: {
  id: string;
  title: ReactNode;
  extra?: ReactNode;
  open?: boolean;
  children: ReactNode;
}) {
  const [isOpen, setOpen] = useState<boolean>(() => remembered()[id] ?? open);

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
    <section className={isOpen ? "sec open" : "sec"}>
      <button className="sec-head" onClick={toggle} aria-expanded={isOpen}>
        <span className="chev" aria-hidden="true">
          ▸
        </span>
        <span className="sec-title">{title}</span>
        {extra && <span className="sec-extra">{extra}</span>}
      </button>
      {isOpen && <div className="sec-body">{children}</div>}
    </section>
  );
}
