import { it, expect } from "vitest";
import { mdHtml } from "../avatar/fb/md.js";
it("hayaku shows markdown, tables and drawings, never raw svg, scripts or live links", () => {
  const refs: [string, boolean][] = [];
  const ref = (u: string, w: boolean) => refs.push([u, w]) - 1;
  const h = mdHtml("**b** <svg width='3'><rect/></svg>\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n[web](https://x.io) [f](K:/cc/a.md) ![p](K:/cc/p.png) <script>x</script><a href=\"javascript:1\">j</a>", ref);
  expect(h).not.toContain("&lt;svg"); expect(h).toContain("<table>"); expect(h).not.toContain("<script");
  expect(h).not.toContain("javascript:"); expect(h).not.toMatch(/href=/);
});
