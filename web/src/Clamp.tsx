import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

// A long text shown to its first lines, then "Show more" (the owner's pick, 2026-11-12, "Both": fold to the header,
// and inside an open one clamp to 4 lines). The link shows only when the text is really longer than the clamp; a
// text loaded later (a reply read from the PC) is measured again when its size changes.
export function Clamp({ lines = 4, children }: { lines?: number; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const check = () => setLong(el.scrollHeight > el.clientHeight + 2);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    const mo = new MutationObserver(check); // a reply read from the PC replaces "loading" later
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => (ro.disconnect(), mo.disconnect());
  }, [more]);
  return (
    <div className="clamp-wrap">
      <div ref={box} className={more ? "clamp open" : "clamp"} style={more ? undefined : { maxHeight: `${lines * 1.8}em` }}>
        {children}
      </div>
      {(long || more) && (
        <button className="link small" onClick={() => setMore(!more)}>{more ? "Show less" : "Show more"}</button>
      )}
    </div>
  );
}
