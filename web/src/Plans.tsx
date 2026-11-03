import { useState } from "react";
import { usePlanVersions, type InboxItem, type Plan, type Run, type Session } from "./data";
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
          </li>
        );
      })}
      {plans.length === 0 && (
        <li className="muted row">No plans yet. A session opens one with plan_start; its questions then group here by round.</li>
      )}
    </ul>
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
      {versions === null && <p className="muted">Loading</p>}
      {versions && view === "parts" && <PartsView plan={plan} versions={versions} items={items} runs={runs} onOpenItem={onOpenItem} />}
      {versions && view === "graph" && <PlanGraph plan={plan} versions={versions} asked={asked} onOpenItem={onOpenItem} />}
      {view === "list" && rounds.map((n) => {
        const v = versions?.find((x) => x.n === n);
        const qs = asked.filter((i) => (i.round ?? 0) === n);
        return (
          <div key={n}>
            {v && (
              <Section id={`plan.v.${n === plan.current ? "latest" : "old"}`} title={`v${n} · ${v.note || "no note"}`} extra={when(v.createdAt)}
                open={n === plan.current}>
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
    </article>
  );
}
