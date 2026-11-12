import { useState } from "react";
import { isClosed, setPlanStatus, sendApproveGenerated, sendGenerate, usePlanGenerated, sendPhaseOrder, sendPlanCheck, usePlanVersions, type InboxItem, type Plan, type Run, type Session } from "./data";
import { approvals, approvedFiles, checkGenerate, generateFolder, generatePrompt, relPath, versionFolderOf, KINDS, kindName, lastOrder, resumePrompt, type GenerateCheck, type Kind } from "./planCheck";
import { openFile } from "./FileView";
import { HarnessSection } from "./HarnessView";
import { GeneratedSection } from "./GeneratedView";
import { PHASES, phaseName, phaseOf, phaseOrder, phasePrompt, phaseStarts } from "./phases";
import { MoreMenu } from "./MoreMenu";
import { PartsView } from "./PlanParts";
import { RunWithPicker } from "./Runs";
import type { RunWith } from "./data";
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
            <span className={waiting ? "dot wait" : isClosed(p) ? "dot" : "dot live"} />
            <div className="grow">
              <div className="title">{p.title}</div>
              <div className="muted small">
                <StatusChips plan={p} />v{p.current} · {p.workType}
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
  const [w, setW] = useState<RunWith>({});
  const generate = (ks: Kind[], n: string) => sendGenerate(plan, ks, n, generatePrompt(ks, n, generateFolder(plan)), w).then(() => setC(null)).catch(fail);
  const [ticked, setTicked] = useState<string[]>([]);
  const done = approvedFiles(usePlanGenerated(plan.id));
  const pending = c ? approvals(c, ticked, plan.id, plan.cwd, done) : [];
  const open = c ? c.results.flatMap((r) => r.files).filter((f) => !done.has(relPath(f, plan.cwd)) && versionFolderOf(f, plan.id, plan.cwd)) : [];
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
        <RunWithPicker value={w} onChange={setW} fresh />{" "}
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
                    const isDone = done.has(relPath(f, plan.cwd));
                    const mine = versionFolderOf(f, plan.id, plan.cwd) !== null;
                    return (
                      <li key={f}>
                        <label>
                          <input type="checkbox" disabled={isDone || !mine || approving} checked={isDone || ticked.includes(f)}
                            onChange={(e) => setTicked(e.target.checked ? [...ticked, f] : ticked.filter((x) => x !== f))} />{" "}
                          <code className="file-link" role="button" onClick={(e) => (e.preventDefault(), openFile(f, plan.cwd))}>{f}</code>
                          <span className="small muted">{isDone ? " · approved" : mine ? " · waiting for approval" : " · outside this plan's folder: cannot be approved here"}</span>
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
              <button className="chip" disabled={going} onClick={() => sendPlanCheck(plan, resumePrompt).catch(fail)}>{going ? "Sent" : "Resume the plan"}</button>
            )}
            {open.length > 0 && (
              <button className="primary" disabled={approving || pending.length === 0} onClick={approve}>
                {approving ? "Approving" : `Approve the final result (${pending.reduce((n, a) => n + a.keep.length, 0)} of ${open.length} ticked)`}
              </button>
            )}
          </div>
          {open.length > 0 && <p className="muted small">Tick the files to keep, then Approve. Ticked files go to the plan's Generated section (from tmp/ they move up). Unticked files in tmp/ are removed with it; unticked files outside tmp/ stay where they are, not approved.</p>}
        </>
      )}
      {approved.length > 0 && <p className="muted small">{approved.length} approved file(s): see the plan's Generated section.</p>}
      {error && <p className="bad small">{error}</p>}
    </Section>
  );
}

// The plan's status and phase as two small chips (list rows).
export function StatusChips({ plan }: { plan: Plan }) {
  return (
    <>
      <span className={isClosed(plan) ? "pill closed" : "pill open"}>{isClosed(plan) ? "Closed" : "Open"}</span>{" "}
      <span className="pill phase">{phaseName(phaseOf(plan))}</span>{" "}
    </>
  );
}

