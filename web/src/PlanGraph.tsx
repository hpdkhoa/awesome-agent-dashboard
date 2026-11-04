import { useState } from "react";
import { chooseVersion, reopenItem, type InboxItem, type Plan, type PlanVersion } from "./data";
import { Md } from "./Markdown";
import { chip, chosenLine, layout, lineDiff, parentOf, steps, type Step } from "./planTree";
import { phaseName, phaseOf, phaseStarts } from "./phases";
import { Section } from "./Section";

// The graph version of a plan (approved 2026-11-01): step cards with your answers (the session's work on hover), the
// tree of versions and question rounds, and a panel for the node you click.

type Pick = { kind: "v"; n: number } | { kind: "r"; round: number } | null;

function Work({ s }: { s: Step }) {
  return (
    <>
      {s.made ? (
        <>
          Session's work: v{s.made.n}, {s.made.note || "no note"}
          <br />+{s.add} / -{s.del} lines against v{s.round}
        </>
      ) : (
        "No version made from these answers yet."
      )}
    </>
  );
}

function StepCard({ s, k, onPick }: { s: Step; k: number; onPick: (p: Pick) => void }) {
  return (
    <div className="step">
      <span className="muted small">
        Step {k} · questions on {s.round ? `v${s.round}` : "the start"}
      </span>
      <div className="chips">
        {s.answers.map((d) => (
          <span key={d.id} className="hov chip on" onClick={() => onPick({ kind: "r", round: s.round })}>
            {chip(d)}
            <span className="pop">
              {d.title}
              <br />
              <Work s={s} />
            </span>
          </span>
        ))}
        {s.answers.length === 0 && <span className="muted small">no answers yet</span>}
        <span className="muted">→</span>
        {s.made ? (
          <span className="hov chip" onClick={() => onPick({ kind: "v", n: s.made!.n })}>
            v{s.made.n}
            <span className="pop">
              <Work s={s} />
            </span>
          </span>
        ) : (
          <span className="muted small">no version yet</span>
        )}
      </div>
      <span className="muted small">
        {s.answers.length} decision{s.answers.length === 1 ? "" : "s"} · +{s.add} / -{s.del} lines · {s.waiting} waiting
      </span>
    </div>
  );
}

const X = (depth: number) => 16 + depth * 190;
const Y = (lane: number) => 34 + lane * 84;

