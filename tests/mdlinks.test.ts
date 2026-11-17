import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Md, slashPaths } from "../web/src/Markdown";

// The owner, 2026-11-17: "link and file preview in plan report is broken, everytime I click it then the page on mobile
// phone reload and lost, no file or image show". A report link or picture with a PC path must open the file viewer
// (href="#", class file-link), never a real page link (an empty href reloads the dashboard).
const html = (text: string) => renderToStaticMarkup(createElement(Md, { text, cwd: "K:/Projects/x" }));

describe("report links to PC files", () => {
  for (const p of [String.raw`K:\Projects\x\a.md`, "K:/Projects/x/a.md", String.raw`C:\Users\me\shot one.png`, "file:///K:/x/a.md", "out/a.md"]) {
    it(`link ${p} opens the viewer`, () => {
      const h = html(`[a](<${p}>)`);
      expect(h).toContain('class="file-link"');
      expect(h).not.toContain('href=""');
      expect(h).not.toContain('target="_blank"');
    });
    it(`picture ${p} is asked from the PC`, () => {
      const h = html(`![a](<${p.replace(/\.md$/, ".png")}>)`);
      expect(h).not.toContain('src=""');
    });
  }
  it("a dot folder keeps its slash (a backslash dot is a markdown escape)", () => {
    const t = slashPaths(String.raw`[a](<K:\Projects\Claude\cc\.plan_data\e\s2-04.png>) ![b](K:\cc\.plan_data\p.png) code K:\x`);
    expect(t).toBe(String.raw`[a](<K:/Projects/Claude/cc/.plan_data/e/s2-04.png>) ![b](K:/cc/.plan_data/p.png) code K:\x`);
  });
  it("web links stay web links", () => {
    expect(html("[a](https://example.com)")).toContain('href="https://example.com"');
  });
  it("javascript: links are still dropped", () => {
    expect(html("[a](javascript:alert(1))")).not.toContain("javascript:");
  });
});