// The status bar on each plan (the owner's choice, 2026-11-09, "Both"): Status Open or Closed, set only by the owner;
// Phase as five steps, the current one lit, any other one a Move or Back order (phases.ts). Closed is a label only:
// every button works on a closed plan ("phase can be move back and forth by me so no blocking my action").
function StatusBar({ plan, runs }: { plan: Plan; runs: Run[] }) {
  const [error, setError] = useState("");
  const now = phaseOf(plan);
  const at = PHASES.findIndex((p) => p.id === now);
  const going = runs.some((r) => r.planId === plan.id && r.phaseOrder && (r.status === "new" || r.status === "running"));
  const fail = (e: unknown) => setError(String((e as { code?: string })?.code ?? e));
  const closed = isClosed(plan);
  return (
    <div className="phase-bar status-bar">
      <div className="chips">
        <b className="small">Status</b>
        <button className={!closed ? "chip on" : "chip"} disabled={!closed} onClick={() => setPlanStatus(plan.id, "open").catch(fail)}>Open</button>
        <button className={closed ? "chip on" : "chip"} disabled={closed} onClick={() => setPlanStatus(plan.id, "closed").catch(fail)}>Closed</button>
        <span className="small muted">a label only: nothing on the plan stops</span>
      </div>
      <div className="chips">
        <b className="small">Phase</b>
        {PHASES.map((p, i) => (
          <button key={p.id} className={p.id === now ? "chip on" : "chip"} disabled={going || p.id === now} title={p.means}
            onClick={() => sendPhaseOrder(plan, phasePrompt(p.id), phaseOrder(p.id)).catch(fail)}>
            {p.id === now ? p.name : i < at ? `Back to ${p.name}` : `Move to ${p.name}`}
          </button>
        ))}
        {going && <span className="small muted">Order sent</span>}
      </div>
      <p className="small muted">{phaseName(now)}: {PHASES[at]?.means}</p>
      {error && <p className="bad small">{error}</p>}
    </div>
  );
}

// The board of every plan by phase (the owner's choice, 2026-11-09, "Both"): five columns, one card per plan with its
// status; Close or Reopen on the card, a click on the card opens the plan.
export function PlanBoard({ plans, items, picked, onPick }: { plans: Plan[]; items: InboxItem[]; picked?: string; onPick: (id: string) => void }) {
  const [error, setError] = useState("");
  const fail = (e: unknown) => setError(String((e as { code?: string })?.code ?? e));
  const open = plans.filter((p) => !isClosed(p)).length;
  return (
    <Section id="plans.board" title={`Board: ${plans.length} plans, ${open} open, ${plans.length - open} closed`}>
      <div className="board">
        {PHASES.map((ph) => {
          const col = plans.filter((p) => phaseOf(p) === ph.id);
          return (
            <div key={ph.id} className="board-col">
              <div className="board-head" title={ph.means}>{ph.name} <span className="muted">{col.length}</span></div>
              {col.map((p) => {
                const waiting = items.filter((i) => i.planId === p.id && isWaiting(i)).length;
                return (
                  <div key={p.id} className={(p.id === picked ? "board-card on" : "board-card") + (isClosed(p) ? " closed" : "")} onClick={() => onPick(p.id)}>
                    <div className="small">{p.title}</div>
                    <div className="small muted">
                      <span className={isClosed(p) ? "pill closed" : "pill open"}>{isClosed(p) ? "Closed" : "Open"}</span> v{p.current}
                      {waiting > 0 && <span className="wait-fg"> · {waiting} waiting</span>}
                    </div>
                    <button className="chip" onClick={(e) => (e.stopPropagation(), setPlanStatus(p.id, isClosed(p) ? "open" : "closed").catch(fail))}>
                      {isClosed(p) ? "Reopen" : "Close"}
                    </button>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      {error && <p className="bad small">{error}</p>}
    </Section>
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
        Plan · v{plan.current} · {isClosed(plan) ? "closed" : "open"} · {plan.workType} · updated {when(plan.updatedAt)}
        <br />
        from session: {session?.title ?? plan.sessionId}
        {/* the close note is shown only while the plan is closed: a reopened plan keeps it stored, unshown (i1) */}
        {isClosed(plan) && plan.closeNote && (
          <>
            <br />
            closed: {plan.closeNote}
          </>
        )}
        {plan.upgradedTo && (
          <>
            <br />
            <a href={`/?plan=${plan.upgradedTo}`}>Open the plan in the latest format</a>
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
      <StatusBar plan={plan} runs={runs} />
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
