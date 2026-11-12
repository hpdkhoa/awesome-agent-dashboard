import { useState } from "react";
import { colorOf, seriesStats, shares, stackStats, type Point } from "./chartStats";
import type { Usage } from "./data";
import { num, usd } from "./Dashboard";

// Every chart here shows its points, a legend and its stats, each with its meaning (the owner's words, 2026-11-08:
// "whatever has a graph or chart to display something then the points, the legend and the stats must be visible and
// display the meaning of these thing").

const day = (iso: string) => new Date(iso).toLocaleDateString();
const short = (d: string) => d.slice(5); // "2026-11-08" -> "11-08"

function Stats({ rows }: { rows: { label: string; value: string; means: string }[] }) {
  return (
    <dl className="stats">
      {rows.map((r) => (
        <div key={r.label} title={r.means}>
          <dt className="small muted">{r.label}</dt>
          <dd>{r.value}</dd>
          <dd className="small muted means">{r.means}</dd>
        </div>
      ))}
    </dl>
  );
}

function Legend({ items }: { items: { name: string; color: string; note: string }[] }) {
  return (
    <ul className="legend">
      {items.map((i) => (
        <li key={i.name}>
          <span className="swatch" style={{ background: i.color }} /> {i.name} <span className="small muted">{i.note}</span>
        </li>
      ))}
    </ul>
  );
}

// One series over time: a line with a dot on every point, the value on hover, the range on the axes, legend and stats.
export function LineChart({ label, unit, points, digits = 0 }: { label: string; unit: string; points: Point[]; digits?: number }) {
  const st = seriesStats(points);
  const f = (v: number) => v.toLocaleString("vi-VN", { maximumFractionDigits: digits }) + (unit ? " " + unit : "");
  if (!st || points.length < 2) return <p className="muted small">{label}: needs two saved points to draw.</p>;
  const w = 600, h = 160, left = 60, right = 10, top = 10, bottom = 24;
  const span = st.max - st.min || 1;
  const x = (i: number) => left + (i / (points.length - 1)) * (w - left - right);
  const y = (v: number) => top + (1 - (v - st.min) / span) * (h - top - bottom);
  const color = colorOf(0);
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label}>
        <line x1={left} y1={y(st.max)} x2={w - right} y2={y(st.max)} className="grid" />
        <line x1={left} y1={y(st.min)} x2={w - right} y2={y(st.min)} className="grid" />
        <text x={left - 6} y={y(st.max) + 4} textAnchor="end" className="axis">{f(st.max)}</text>
        <text x={left - 6} y={y(st.min) + 4} textAnchor="end" className="axis">{f(st.min)}</text>
        <text x={left} y={h - 6} className="axis">{day(st.from)}</text>
        <text x={w - right} y={h - 6} textAnchor="end" className="axis">{day(st.to)}</text>
        <polyline fill="none" stroke={color} strokeWidth="2" points={points.map((p, i) => `${x(i)},${y(p.v)}`).join(" ")} />
        {points.map((p, i) => (
          <circle key={i} cx={x(i)} cy={y(p.v)} r="3.5" fill={color} className="pt">
            <title>{`${new Date(p.t).toLocaleString()}: ${f(p.v)}`}</title>
          </circle>
        ))}
      </svg>
      <Legend items={[{ name: label, color, note: `${st.count} points, one per saved sync · hover a dot for its value` }]} />
      <Stats
        rows={[
          { label: "First", value: f(st.first), means: `the oldest saved value, ${day(st.from)}` },
          { label: "Last", value: f(st.last), means: `the newest saved value, ${day(st.to)}` },
          { label: "Change", value: `${st.change >= 0 ? "+" : ""}${f(st.change)}${st.changePct == null ? "" : ` (${st.changePct >= 0 ? "+" : ""}${st.changePct.toFixed(2)}%)`}`, means: "last minus first, and that as a share of the first" },
          { label: "Low", value: f(st.min), means: `the lowest value, on ${day(st.minAt)}` },
          { label: "High", value: f(st.max), means: `the highest value, on ${day(st.maxAt)}` },
          { label: "Mean", value: f(st.mean), means: "all values added, divided by their count" },
          { label: "Points", value: `${st.count}`, means: `saved values from ${day(st.from)} to ${day(st.to)}` },
        ]}
      />
    </figure>
  );
}

type Group = "workType" | "model" | "kind";
type Measure = "usd" | "tokens";
const KINDS: [keyof Usage, string][] = [["input", "input"], ["output", "output"], ["cacheWrite5m", "cache write 5m"], ["cacheWrite1h", "cache write 1h"], ["cacheRead", "cache read"]];
const GROUPS: [Group, string][] = [["workType", "Work type"], ["model", "Model"], ["kind", "Token kind"]];
export const RANGES: [number, string][] = [[1, "today"], [14, "14 days"], [30, "30 days"], [90, "90 days"], [0, "all"]];

