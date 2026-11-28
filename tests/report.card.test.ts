import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ResultReportView, inReview, reportStatus, runTime, shownItem } from "../web/src/Inbox";
import type { InboxItem } from "../web/src/data";

// the owner, 2026-11-28: the "Dashboard Card / Report Layout"; "Add Failed"; "Item + fix"; "Layout order, orange";
// "the question will listed inside the review/report if it is belong to this review"
const report = {
  status: "Completed", bottom_line: "Built and pushed.", created: ["a.ts"], updated: [], sent: [], decisions: ["d1"],
  skipped: [{ item: "no screenshot", fix: "check the next card" }], next: "Task closed, no further runs scheduled",
  runId: "c1", startedAt: "", seconds: 252, at: "2026-11-28T10:00:00Z",
} as const;
const review = { id: "r1", kind: "result", title: "r", text: "done", files: [], cwd: "", status: "open", createdAt: "1", report } as unknown as InboxItem;
const q = { id: "q1", kind: "question", reviewId: "r1", title: "Pick?", text: "Pick?", files: [], cwd: "", status: "open",
  createdAt: "2", options: [{ label: "A", detail: "", differs: "d" }], recommended: 0, answer: null } as unknown as InboxItem;

describe("result report", () => {
  it("shows the five parts in the layout order with the measured header", () => {
    const html = renderToStaticMarkup(createElement(ResultReportView, { item: review, items: [review] }));
    const at = ["Status:", "1. Bottom Line", "2. Deliverables", "3. Decisions", "4. Exceptions", "5. Next Scheduled"].map((s) => html.indexOf(s));
    expect(at.every((n, k) => n >= 0 && (k === 0 || n > at[k - 1]))).toBe(true);
    expect(html).toContain("Run: #c1");
    expect(runTime(252)).toBe("4 min 12 s");
  });
  it("status: a waiting review question makes Needs Your Input, Failed stays", () => {
    expect(reportStatus(report as never, 1)).toBe("Needs Your Input");
    expect(reportStatus({ ...report, status: "Failed" } as never, 1)).toBe("Failed");
    expect(reportStatus(report as never, 0)).toBe("Completed");
  });
  it("a review's question sits inside its card, not as its own row", () => {
    expect(inReview(q, [review, q])).toBe(true);
    expect(inReview(q, [q])).toBe(false);
    expect(shownItem(q, [review, q])?.id).toBe("r1");
    const html = renderToStaticMarkup(createElement(ResultReportView, { item: review, items: [review, q] }));
    expect(html).toContain("Needs Your Input");
    expect(html).toContain("report-exceptions need");
  });
});
