// The stats every chart shows beside its drawing (the owner's rule, 2026-11-08).
import { describe, expect, it } from "vitest";
import { seriesStats, shares, stackStats } from "../web/src/chartStats";

describe("chart stats", () => {
  it("line: first, last, change, low, high, mean, count and period", () => {
    const st = seriesStats([
      { t: "2026-11-01T00:00:00Z", v: 100 },
      { t: "2026-11-02T00:00:00Z", v: 80 },
      { t: "2026-11-03T00:00:00Z", v: 120 },
    ])!;
    expect(st.count).toBe(3);
    expect(st.first).toBe(100);
    expect(st.last).toBe(120);
    expect(st.change).toBe(20);
    expect(st.changePct).toBeCloseTo(20);
    expect(st.min).toBe(80);
    expect(st.minAt).toBe("2026-11-02T00:00:00Z");
    expect(st.max).toBe(120);
    expect(st.maxAt).toBe("2026-11-03T00:00:00Z");
    expect(st.mean).toBe(100);
    expect(st.from).toBe("2026-11-01T00:00:00Z");
    expect(st.to).toBe("2026-11-03T00:00:00Z");
    expect(seriesStats([])).toBeNull();
    expect(seriesStats([{ t: "x", v: 0 }, { t: "y", v: 5 }])!.changePct).toBeNull(); // no share of a zero first
  });

  it("stack: total, mean, highest, lowest, last day and the period", () => {
    const st = stackStats([
      { day: "2026-10-03", total: 10 },
      { day: "2026-10-04", total: 40 },
      { day: "2026-10-05", total: 25 },
    ])!;
    expect(st.days).toBe(3);
    expect(st.total).toBe(75);
    expect(st.mean).toBe(25);
    expect(st.max).toBe(40);
    expect(st.maxDay).toBe("2026-10-04");
    expect(st.min).toBe(10);
    expect(st.minDay).toBe("2026-10-03");
    expect(st.last).toBe(25);
    expect(st.lastDay).toBe("2026-10-05");
    expect(st.from).toBe("2026-10-03");
    expect(st.to).toBe("2026-10-05");
    expect(stackStats([])).toBeNull();
  });

  it("legend shares add up to 100", () => {
    const s = shares({ cc: 75, other: 25 });
    expect(s.cc).toBe(75);
    expect(s.other).toBe(25);
    expect(Object.values(shares({ a: 0, b: 0 })).every((v) => v === 0)).toBe(true);
  });
});
