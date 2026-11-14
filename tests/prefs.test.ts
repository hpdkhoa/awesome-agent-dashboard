// Settings tab (the owner, 2026-11-14: "this setting is browser/instance only"): a saved or imported file is cleaned to
// valid settings, only changes are saved, and the defaults keep the page as it was.
import { describe, expect, it } from "vitest";
import { DEFAULTS, diff, normalize } from "../web/src/prefs";

describe("browser settings", () => {
  it("defaults are the page as it was: 16 px root, line height 1.5, system font and theme", () => {
    expect(DEFAULTS).toMatchObject({ size: 16, lineHeight: 1.5, font: "system", theme: "system", density: "normal", startTab: "inbox" });
    expect(diff(DEFAULTS)).toEqual({});
  });
  it("unknown keys go, wrong values fall back, numbers are clamped", () => {
    const s = normalize({ size: 99, lineHeight: "big", theme: "neon", font: "tahoma", evil: 1, phoneSize: 5 });
    expect(s.size).toBe(24);
    expect(s.lineHeight).toBe(1.5);
    expect(s.theme).toBe("system");
    expect(s.font).toBe("tahoma");
    expect(s.phoneSize).toBe(13);
    expect("evil" in s).toBe(false);
  });
  it("a custom font name cannot carry CSS; an accent must be #rrggbb", () => {
    const s = normalize({ fontCustom: "Arial; } body { background: url(x)", accent: "red" });
    expect(s.fontCustom).not.toMatch(/[;{}()]/);
    expect(s.accent).toBe("");
    expect(normalize({ accent: "#12abEF" }).accent).toBe("#12abEF");
  });
  it("only Money, Rates and Storage can hide, and a hidden start tab falls back to Inbox", () => {
    const s = normalize({ hiddenTabs: ["money", "inbox", "plans"], startTab: "money" });
    expect(s.hiddenTabs).toEqual(["money"]);
    expect(s.startTab).toBe("inbox");
  });
  it("only changes are saved", () => {
    expect(diff({ ...DEFAULTS, size: 18, tabular: true })).toEqual({ size: 18, tabular: true });
  });
});
