import { useState } from "react";
import { sendApproveGenerated, sendGenerate, sendPhaseOrder, sendPlanCheck, usePlanVersions, type InboxItem, type Plan, type Run, type Session } from "./data";
import { approvals, checkGenerate, generateFolder, generatePrompt, tmpFolderOf, KINDS, kindName, lastOrder, resumePrompt, type GenerateCheck, type Kind } from "./planCheck";
import { openFile } from "./FileView";
import { HarnessSection } from "./HarnessView";
import { GeneratedSection } from "./GeneratedView";
import { PHASES, phaseName, phaseOf, phaseOrder, phasePrompt, phaseStarts } from "./phases";
import { MoreMenu } from "./MoreMenu";
import { PartsView } from "./PlanParts";
import { isWaiting } from "./Inbox";
import { Md } from "./Markdown";
import { PlanGraph } from "./PlanGraph";
import { Section } from "./Section";

// Plans with rounds of questions (the owner's choice, 2026-11-01, "do 2"): each version, then the questions asked on it
// and your answers, in order (List), or the tree of versions and choices with a summary of each step (Graph).

const when = (iso: string) => new Date(iso).toLocaleString();
const roundName = (n: number) => (n === 0 ? "Questions before v1" : `Questions on v${n}`);

export function PlanList({ plans, items, picked, onPick }: { plans: Plan[]; items: InboxItem[]; picked?: string; onPick: (id: string) => void }) {
  return (
    <ul className="list">
      {plans.map((p) => {
        const waiting = items.filter((i) => i.planId === p.id && isWaiting(i)).length;
        return (
          <li key={p.id} className={p.id === picked ? "row on" : "row"} onClick={() => onPick(p.id)}>
            <span className={waiting ? "dot wait" : p.status === "open" ? "dot live" : "dot"} />
            <div className="grow">
              <div className="title">{p.title}</div>
              <div className="muted small">
                v{p.current} · {p.workType} · {p.status === "open" ? "open" : "done"}
                {waiting > 0 && ` · ${waiting} waiting for you`}
              </div>
            </div>
            <MoreMenu path={`plans/${p.id}`} />
          </li>
        );
      })}
      {plans.length === 0 && (
        <li className="muted row">No plans yet. A session opens one with plan_start; its questions then group here by round.</li>
      )}
    </ul>
  );
}

