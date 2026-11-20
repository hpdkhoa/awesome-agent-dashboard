import { useEffect, useState } from "react";
import { collection, getDocs, query, where } from "./fs";
import { db } from "./firebase";
import { ticket } from "./FileView";
import { countReads } from "./pageReads";
import { SrcLine, type SrcCtx } from "./SourceChip";
import { coverage, covStats, firstSentence, isLogRow, LOG_NAME, type CovInput, type LogRow } from "./covCount";

// The coverage bar and the missing list at the top of the report board (plan 44fc4979 s4; see covCount.ts for the
// owner's picks). The chart rule (2026-11-08): the points (one bar per source with its value), a legend naming each
// colour, and the stats with what each one means, always visible. Missing items are listed, never folded away; each
// carries its chip, so a click opens the item's full text under its line.
type Base = Omit<CovInput, "records" | "logRows">;

export function CoverageBar({ planId, base, ctx }: { planId: string; base: Base; ctx: SrcCtx }) {
  const [records, setRecords] = useState<{ id: string; title: string; source: string }[] | null>(null);
  const [logRows, setLogRows] = useState<LogRow[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    getDocs(query(collection(db, "records"), where("plan", "==", planId))).then((s) => {
      countReads(s.size || 1, "records");
      const list = s.docs.map((d) => d.data() as { id: string; title?: string; text?: string; source?: string; status?: string })
        .filter((r) => r.status !== "deleted")
        // the record's first full sentence, not its stored title (some titles are stored cut mid-word; the owner's pick,
        // 2026-11-20: "First sentence of the text")
        .map((r) => ({ id: r.id, title: firstSentence(r.text ?? "") || r.title || "", source: r.source ?? "" }));
      if (live) setRecords(list);
    }, (e) => live && setErr(String(e?.message ?? e)));
    return () => { live = false; };
  }, [planId]);
  // the feedback logs: the ones the plan's KB records come from, and any the board names
  // (one path per file: "K:/a" and "K:\a" are the same log)
  const logs = records === null ? null : [...new Map([
    ...records.map((r) => r.source.replace(/:\d+$/, "")),
    ...base.boardIds.map((i) => i.replace(/(#.*|:\d+)$/, "")),
  ].filter((p) => LOG_NAME.test(p)).map((p) => [p.replace(/\//g, "\\").toLowerCase(), p.replace(/\//g, "\\")] as const)).values()].sort();
  const logKey = logs?.join("|") ?? null;
  useEffect(() => {
    if (logs === null) return;
    let live = true;
    const key = planId.slice(0, 8);
    Promise.all(logs.map((p) => ticket(p, ctx.cwd).then((t) => fetch(t.url)).then((r) => r.text())
      .then((text) => text.split(/\r?\n/).map((l, i) => ({ path: p, line: i + 1, text: l })).filter((r) => isLogRow(r.text) && r.text.includes(key)))))
      .then((all) => live && setLogRows(all.flat()), (e) => live && setErr(String(e?.message ?? e)));
    return () => { live = false; };
  }, [logKey, planId, ctx.cwd]);
  if (err) return <div className="board-box cov" data-cov="error"><p className="small bad">Coverage: could not count ({err})</p></div>;
  if (records === null || logRows === null) return <div className="board-box cov"><p className="small muted">Coverage: counting…</p></div>;
  const groups = coverage({ ...base, records, logRows });
  const st = covStats(groups);
  const used = groups.filter((g) => g.items.length);
  const missing = used.filter((g) => g.items.some((i) => !i.covered));
  return (
    <div className="board-box cov" data-cov={st.missing ? "missing" : "full"} data-cov-total={st.total} data-cov-covered={st.covered}>
      <p className="board-lab">Coverage · {st.covered} of {st.total} truth items reachable ({st.pct}%)</p>
      <div className="board-bar" role="img" aria-label={`covered ${st.covered}, missing ${st.missing}`}>
        {st.covered > 0 && <i className="cov-in" style={{ width: `${st.pct}%` }} title={`covered: ${st.covered} of ${st.total}`} />}
        {st.missing > 0 && <i className="cov-out" style={{ width: `${100 - st.pct}%` }} title={`missing: ${st.missing} of ${st.total}`} />}
      </div>
      <p className="board-legend small">
        <span><i className="sw cov-in" />covered: a chip on the board opens it</span>
        <span><i className="sw cov-out" />missing: no chip on the board opens it</span>
      </p>
      <table className="cov-rows small">
        <tbody>
          {used.map((g) => {
            const n = g.items.filter((i) => i.covered).length, p = Math.round((100 * n) / g.items.length);
            return (
              <tr key={g.source} data-cov-source={g.source}>
                <td>{g.source}</td>
                <td className="cov-mini"><span className="board-bar"><i className="cov-in" style={{ width: `${p}%` }} /><i className="cov-out" style={{ width: `${100 - p}%` }} /></span></td>
                <td className="num">{n} / {g.items.length}</td><td className="num">{p}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <ul className="cov-stats small">
        <li><b>Total {st.total}</b>: truth items of this plan (goal lines, rules, lessons, leftover, step reports, KB records, log rows)</li>
        <li><b>Covered {st.covered}, missing {st.missing}</b>: reachable through a board chip, or not</li>
        <li><b>Sources {st.sources}</b>: kinds of truth that hold items now; mean per source {st.meanPct}%</li>
        {st.lowest && st.highest && <li><b>Lowest {st.lowest.source} {st.lowest.pct}%, highest {st.highest.source} {st.highest.pct}%</b>: where the board traces least and most</li>}
        <li><b>Period</b>: now, the plan's current version and today's records and logs</li>
      </ul>
      {missing.length > 0 && (
        <div className="cov-missing" data-cov-missing={st.missing}>
          <p className="small"><b>Missing ({st.missing})</b> · no chip on the board opens these yet</p>
          {missing.map((g) => (
            <div key={g.source}>
              <p className="small muted">{g.source} ({g.items.filter((i) => !i.covered).length})</p>
              {g.items.filter((i) => !i.covered).map((i, k) => (
                <SrcLine key={k} ids={[i.chip]} ctx={ctx} className="src-bullet cov-miss"><span>{i.label}</span></SrcLine>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
