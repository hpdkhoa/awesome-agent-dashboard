// The owner, 2026-11-20: "make sure not display <svg> or raw text without render again": markdown, tables, safe HTML and
// drawings render; nothing unsafe runs.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Md } from "../web/src/Markdown";
import { splitDrawings } from "../web/src/richText";

const html = (t: string, cwd?: string) => renderToStaticMarkup(createElement(Md, { text: t, cwd }));

describe("rich text", () => {
  it("shows an inline svg and a ```svg fence as pictures, never as text", () => {
    const out = html("Before\n\n<svg width='10'><rect/></svg>\n\nmid\n\n```svg\n<svg><circle/></svg>\n```\n\nafter");
    expect(out).not.toContain("&lt;svg");
    expect(out.match(/<img class="md-drawing"/g)?.length).toBe(2);
    expect(out).toContain("data:image/svg+xml");
    expect(out).toContain("Before") && expect(out).toContain("after");
  });

  it("keeps an svg inside a code span or a code fence as code", () => {
    expect(splitDrawings("use `<svg></svg>` here")).toEqual([{ md: "use `<svg></svg>` here" }]);
    expect(splitDrawings("```html\n<svg></svg>\n```").length).toBe(1);
  });

  it("renders tables and safe HTML, drops scripts and handlers", () => {
    const out = html("| a | b |\n|---|---|\n| 1 | 2 |\n\n<b>bold</b><br><details><summary>more</summary>x</details>\n\n<script>alert(1)</script><img src=x onerror=alert(1)>");
    expect(out).toContain("<table>") && expect(out).toContain("<td>2</td>");
    expect(out).toContain("<b>bold</b>") && expect(out).toContain("<summary>more</summary>");
    expect(out).not.toContain("<script") && expect(out).not.toContain("onerror") && expect(out).not.toContain("&lt;b&gt;");
  });

  it("keeps PC paths as file links and blanks javascript links", () => {
    const out = html(String.raw`[pic](K:\cc\a.png) and <a href="javascript:alert(1)">x</a>`, "K:/cc");
    expect(out).toContain('class="file-link"');
    expect(out).not.toContain("javascript:");
  });
});