// Generate and check, on every plan (planCheck.ts): the owner ticks kinds and writes a note; Generate sends the order.
// Check shows what came back for the last order; Make the missing sends the missing kinds again; else Resume.
function GenerateBox({ plan, items, runs }: { plan: Plan; items: InboxItem[]; runs: Run[] }) {
  const [kinds, setKinds] = useState<Kind[]>([]);
  const [note, setNote] = useState("");
  const [c, setC] = useState<GenerateCheck | null>(null);
  const [error, setError] = useState("");
  const going = runs.some((r) => r.planId === plan.id && (r.generate || r.planCheck) && (r.status === "new" || r.status === "running"));
  const order = lastOrder(plan, runs);
  const fail = (e: unknown) => setError(String((e as { code?: string })?.code ?? e));
  const generate = (ks: Kind[], n: string) => sendGenerate(plan, ks, n, generatePrompt(ks, n, generateFolder(plan))).then(() => setC(null)).catch(fail);
  const [ticked, setTicked] = useState<string[]>([]);
  const pending = c ? approvals(c, ticked) : [];
  const approving = runs.some((r) => r.planId === plan.id && r.action === "approve_generated" && (r.status === "new" || r.status === "running"));
  const approved = runs.filter((r) => r.planId === plan.id && r.action === "approve_generated" && r.status === "done").flatMap((r) => (r.moved ?? []).map((m) => m.to));
  const approve = () =>
    Promise.all(pending.map((a) => sendApproveGenerated(plan, a))).then(() => (setC(null), setTicked([]))).catch(fail);
  return (
    <Section id="plan.generate" title="Generate and check" extra={order ? `last: ${order.kinds.map(kindName).join(", ")}` : ""} open>
      <div className="chips">
        {KINDS.map((k) => (
          <label key={k.id} className="chip" title={k.makes}>
            <input type="checkbox" checked={kinds.includes(k.id)}
              onChange={(e) => setKinds(e.target.checked ? [...kinds, k.id] : kinds.filter((x) => x !== k.id))} /> {k.name}
          </label>
        ))}
      </div>
      <textarea rows={2} value={note} placeholder="What it is for (optional), e.g. the delete flow, phone width" onChange={(e) => setNote(e.target.value)} />
      <div className="chips">
        <button className="primary" disabled={going || kinds.length === 0} onClick={() => generate(kinds, note)}>{going ? "Sent" : "Generate"}</button>
        <button className="chip" disabled={!order} onClick={() => order && setC(checkGenerate(plan, order, items))}>Check</button>
      </div>
      {c && (
        <>
          {c.order.kinds.map((k) => {
            const files = c.got[k] ?? [];
            return (
              <details key={k} className="gen-kind" open={files.length === 0}>
                <summary>
                  <b>{kindName(k)}</b>{" "}
                  <span className={files.length ? "small ok-fg" : "small bad"}>
                    {files.length ? `${files.length} file${files.length > 1 ? "s" : ""}` : "missing"}
                  </span>
                </summary>
                <ul className="gen-files">
                  {files.map((f) => {
                    const waiting = tmpFolderOf(f) !== null;
                    return (
                      <li key={f}>
                        <label>
                          <input type="checkbox" disabled={!waiting} checked={!waiting || ticked.includes(f)}
                            onChange={(e) => setTicked(e.target.checked ? [...ticked, f] : ticked.filter((x) => x !== f))} />{" "}
                          <code className="file-link" role="button" onClick={(e) => (e.preventDefault(), openFile(f, plan.cwd))}>{f}</code>
                          <span className="small muted">{waiting ? " · waiting for approval" : " · approved"}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </details>
            );
          })}
          <div className="chips">
            {c.missing.length > 0 ? (
              <button className="primary" disabled={going} onClick={() => generate(c.missing, c.order.note)}>{going ? "Sent" : "Make the missing"}</button>
            ) : (
              plan.status === "open" && (
                <button className="chip" disabled={going} onClick={() => sendPlanCheck(plan, resumePrompt).catch(fail)}>{going ? "Sent" : "Resume the plan"}</button>
              )
            )}
            {pending.length > 0 && (
              <button className="primary" disabled={approving} onClick={approve}>
                {approving ? "Approving" : `Approve the final result (${pending.reduce((n, a) => n + a.keep.length, 0)} kept)`}
              </button>
            )}
          </div>
          {pending.length > 0 && <p className="muted small">Ticked files move into the plan's version folder. The rest, the tmp folder and their results on the dashboard are removed.</p>}
        </>
      )}
      {approved.length > 0 && <p className="muted small">{approved.length} approved file(s): see the plan's Generated section.</p>}
      {error && <p className="bad small">{error}</p>}
    </Section>
  );
}

// Where the plan is, and the owner's buttons to move it, forward or back (phases.ts). Only the owner moves a phase.
function PhaseBar({ plan, runs }: { plan: Plan; runs: Run[] }) {
  const [error, setError] = useState("");
  const now = phaseOf(plan);
  const at = PHASES.findIndex((p) => p.id === now);
  const going = runs.some((r) => r.planId === plan.id && r.phaseOrder && (r.status === "new" || r.status === "running"));
  return (
    <div className="phase-bar">
      <p className="small">
        <b>Phase: {phaseName(now)}</b> <span className="muted">· {PHASES[at]?.means}</span>
      </p>
      {plan.status === "open" && (
        <div className="chips">
          {PHASES.filter((p) => p.id !== now).map((p, i) => (
            <button key={p.id} className="chip" disabled={going} title={p.means}
              onClick={() => sendPhaseOrder(plan, phasePrompt(p.id), phaseOrder(p.id)).catch((e) => setError(String(e?.code ?? e)))}>
              {PHASES.findIndex((x) => x.id === p.id) < at ? `Back to ${p.name}` : `Move to ${p.name}`}
            </button>
          ))}
          {going && <span className="small muted">Order sent</span>}
        </div>
      )}
      {error && <p className="bad small">{error}</p>}
    </div>
  );
}

export function PlanView({ plan, items, session, runs = [], onOpenItem }: {
  plan: Plan; items: InboxItem[]; session?: Session; runs?: Run[]; onOpenItem: (id: string) => void;
}) {
  const versions = usePlanVersions(plan.id);
  const [view, setView] = useState<"parts" | "graph" | "list">(plan.kind === "parts" ? "parts" : "graph");
  const asked = items.filter((i) => i.planId === plan.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const rounds = Array.from({ length: plan.current + 1 }, (_, n) => n);
  return (
    <article>
      <h1>{plan.title}</h1>
      <p className="meta">
        Plan · v{plan.current} · {plan.status === "open" ? "open" : "done"} · {plan.workType} · updated {when(plan.updatedAt)}
        <br />
        from session: {session?.title ?? plan.sessionId}
        {plan.closeNote && (
          <>
            <br />
            closed: {plan.closeNote}
          </>
        )}
      </p>
      <div className="chips">
        {(plan.kind === "parts" ? (["parts", "graph", "list"] as const) : (["graph", "list"] as const)).map((x) => (
          <button key={x} className={view === x ? "chip on" : "chip"} onClick={() => setView(x)}>
            {x === "parts" ? "Plan" : x === "graph" ? "Graph" : "List"}
          </button>
        ))}
      </div>
      <PhaseBar plan={plan} runs={runs} />
      <GenerateBox plan={plan} items={items} runs={runs} />
      {versions && plan.kind !== "parts" && (() => {
        const cur = versions.find((x) => x.n === plan.current);
        return cur ? <HarnessSection plan={plan} v={cur} parent={versions.find((x) => x.n === (cur.parent ?? cur.n - 1))} /> : null;
      })()}
      {versions === null && <p className="muted">Loading</p>}
      {versions && view === "parts" && <PartsView plan={plan} versions={versions} items={items} runs={runs} onOpenItem={onOpenItem} />}
      {versions && view === "graph" && <PlanGraph plan={plan} versions={versions} asked={asked} onOpenItem={onOpenItem} />}
      {view === "list" && rounds.map((n) => {
        const v = versions?.find((x) => x.n === n);
        const qs = asked.filter((i) => (i.round ?? 0) === n);
        const starts = v && versions ? phaseStarts(versions).get(v.n) : undefined;
        return (
          <div key={n}>
            {starts && <h3 className="phase-div">Phase: {phaseName(starts)}</h3>}
            {v && (
              <Section id={`plan.v.${n === plan.current ? "latest" : "old"}`} title={`v${n} · ${v.note || "no note"}`} extra={when(v.createdAt)}
                open={n === plan.current} tools={<MoreMenu path={`planVersions/${plan.id}_v${n}`} />}>
                <Md text={v.text} cwd={plan.cwd} />
              </Section>
            )}
            {qs.length > 0 && (
              <Section id="plan.round" title={roundName(n)} extra={`${qs.filter(isWaiting).length} waiting · ${qs.length} asked`}>
                <table>
                  <tbody>
                    {qs.map((q) => (
                      <tr key={q.id}>
                        <td>
                          <button className="link" onClick={() => onOpenItem(q.id)}>
                            {q.title}
                          </button>
                        </td>
                        <td className={isWaiting(q) ? "small wait-fg" : "small"}>
                          {isWaiting(q)
                            ? "waiting for you"
                            : q.answer
                              ? [q.answer.choice, q.answer.text && `note: ${q.answer.text}`].filter(Boolean).join(" · ")
                              : q.status}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Section>
            )}
          </div>
        );
      })}
      {versions && plan.kind !== "parts" && (() => {
        const cur = versions.find((x) => x.n === plan.current);
        return cur ? <GeneratedSection plan={plan} v={cur} /> : null;
      })()}
    </article>
  );
}
