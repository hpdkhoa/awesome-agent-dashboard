// The left and right panels: drag to resize, hide and show each (the owner's words, 2026-11-10: "I want the left and
// right panel can resize and hide each of panel"; the pick: "Drag handles and hide buttons"). Remembered in this browser.

export type Layout = { left: number; right: number; leftHidden: boolean; rightHidden: boolean };

export const DEFAULT_LAYOUT: Layout = { left: 320, right: 300, leftHidden: false, rightHidden: false };
export const MIN_PANEL = 180;
const KEY = "aad.layout";

// A panel never gets narrower than MIN_PANEL or wider than 60% of the window, so the middle always keeps room.
export const clampWidth = (px: number, windowWidth: number) =>
  Math.round(Math.max(MIN_PANEL, Math.min(px, Math.max(MIN_PANEL, windowWidth * 0.6))));

export function loadLayout(): Layout {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return { ...DEFAULT_LAYOUT, ...saved };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

export function saveLayout(l: Layout): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(l));
  } catch {
    // private window or blocked storage: the layout still works for this page view
  }
}

// The grid columns for a layout: a hidden panel and its handle take no room.
export const gridColumns = (l: Layout) =>
  `${l.leftHidden ? "0 0" : `${l.left}px 6px`} 1fr ${l.rightHidden ? "0 0" : `6px ${l.right}px`}`;
