// The numbers every chart shows beside its drawing (the owner's rule, 2026-11-08: "the points, the legend and the stats
// must be visible and display the meaning of these thing"). Pure functions, so they are tested without a browser.

export type Point = { t: string; v: number };

export type SeriesStats = {
  count: number; from: string; to: string;
  first: number; last: number; change: number; changePct: number | null;
  min: number; minAt: string; max: number; maxAt: string; mean: number;
};

// Stats of one line: oldest point first.
export function seriesStats(points: Point[]): SeriesStats | null {
  if (points.length === 0) return null;
  const vs = points.map((p) => p.v);
  let mi = 0, ma = 0;
  vs.forEach((v, i) => {
    if (v < vs[mi]) mi = i;
    if (v > vs[ma]) ma = i;
  });
  const first = vs[0], last = vs[vs.length - 1];
  return {
    count: points.length, from: points[0].t, to: points[points.length - 1].t,
    first, last, change: last - first, changePct: first ? ((last - first) / Math.abs(first)) * 100 : null,
    min: vs[mi], minAt: points[mi].t, max: vs[ma], maxAt: points[ma].t,
    mean: vs.reduce((a, b) => a + b, 0) / vs.length,
  };
}

export type StackStats = {
  days: number; from: string; to: string; total: number; mean: number;
  max: number; maxDay: string; min: number; minDay: string; last: number; lastDay: string;
};

// Stats of stacked bars by day: each row is one day's total over every series, oldest first.
export function stackStats(rows: { day: string; total: number }[]): StackStats | null {
  if (rows.length === 0) return null;
  let mi = 0, ma = 0;
  rows.forEach((r, i) => {
    if (r.total < rows[mi].total) mi = i;
    if (r.total > rows[ma].total) ma = i;
  });
  const total = rows.reduce((a, r) => a + r.total, 0);
  const last = rows[rows.length - 1];
  return {
    days: rows.length, from: rows[0].day, to: last.day, total, mean: total / rows.length,
    max: rows[ma].total, maxDay: rows[ma].day, min: rows[mi].total, minDay: rows[mi].day, last: last.total, lastDay: last.day,
  };
}

// Share of each series over the period, for the legend.
export function shares(totals: Record<string, number>): Record<string, number> {
  const sum = Object.values(totals).reduce((a, b) => a + b, 0) || 1;
  return Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, (v / sum) * 100]));
}

// Distinct colours for up to eight series; the ninth starts over.
export const PALETTE = ["#185fa5", "#1d9e75", "#d85a30", "#7f77dd", "#ba7517", "#d4537e", "#639922", "#888780"];
export const colorOf = (i: number) => PALETTE[i % PALETTE.length];