function Tree({ plan, versions, asked, pick, onPick }: {
  plan: Plan; versions: PlanVersion[]; asked: InboxItem[]; pick: Pick; onPick: (p: Pick) => void;
}) {
  const { nodes, lanes } = layout(versions);
  const line = chosenLine(plan, versions);
  const starts = phaseStarts(versions); // the phase divider: where each phase begins
  const at = new Map(nodes.map((d) => [d.v.n, d]));
  const roundOf = (n: number) => asked.filter((q) => (q.round ?? 0) === n);
  const width = Math.max(...nodes.map((d) => X(d.depth)), 0) + 200;
  const height = Y(lanes) - 20;
  return (
    <svg className="tree" viewBox={`0 0 ${width} ${height}`} style={{ width, maxWidth: "none" }} role="img" aria-label="plan graph">
      {nodes.map(({ v, depth, lane }) => {
        const p = at.get(parentOf(v));
        if (!p) return null;
        const hasRound = roundOf(p.v.n).length > 0;
        const x0 = X(p.depth) + (hasRound ? 130 : 70), y0 = Y(p.lane);
        const x1 = X(depth), y1 = Y(lane);
        return (
          <path key={"e" + v.n} className={line.has(v.n) ? "edge" : "edge off"}
            d={`M${x0} ${y0} H${x1 - 30} Q${x1 - 15} ${y0} ${x1 - 15} ${(y0 + y1) / 2} T${x1} ${y1}`} />
        );
      })}
      {nodes.map(({ v, depth, lane }) => {
        const qs = roundOf(v.n);
        const x = X(depth), y = Y(lane);
        const on = line.has(v.n);
        const waiting = qs.filter((q) => q.status === "open").length;
        return (
          <g key={v.n}>
            {qs.length > 0 && <path className={on ? "edge" : "edge off"} d={`M${x + 70} ${y} H${x + 90}`} />}
            <g className={`node${on ? "" : " off"}${pick?.kind === "v" && pick.n === v.n ? " picked" : ""}`} onClick={() => onPick({ kind: "v", n: v.n })}>
              <title>{`v${v.n} · ${phaseName(phaseOf(v))}: ${v.note}${v.parts?.steps.some((s) => s.new) ? ` · ${v.parts.steps.filter((s) => s.new).length} new steps` : ""}`}</title>
              <rect x={x} y={y - 20} width={70} height={40} rx={8} />
              <text x={x + 35} y={y + 5}>v{v.n}</text>
              {starts.has(v.n) && <text className="tag-t phase-t" x={x + 35} y={y - 26}>{phaseName(starts.get(v.n)!)}</text>}
              {v.n === plan.current && <text className="tag-t" x={x + 35} y={y + 34}>newest</text>}
              {on && v.n === (plan.chosen ?? plan.current) && v.n !== plan.current && <text className="tag-t" x={x + 35} y={y + 34}>chosen</text>}
            </g>
            {qs.length > 0 && (
              <g className={`round${waiting ? " waiting" : ""}${pick?.kind === "r" && pick.round === v.n ? " picked" : ""}`} onClick={() => onPick({ kind: "r", round: v.n })}>
                <title>{qs.map((q) => `${q.title}: ${q.answer ? chip({ id: q.id, title: q.title, choice: q.answer.choice, text: q.answer.text }) : "waiting"}`).join("\n")}</title>
                <polygon points={`${x + 110},${y - 20} ${x + 130},${y} ${x + 110},${y + 20} ${x + 90},${y}`} />
                <text x={x + 110} y={y + 4}>Q</text>
                <text className="tag-t" x={x + 110} y={y + 34}>
                  {qs.length - waiting}/{qs.length}
                </text>
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function Reopen({ q }: { q: InboxItem }) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState("");
  const [text, setText] = useState("");
  const [msg, setMsg] = useState("");
  if (!open) return <button className="link" onClick={() => setOpen(true)}>Reopen with another choice</button>;
  return (
    <div className="reopen">
      <div className="chips">
        {q.options.map((o) => (
          <button key={o.label} className={choice === o.label ? "chip on" : "chip"} onClick={() => setChoice(o.label)}>
            {o.label}
          </button>
        ))}
      </div>
      <textarea rows={2} value={text} placeholder="Note (optional)" onChange={(e) => setText(e.target.value)} />
      <button className="primary" disabled={!choice && !text.trim()}
        onClick={() => reopenItem(q, choice, text.trim()).then(() => setMsg("Sent. The session branches the plan from here."), (e) => setMsg(String(e)))}>
        Send new answer
      </button>{" "}
      <button onClick={() => setOpen(false)}>Cancel</button>
      {msg && <p className="small muted">{msg}</p>}
    </div>
  );
}

function Panel({ plan, versions, asked, pick, onOpenItem }: {
  plan: Plan; versions: PlanVersion[]; asked: InboxItem[]; pick: Pick; onOpenItem: (id: string) => void;
}) {
  const [full, setFull] = useState(false);
  if (!pick) return <p className="muted small">Click a version or a Q to see it here.</p>;
  if (pick.kind === "r") {
    const qs = asked.filter((q) => (q.round ?? 0) === pick.round);
    return (
      <Section id="plan.panel" title={pick.round ? `Questions on v${pick.round}` : "Questions before v1"} extra={`${qs.length} asked`}>
        <table>
          <tbody>
            {qs.map((q) => (
              <tr key={q.id}>
                <td>
                  <button className="link" onClick={() => onOpenItem(q.id)}>
                    {q.title}
                  </button>
                  {q.history?.length ? <span className="muted small"> · was: {q.history.map((h) => h.choice || h.text).join(", then ")}</span> : null}
                </td>
                <td className="small">
                  {q.status === "open" ? <span className="wait-fg">waiting for you</span> : q.answer ? chip({ id: q.id, title: q.title, choice: q.answer.choice, text: q.answer.text }) : q.status}
                  {q.answer && plan.status === "open" && q.kind === "question" && (
                    <>
                      <br />
                      <Reopen q={q} />
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    );
  }
  const v = versions.find((x) => x.n === pick.n);
  if (!v) return null;
  const parent = versions.find((x) => x.n === parentOf(v));
  const diff = lineDiff(parent?.text ?? "", v.text).filter((l) => l.op !== "same");
  const chosen = chosenLine(plan, versions).has(v.n);
  return (
    <Section id="plan.panel" title={`v${v.n}${parent ? ` (parent v${parent.n})` : ""} · ${v.note || "no note"}`} extra={new Date(v.createdAt).toLocaleString()}>
      {v.madeBy?.length ? (
        <p className="small">Made by: {v.madeBy.map((d) => `${d.title} = ${chip(d)}`).join(" · ")}</p>
      ) : (
        <p className="small muted">Made by: no recorded answers.</p>
      )}
      <pre className="diff">
        {diff.slice(0, 80).map((l, i) => (
          <div key={i} className={l.op === "add" ? "in" : "bad"}>
            {l.op === "add" ? "+ " : "- "}
            {l.line}
          </div>
        ))}
        {diff.length === 0 && <span className="muted">no line changed</span>}
        {diff.length > 80 && <span className="muted">… {diff.length - 80} more changed lines</span>}
      </pre>
      <div className="actions">
        <button onClick={() => setFull(!full)}>{full ? "Hide full text" : "Show full text"}</button>{" "}
        {!(chosen && v.n === (plan.chosen ?? plan.current)) && (
          <button onClick={() => chooseVersion(plan.id, v.n)}>Choose this branch</button>
        )}
      </div>
      {full && <Md text={v.text} cwd={plan.cwd} />}
    </Section>
  );
}

export function PlanGraph({ plan, versions, asked, onOpenItem }: {
  plan: Plan; versions: PlanVersion[]; asked: InboxItem[]; onOpenItem: (id: string) => void;
}) {
  const [pick, setPick] = useState<Pick>({ kind: "v", n: plan.chosen ?? plan.current });
  const all = steps(plan, versions, asked);
  const last = all.at(-1);
  return (
    <>
      {last && <StepCard s={last} k={all.length} onPick={setPick} />}
      {all.length > 1 && (
        <Section id="plan.steps" title="Earlier steps" extra={all.length - 1} open={false}>
          {all.slice(0, -1).reverse().map((s, i) => (
            <StepCard key={s.round} s={s} k={all.length - 1 - i} onPick={setPick} />
          ))}
        </Section>
      )}
      <div className="tree-wrap">
        <Tree plan={plan} versions={versions} asked={asked} pick={pick} onPick={setPick} />
      </div>
      <Panel plan={plan} versions={versions} asked={asked} pick={pick} onOpenItem={onOpenItem} />
    </>
  );
}
