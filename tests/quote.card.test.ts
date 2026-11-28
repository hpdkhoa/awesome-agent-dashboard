import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QuoteWork, quoteRows } from "../web/src/Inbox";
import type { InboxItem } from "../web/src/data";

// the owner, 2026-11-28: "another default collapsed section is "quote" ... sort by file and is sub collapsed sections"
const item = {
  id: "r1", kind: "result", text: "done", files: [], cwd: "",
  changes: [
    { file: "K:/b/z.py", changed: "c", check: "k", quote: "def z():" },
    { file: "K:/a/p.png", changed: "picture", check: "markers" },
    { file: "K:/a/y.py", changed: "c", check: "k", quote: "def y():" },
  ],
} as unknown as InboxItem;

describe("result Quote section", () => {
  it("lists quoted files only, sorted by path", () => {
    expect(quoteRows(item).map((c) => c.file)).toEqual(["K:/a/y.py", "K:/b/z.py"]);
  });
  it("starts folded with its count, and is absent with no quote", () => {
    const html = renderToStaticMarkup(createElement(QuoteWork, { item }));
    expect(html).toContain("Quote");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("def y():");
    expect(html).toMatch(/sec-extra">2</);
    expect(renderToStaticMarkup(createElement(QuoteWork, { item: { ...item, changes: [] } }))).toBe("");
  });
});
