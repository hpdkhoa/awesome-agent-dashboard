// F4, done needs a receipt (plan bf73af63; the owner's picks 2026-11-13: "Check or checked pictures", "Badge only";
// 2026-11-19: "Done waits for its receipt", "All done before F4 without receipt"). A step's header shows what made it
// done: its receipt (the ticked check's exit 0, or the LLM check's pass of its pictures), "checking" while it waits,
// or "no receipt" on a step done before F4. A step done before F4 whose ticked check last exited 0 shows that run.
import { Md } from "./Markdown";
import { Clamp } from "./Clamp";
import { checkTicked, type PlanStep, type Receipt, type StepCheck } from "./data";
import { dt } from "./fmt";
import { Findings } from "./Findings";

export type ReceiptView = { r: Receipt; old?: boolean } | null;

export function receiptOf(sv?: PlanStep, c?: StepCheck): ReceiptView {
  if (!sv || sv.state !== "done") return null;
  const last = [...(sv.versions ?? [])].reverse().find((v) => v.state === "done");
  if (last?.receipt) return { r: last.receipt };
  const run = c?.last;
  if (run && run.exit === 0 && checkTicked(c) && run.command === c?.command)
    return { r: { kind: "check", commit: "", at: run.endedAt, runId: run.runId, exit: 0, seconds: run.seconds,
      command: run.command, output: run.tail }, old: true };
  return null;
}

const label = (r: Receipt) => r.kind === "check" ? `check exit ${r.exit}` : `pictures ${r.overall ?? "pass"}`;

export function ReceiptChip({ sv, c }: { sv?: PlanStep; c?: StepCheck }) {
  if (sv?.state === "checking") {
    const by = [...(sv.versions ?? [])].reverse().find((v) => v.state === "checking")?.receiptBy;
    return <span className="check-chip unclear" data-receipt="checking"
      title="The done report waits for its receipt">waiting for receipt · {by === "pictures" ? "LLM check" : "check"}</span>;
  }
  if (sv?.state !== "done") return null;
  const v = receiptOf(sv, c);
  if (!v) return <span className="check-chip unclear" data-receipt="none" title="Done before F4, with no passing check or checked pictures">no receipt</span>;
  return <span className="check-chip pass" data-receipt={v.r.kind} title={`Receipt ${dt(v.r.at)}`}>
    receipt · {label(v.r)}{v.r.commit ? ` · ${v.r.commit}` : ""}{v.old ? " · before F4" : ""}</span>;
}

export function ReceiptBox({ sv, c }: { sv?: PlanStep; c?: StepCheck }) {
  const v = receiptOf(sv, c);
  if (!v) return null;
  const r = v.r;
  return (
    <div className="stepcheck-last" data-receipt-box={r.kind}>
      <b className="small">Receipt</b>{" "}
      <span className="small muted">
        {label(r)} · {dt(r.at)}{r.commit ? <> · commit <code>{r.commit}</code></> : " · commit not kept (before F4)"}
        {r.seconds != null ? ` · ${r.seconds} s` : ""}
      </span>
      {r.command && <div className="small muted">ran: <code>{r.command}</code></div>}
      {r.output != null && <Clamp><pre className="mono check-out">{r.output || "(no output)"}</pre></Clamp>}
      {r.marks && r.marks.length > 0 && (
        <ul className="small">
          {r.marks.map((m) => <li key={m.path}><span className={"check-chip " + m.verdict}>{m.verdict}</span> {m.path.split(/[\\/]/).pop()} · {m.why}</li>)}
        </ul>
      )}
      {r.note && <Md className="small muted" text={r.note} />}
      {r.kind === "pictures" && <Findings findings={r.findings} />}
    </div>
  );
}
