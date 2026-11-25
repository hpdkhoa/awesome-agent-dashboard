import { useEffect, useState, type RefObject } from "react";

// The floating back-to-top button (the owner, 2026-11-25: "the dashboard need a floating back to top button so when use
// in mobile view I don't need to scroll too much"). On a phone the window scrolls; on a wide screen the main panel does:
// the button watches both, shows after one screen of scroll, and takes both back to the top.
export function BackToTop({ main }: { main: RefObject<HTMLElement | null> }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const el = main.current;
    const check = () => setShow(Math.max(window.scrollY, el?.scrollTop ?? 0) > window.innerHeight);
    window.addEventListener("scroll", check, { passive: true });
    el?.addEventListener("scroll", check, { passive: true });
    check();
    return () => { window.removeEventListener("scroll", check); el?.removeEventListener("scroll", check); };
  }, [main]);
  if (!show) return null;
  const top = () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
    main.current?.scrollTo({ top: 0, behavior: "smooth" });
  };
  return <button className="to-top" onClick={top} aria-label="Back to top" title="Back to top">↑</button>;
}