// Spend by day over the whole history, stacked by work type, model or token kind, in dollars (estimate) or tokens.
// range: days shown and loaded (1 = today, the default; 0 = every synced day); the owner picks it here, the Dashboard loads it
export function SpendChart({ usage, range, onRange }: { usage: Usage[]; range: number; onRange: (d: number) => void }) {
  const [group, setGroup] = useState<Group>("workType");
  const [measure, setMeasure] = useState<Measure>("usd");
  const all = [...usage].sort((a, b) => a.day.localeCompare(b.day));
  const days = range ? all.slice(-range) : all;
  const m: Measure = group === "kind" ? "tokens" : measure; // cost is not split by token kind
  const keys =
    group === "kind"
      ? KINDS.map(([k]) => k as string)
      : [...new Set(days.flatMap((d) => Object.keys(group === "workType" ? d.byWorkType : d.byModel)))].sort();
  const value = (d: Usage, k: string): number => {
    if (group === "kind") return (d[k as keyof Usage] as number) || 0;
    const t = (group === "workType" ? d.byWorkType : d.byModel)[k];
    return t ? (m === "usd" ? t.costUsd : t.total) : 0;
  };
  const f = (v: number) => (m === "usd" ? usd(v) : num(v) + " tok");
  const rows = days.map((d) => ({ day: d.day, parts: keys.map((k) => value(d, k)), total: keys.reduce((a, k) => a + value(d, k), 0) }));
  const st = stackStats(rows);
  const totals = Object.fromEntries(keys.map((k) => [k, rows.reduce((a, r) => a + r.parts[keys.indexOf(k)], 0)]));
  const share = shares(totals);
  const name = (k: string) => (group === "kind" ? KINDS.find(([x]) => x === k)?.[1] ?? k : k);
  const w = 600, h = 180, left = 52, right = 6, top = 16, bottom = 24;
  const max = Math.max(1e-9, ...rows.map((r) => r.total));
  const bw = (w - left - right) / Math.max(1, rows.length);
  const y = (v: number) => top + (1 - v / max) * (h - top - bottom);
  const every = Math.max(1, Math.ceil(rows.length / 12)); // about 12 date labels
  const showValues = rows.length <= 31;
  return (
    <div>
      <div className="chips chart-controls">
        {GROUPS.map(([g, label]) => (
          <button key={g} className={group === g ? "chip on" : "chip"} onClick={() => setGroup(g)}>{label}</button>
        ))}
        <span className="sep" />
        <button className={m === "usd" ? "chip on" : "chip"} disabled={group === "kind"} onClick={() => setMeasure("usd")} title={group === "kind" ? "cost is not split by token kind" : ""}>$ est.</button>
        <button className={m === "tokens" ? "chip on" : "chip"} onClick={() => setMeasure("tokens")}>tokens</button>
        <span className="sep" />
        {RANGES.map(([r, label]) => (
          <button key={r} className={range === r ? "chip on" : "chip"} onClick={() => onRange(r)} title={r === 1 ? "one document read" : r ? `up to ${r} reads` : "every synced day"}>{label}</button>
        ))}
      </div>
      {rows.length === 0 ? (
        <p className="muted small">No usage days yet.</p>
      ) : (
        <figure className="chart">
          <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`spend by day, by ${name(group)}`}>
            <line x1={left} y1={y(max)} x2={w - right} y2={y(max)} className="grid" />
            <line x1={left} y1={y(0)} x2={w - right} y2={y(0)} className="grid" />
            <text x={left - 6} y={y(max) + 4} textAnchor="end" className="axis">{f(max)}</text>
            <text x={left - 6} y={y(0)} textAnchor="end" className="axis">0</text>
            {rows.map((r, i) => {
              let acc = 0;
              const x0 = left + i * bw + bw * 0.1;
              return (
                <g key={r.day}>
                  <title>{`${r.day}: ${f(r.total)}\n${keys.map((k, j) => `${name(k)}: ${f(r.parts[j])}`).join("\n")}`}</title>
                  {r.parts.map((v, j) => {
                    const y1 = y(acc + v), y0 = y(acc);
                    acc += v;
                    return v > 0 ? <rect key={j} x={x0} y={y1} width={bw * 0.8} height={Math.max(0.5, y0 - y1)} fill={colorOf(j)} /> : null;
                  })}
                  {showValues && r.total > 0 && (
                    <text x={x0 + bw * 0.4} y={y(r.total) - 3} textAnchor="middle" className="value">{f(r.total)}</text>
                  )}
                  {i % every === 0 && <text x={x0 + bw * 0.4} y={h - 6} textAnchor="middle" className="axis">{short(r.day)}</text>}
                </g>
              );
            })}
          </svg>
          <Legend items={keys.map((k, j) => ({ name: name(k), color: colorOf(j), note: `${f(totals[k])} · ${share[k].toFixed(1)}% of the period` }))} />
          {st && (
            <Stats
              rows={[
                { label: "Total", value: f(st.total), means: `every day from ${st.from} to ${st.to} added` },
                { label: "Mean per day", value: f(st.mean), means: `total divided by ${st.days} days with data` },
                { label: "Highest day", value: f(st.max), means: `${st.maxDay}, the day that spent most` },
                { label: "Lowest day", value: f(st.min), means: `${st.minDay}, the day that spent least` },
                { label: "Last day", value: f(st.last), means: `${st.lastDay}, the newest day with data` },
                { label: "Days", value: `${st.days}`, means: range === 1 ? "today only" : range ? `the last ${range} days with data` : "every day the bridge has synced" },
              ]}
            />
          )}
          <p className="small muted">
            {m === "usd" ? "Dollars are list-price estimates from token counts; your plan is a subscription, not this bill." : "Tokens as counted in the session logs."}{" "}
            {showValues ? "The number on each bar is that day's total; hover a bar for each part." : "Hover a bar for its day and each part."}
          </p>
        </figure>
      )}
    </div>
  );
}
