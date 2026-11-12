import { useEffect, useRef, useState } from "react";
import {
  PLAN_KINDS, runAllSteps, runStep, sendPlanMessage, stopChain, useHarness, usePlanChain, usePlanSteps,
  type InboxItem, type Parts, type Plan, type PlanGenerated, type PlanKind, type PlanStep, type PlanVersion, type Run,
} from "./data";
import { isWaiting } from "./Inbox";
import { openFile, PcText } from "./FileView";
import { askAbout, forPlan, QUOTE_EVENT, quotePart, quoteStep, takeQuote } from "./quote";
import { staleMark, staleness, versionAt } from "./planStale";
import { usePlanGenerated } from "./data";
import { Md } from "./Markdown";
import { Example } from "./Example";
import { MoreMenu } from "./MoreMenu";
import { diffLines, linkEntries, PART_NAMES, partLines } from "./planDiff";
import { phaseName, phaseOf, phaseStarts } from "./phases";
import { HarnessSection } from "./HarnessView";
import { GeneratedSection } from "./GeneratedView";
import { buildNote } from "./harness";
import { RunList, RunWithPicker } from "./Runs";
import type { RunWith } from "./data";
import { Section } from "./Section";
import { Clamp } from "./Clamp";

// A plan with six parts (plan from a session; the owner's words, 2026-11-03, in cc/dashboard/SESSION_PLAN.md).
// Plan versions change only with the plan's data; each step shows its own versions, the last reply like a message.

const KIND_NAME = Object.fromEntries(PLAN_KINDS) as Record<PlanKind, string>;
const HINT: Record<PlanKind, string> = {
  qa: "Ask about the plan. Nothing changes; if a change is needed, the session asks you to switch first.",
  goal: "The new goal. Steps that no longer fit change with it. A new plan version.",
  step: "A step, more work or more tests. A new plan version.",
  rule: "Add, edit or remove a rule. Steps that break it are marked. A new plan version.",
  lesson: "Which lesson to check, and what you doubt. The session answers with proof.",
};
const when = (iso: string) => new Date(iso).toLocaleString();
const PART_LABEL: Record<string, string> = { ...Object.fromEntries(PART_NAMES), cite: "Cite" };
type On = { stepId?: string; part?: string };

function PlanMessage({ plan }: { plan: Plan }) {
  const [kind, setKind] = useState<PlanKind>("qa");
  const [text, setText] = useState("");
  const [w, setW] = useState<RunWith>({});
  const [on, setOn] = useState<On | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    // Ask, Change or Quote on a step or a part, or "Ask about this" on selected words (quote.ts): the quote lands here
    const fill = () => {
      const q = takeQuote(forPlan(plan.id));
      if (!q) return;
      if (q.kind) setKind(q.kind);
      setOn(q.stepId || q.part ? { stepId: q.stepId, part: q.part } : null);
      setText((t) => (t.trim() ? t.trimEnd() + "\n\n" : "") + q.text + "\n\n");
      setError("");
      setTimeout(() => {
        const el = box.current;
        if (!el) return;
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }, 0);
    };
    fill(); // a quote made on another tab, waiting for this plan's box
    window.addEventListener(QUOTE_EVENT, fill);
    return () => window.removeEventListener(QUOTE_EVENT, fill);
  }, [plan.id]);
  async function send() {
    if (!text.trim()) return setError("Write a message first.");
    setBusy(true);
    try {
      await sendPlanMessage(plan, kind, text.trim(), on ?? undefined, w);
      setText("");
      setOn(null);
    } catch (e) {
      setError(String((e as { code?: string }).code ?? e));
    }
    setBusy(false);
  }
  return (
    <Section id="plan.message" title="Send a message on this plan">
      <div className="part-kinds">
        {PLAN_KINDS.map(([k, name]) => (
          <button key={k} className={kind === k ? "chip on" : "chip"} onClick={() => setKind(k)}>{name}</button>
        ))}
      </div>
      <textarea ref={box} rows={3} value={text} placeholder={HINT[kind]} onChange={(e) => (setText(e.target.value), setError(""))} />
      {on && (
        <p className="small muted">
          on {on.stepId ? `step ${on.stepId}` : `part ${PART_LABEL[on.part ?? ""] ?? on.part}`}: the reply shows there{" "}
          <button className="link" onClick={() => setOn(null)}>clear</button>
        </p>
      )}
      {error && <p className="bad small">{error}</p>}
      <p className="muted small">It goes to the plan's session with the same wait rule as any message.</p>
      <RunWithPicker value={w} onChange={setW} fresh />{" "}
      <button className="primary" disabled={busy} onClick={send}>Send as {KIND_NAME[kind]}</button>
    </Section>
  );
}

// Ask (Q&A), Change (a step message) or Quote on one step: the step goes quoted into the message box (quote.ts).
function StepActions({ step }: { step: Parts["steps"][number] }) {
  const q = quoteStep(step);
  return (
    <span className="step-actions">
      <button className="chip second" title="Ask about this step: Q&A, nothing changes" onClick={() => askAbout({ text: q, kind: "qa", stepId: step.id })}>Ask</button>
      <button className="chip second" title="Change this step: a new plan version" onClick={() => askAbout({ text: q, kind: "step", stepId: step.id })}>Change</button>
      <button className="chip second" title="Put this step, quoted, in the message box" onClick={() => askAbout({ text: q, stepId: step.id })}>Quote</button>
    </span>
  );
}

// Ask or Quote on a part's header.
function PartActions({ k, name, lines }: { k: string; name: string; lines: string[] }) {
  const q = quotePart(name, lines);
  return (
    <span className="step-actions">
      <button className="chip second" title="Ask about this part: Q&A, nothing changes" onClick={() => askAbout({ text: q, kind: "qa", part: k })}>Ask</button>
      <button className="chip second" title="Put this part, quoted, in the message box" onClick={() => askAbout({ text: q, part: k })}>Quote</button>
    </span>
  );
}

// The messages asked on one step or part, with the session's reply read whole from the PC.
function OnMessages({ runs, plan, where }: { runs: Run[]; plan: Plan; where: On }) {
  const list = runs
    .filter((r) => r.planId === plan.id && r.kind && (where.stepId ? r.stepId === where.stepId : r.part === where.part))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (list.length === 0) return null;
  return (
    <div className="on-msgs">
      {/* the owner's pick, 2026-11-12, "Both": each message folds to its header, the newest starts open, and its
          text and reply show 4 lines, then Show more */}
      {list.map((r, i) => (
        <Section key={r.id} id={`plan.msg.${r.id}`} open={i === list.length - 1}
          title={<>{KIND_NAME[r.kind!]} · {when(r.createdAt)} · <span className={"status " + r.status}>{r.status}</span></>}>
          <Clamp><Md text={r.ownerText ?? r.prompt ?? ""} cwd={plan.cwd} /></Clamp>
          {(r.status === "done" || r.status === "lost") && (
            <>
              <p className="label">Reply</p>
              <Clamp><PcText run={r.id} cwd={plan.cwd} /></Clamp>
            </>
          )}
        </Section>
      ))}
    </div>
  );
}

// 7. Results: one card per step run, newest first, grouped by the plan version that was current when it ran (the
// owner's words, 2026-11-10: "where I can see the result of each build or step?"; the pick: "7. Results, one card per
// run"): step, state, when, the session's reply read whole from the PC, the files approved for that version.
function ResultsSection({ plan, v, versions, runs, steps, generated, stale }: {
  plan: Plan; v: PlanVersion; versions: PlanVersion[]; runs: Run[]; steps: PlanStep[]; generated: PlanGenerated | null; stale?: string;
}) {
  const list = runs
    .filter((r) => r.planId === plan.id && r.stepId && !r.kind && r.action === "message")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const title = (id: string) => v.parts?.steps.find((s) => s.id === id)?.title ?? "";
  const report = (r: Run) => {
    const sv = steps.find((s) => s.stepId === r.stepId);
    const after = (sv?.versions ?? []).filter((x) => x.at >= (r.startedAt ?? r.createdAt));
    return after[0];
  };
  const groups = new Map<number, Run[]>();
  for (const r of list) {
    const n = versionAt(versions, r.createdAt);
    groups.set(n, [...(groups.get(n) ?? []), r]);
  }
  return (
    <Section id="plan.part.results" title="7. Results" extra={list.length ? `${list.length} step runs` : "none yet"} stale={stale}>
      {list.length === 0 && <p className="muted small">No step has run yet. Run step on a step in Build, and its result lands here.</p>}
      {[...groups.entries()].sort((a, b) => b[0] - a[0]).map(([n, rs]) => (
        <div key={n}>
          <p className="small muted">on v{n}{n === plan.current ? " · current" : ""}</p>
          {rs.map((r) => {
            const rep = report(r);
            const newest = r.id === list[0].id; // the owner's pick, 2026-11-12, "Both": only the newest card starts open
            const files = generated?.versions?.[`v${n}`] ?? [];
            const st = v.parts?.steps.find((s) => s.id === r.stepId);
            return (
              <Section key={r.id} id={`plan.result.${r.id}`} open={newest}
                title={<span className="result-head">
                  <span className={"status " + (rep?.state ?? r.status)}>{rep?.state ?? r.status}</span>
                  <b>{r.stepId} · {title(r.stepId!) || "step no longer in this version"}</b>
                  <span className="small muted">ran {when(r.startedAt ?? r.createdAt)}{r.endedAt ? ` → ${when(r.endedAt)}` : ""}</span>
                </span>}>
                {st && <p className="small muted">check: {st.check}{rep ? ` → ${rep.state === "done" ? "met, by the session's report" : rep.state}` : " → no report yet"}</p>}
                {(r.status === "done" || r.status === "lost") && (
                  <>
                    <p className="label">Reply</p>
                    <Clamp><PcText run={r.id} cwd={plan.cwd} /></Clamp>
                  </>
                )}
                {r.status !== "done" && r.status !== "lost" && r.error && <p className="bad small">{r.error}</p>}
                <p className="small muted">
                  files approved for v{n}: {files.length ? files.map((f) => <code key={f.file} className="file-link" role="button" onClick={() => openFile(f.file, plan.cwd)}>{f.file.split(/[\\/]/).pop()}</code>).reduce<React.ReactNode[]>((a, x, i) => (i ? [...a, " · ", x] : [x]), []) : "none"}
                </p>
              </Section>
            );
          })}
        </div>
      ))}
    </Section>
  );
}

function RunStep({ plan, step, runs, harness }: { plan: Plan; step: Parts["steps"][number]; runs: Run[]; harness: string }) {
  const [error, setError] = useState("");
  const [w, setW] = useState<RunWith>({});
  const going = runs.some((r) => r.planId === plan.id && r.stepId === step.id && (r.status === "new" || r.status === "running"));
  const explore = phaseOf(plan) === "explore"; // no step runs before the owner moves the plan to Build
  return (
    <>
      <button className="chip primary" disabled={going || explore} title={explore ? "Off in Explore: move the plan to Build first" : undefined} onClick={() => runStep(plan, step, harness, w).catch((e) => setError(String(e?.code ?? e)))}>
        {going ? "Running" : "Run step"}
      </button>
      {!explore && <RunWithPicker value={w} onChange={setW} compact fresh />}
      {error && <span className="bad small"> {error}</span>}
    </>
  );
}

// 8. Decisions (the owner's words, 2026-11-10: "I see the missing in images and artifacts after I approved, no where to
// found them so make approved section so something similar so I can see what decisions have been made"): every answered
// question of the plan by round, the option picked with its drawing, image or draft, the owner's note, the version it
// made, and the other options folded.
function DecisionsSection({ plan, versions, asked, onOpenItem }: {
  plan: Plan; versions: PlanVersion[]; asked: InboxItem[]; onOpenItem: (id: string) => void;
}) {
  const qs = asked.filter((q) => q.kind === "question" || q.kind === "suggestion" || q.kind === "result")
    .sort((a, b) => (a.round ?? 0) - (b.round ?? 0) || a.createdAt.localeCompare(b.createdAt));
  const answered = qs.filter((q) => q.answer);
  const rounds = [...new Set(qs.map((q) => q.round ?? 0))];
  const madeIn = (q: InboxItem) => versions.find((v) => v.madeBy?.some((d) => d.id === q.id || (d.title === q.title && d.choice === q.answer?.choice)))?.n;
  return (
    <Section id="plan.part.decisions" title="8. Decisions" extra={`${answered.length} decided · ${qs.length - answered.length} waiting`}>
      {qs.length === 0 && <p className="muted small">No question asked on this plan yet.</p>}
      {rounds.map((r) => (
        <div key={r}>
          <h3 className="small muted">{r ? `Round on v${r}` : "Before v1"}</h3>
          {qs.filter((q) => (q.round ?? 0) === r).map((q) => {
            const picked = q.answer ? (q.multi ? q.answer.choice.split(", ") : [q.answer.choice]) : [];
            const chosen = q.options.filter((o) => picked.includes(o.label));
            const others = q.options.filter((o) => !picked.includes(o.label));
            const made = q.answer ? madeIn(q) : undefined;
            return (
              <div key={q.id} className="decision">
                <p>
                  <button className="link" onClick={() => onOpenItem(q.id)}>{q.title}</button>{" "}
                  {q.answer
                    ? <span className="status done">{q.answer.choice}{made ? ` · made v${made}` : ""} · {new Date(q.answer.at).toLocaleString()}</span>
                    : <span className="status waiting">waiting for you</span>}
                </p>
                {q.answer?.text && <p className="small">Your note: {q.answer.text}</p>}
                {q.history?.length ? <p className="small muted">Earlier: {q.history.map((h) => h.choice).join(" → ")}</p> : null}
                {chosen.map((o) => (
                  <div key={o.label} className="decision-pick">
                    {o.detail && <p className="small muted">{o.detail}</p>}
                    <KeptExample q={q} o={o} cwd={q.cwd || plan.cwd} />
                  </div>
                ))}
                {q.answer && !chosen.length && <p className="small muted">Your own answer: no option of the list.</p>}
                {q.answer && others.length > 0 && (
                  <Section id="plan.decision.others" title={`Not picked (${others.length})`} open={false}>
                    {others.map((o) => (
                      <div key={o.label} className="decision-pick">
                        <p className="small"><b>{o.label}</b>{o.detail ? ` · ${o.detail}` : ""}</p>
                        <KeptExample q={q} o={o} cwd={q.cwd || plan.cwd} />
                      </div>
                    ))}
                  </Section>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </Section>
  );
}

// An option's example as kept at the answer: image files from the snapshot copy in the plan folder (bridge
// snapshot.py), so a later file with the same name never replaces the picture decided on. A source written after the
// answer, or missing, is marked on the card.
function KeptExample({ q, o, cwd }: { q: InboxItem; o: InboxItem["options"][number]; cwd: string }) {
  const e = o.example;
  if (!e) return null;
  if (e.type !== "image") return <Example e={e} cwd={cwd} />;
  const kept = q.snapshot?.files?.[o.label];
  const shown = kept ? { ...e, before: kept.before ?? e.before, after: kept.after ?? e.after } : e;
  const changed = [e.before, e.after].filter((f) => q.snapshot?.changed?.includes(f));
  const missing = [e.before, e.after].filter((f) => q.snapshot?.missing?.includes(f));
  return (
    <>
      <Example e={shown} cwd={cwd} />
      {!q.snapshot && q.answer && <p className="small wait-fg">Not kept yet: shows the file as it is now (the bridge keeps a copy when it sees the answer).</p>}
      {changed.length > 0 && <p className="small bad">⚠ Written after your answer, so this copy may not be the picture you decided on: {changed.join(", ")}</p>}
      {missing.length > 0 && <p className="small bad">⚠ Missing on the PC at the answer: {missing.join(", ")}</p>}
      {q.snapshot?.pointed && <p className="small muted">✓ Pointed to {q.snapshot.pointed.to.split(/[\\/]/).pop()} on your word ({new Date(q.snapshot.pointed.at).toLocaleString()})</p>}
      {kept && !q.snapshot?.pointed && !changed.length && !missing.length && <p className="small muted">✓ Kept as at your answer ({new Date(q.snapshot!.at).toLocaleString()})</p>}
    </>
  );
}

// Run all steps: one press; the bridge runs the steps not done in order and stops on a fail (bridge chain.py).
function RunAll({ plan, steps, total }: { plan: Plan; steps: PlanStep[]; total: number }) {
  const chain = usePlanChain(plan.id);
  const [error, setError] = useState("");
  const [w, setW] = useState<RunWith>({});
  if (phaseOf(plan) === "explore") return null;
  const on = chain?.state === "on";
  const done = steps.filter((x) => x.state === "done").length;
  return (
    <div className="run-all">
      {on ? (
        <button className="danger" onClick={() => stopChain(plan.id).catch((e) => setError(String(e?.code ?? e)))}>Stop run all</button>
      ) : (
        <button className="primary" disabled={done >= total} title={done >= total ? "Every step is done; rerun one by hand" : undefined}
          onClick={() => runAllSteps(plan, w).catch((e) => setError(String(e?.code ?? e)))}>
          Run all steps ({total - done} not done)
        </button>
      )}
      {!on && <RunWithPicker value={w} onChange={setW} compact fresh />}
      {chain && (
        <span className={"status " + (on ? "running" : chain.state === "done" ? "done" : "failed")}>
          {on ? `running ${chain.stepId ?? "…"}${chain.left ? ` · ${chain.left} left` : ""}` : chain.state === "done" ? `all done · ${chain.reason ?? ""}` : `stopped · ${chain.reason ?? ""}`}
        </span>
      )}
      {error && <span className="bad small"> {error}</span>}
    </div>
  );
}

function DiffBlock({ a, b }: { a: string[]; b: string[] }) {
  const d = diffLines(a, b);
  if (!d.some((x) => x.op !== "same")) return <p className="muted small">No change.</p>;
  return (
    <pre className="ex-diff diff">
      {d.map((x, i) => (
        <div key={i} className={x.op === "same" ? "" : x.op}>{(x.op === "add" ? "+ " : x.op === "del" ? "- " : "  ") + x.text}</div>
      ))}
    </pre>
  );
}

function Part({ k, parts, before, plan }: { k: keyof Parts; parts: Parts; before?: Parts; plan: Plan }) {
  if (before) return <DiffBlock a={partLines(before, k)} b={partLines(parts, k)} />;
  const md = (t: string) => <Md text={linkEntries(t, plan)} cwd={plan.cwd} />;
  switch (k) {
    case "goal":
    case "summary":
    case "cite":
      return md(parts[k] ?? "");
    case "rules":
      return (
        <table>
          <thead><tr><th>Rule</th><th>Source</th></tr></thead>
          <tbody>{parts.rules.map((r, i) => <tr key={i}><td>{md(r.rule)}</td><td className="small">{md(r.source)}</td></tr>)}</tbody>
        </table>
      );
    case "lessons":
      return (
        <table>
          <thead><tr><th>Lesson</th><th>Taught by</th><th>Applied in</th></tr></thead>
          <tbody>
            {parts.lessons.map((l, i) => (
              <tr key={i}><td>{md(l.lesson)}</td><td className="small">{md(l.taughtBy)}</td><td className="small">{md(l.appliedIn)}</td></tr>
            ))}
          </tbody>
        </table>
      );
    case "leftover":
      return md(parts.leftover.map((x) => `- ${x}`).join("\n") || "none");
    case "steps":
      return null; // the steps list below shows them with their states
  }
}

export function PartsView({ plan, versions, items, runs, onOpenItem }: {
  plan: Plan; versions: PlanVersion[]; items: InboxItem[]; runs: Run[]; onOpenItem: (id: string) => void;
}) {
  const steps = usePlanSteps(plan.id) ?? [];
  const ticks = useHarness(plan.id);
  const generated = usePlanGenerated(plan.id);
  const [checked, setChecked] = useState<string | null>(null); // when Check plan was pressed
  const harnessNote = buildNote(versions.find((x) => x.n === plan.current)?.harness, ticks);
  const withParts = versions.filter((v) => v.parts).sort((a, b) => a.n - b.n);
  const [picked, setPicked] = useState<number | null>(null);
  const [diff, setDiff] = useState(false);
  const v = withParts.find((x) => x.n === picked) ?? withParts[withParts.length - 1];
  if (!v?.parts) return <p className="muted">The plan's first version is still being written.</p>;
  const parent = withParts.find((x) => x.n === (v.parent ?? v.n - 1));
  const before = diff ? parent?.parts : undefined;
  const asked = items.filter((i) => i.planId === plan.id);
  const msgs = runs.filter((r) => r.planId === plan.id || (r.action === "plan" && r.id === plan.source?.commandId));
  const root = useRef<HTMLDivElement>(null);
  const stale = staleness(plan, versions, ticks, generated, steps, runs);
  const behind = stale.filter((r) => !r.ok).length;
  return (
    <div ref={root} data-quote-plan={plan.id}>
      <div className="chips">
        {withParts.map((x) => {
          const starts = phaseStarts(withParts).get(x.n);
          return (
            <span key={x.n} className="chip-group">
              {starts && <span className="phase-div small">{phaseName(starts)}</span>}
              <button className={x.n === v.n ? "chip on" : "chip"} onClick={() => setPicked(x.n)}>
                v{x.n}{x.n === plan.current ? " · current" : ""}
              </button>
            </span>
          );
        })}
        {parent?.parts && (
          <button className={diff ? "chip on" : "chip"} onClick={() => setDiff(!diff)}>Changes from v{parent.n}</button>
        )}
        <button className="chip primary" onClick={() => setChecked(new Date().toLocaleTimeString())} title="Does every section follow the current version?">
          Check plan{behind ? ` · ${behind} behind` : ""}
        </button>
      </div>
      {checked && (
        // the owner's pick, 2026-11-10: "Both": the list with the fix per line, and a mark on each section header
        <ul className="check-list">
          {stale.map((r) => (
            <li key={r.section}>
              <span className={"dot " + (r.ok ? "ok" : "stale")} />
              <span className="small"><b>{r.section}</b>: {r.note}{r.fix ? <> → {r.fix}</> : null}</span>
            </li>
          ))}
          <li><span className="small muted">checked {checked} against v{v.n}; the marks on the section headers show the same live</span></li>
        </ul>
      )}
      <p className="change-note small">
        v{v.n} · {when(v.createdAt)} · {v.change ? <b>{KIND_NAME[v.change.kind]}</b> : null}
        {v.change ? `: ${v.change.message}` : v.note} <MoreMenu path={`planVersions/${plan.id}_v${v.n}`} />
      </p>

      <HarnessSection plan={plan} v={v} parent={parent} stale={staleMark(stale, "harness")} />

      {PART_NAMES.filter(([k]) => k !== "steps").map(([k, name]) => (
        <Section key={k} id={`plan.part.${k}`} title={name} tools={<PartActions k={k} name={name} lines={partLines(v.parts!, k)} />}>
          <div data-part={k}>
            <Part k={k} parts={v.parts!} before={before} plan={plan} />
          </div>
          <OnMessages runs={runs} plan={plan} where={{ part: k }} />
        </Section>
      ))}

      <Section id="plan.part.steps" title="6. Steps" extra={`${v.parts.steps.length} steps`} stale={staleMark(stale, "results")}>
        {before && <DiffBlock a={partLines(before, "steps")} b={partLines(v.parts, "steps")} />}
        {!before && v.n === plan.current && (
          <RunAll plan={plan} total={v.parts.steps.length}
            steps={steps.filter((x) => v.parts!.steps.some((st) => st.id === x.stepId))} />
        )}
        {v.parts.steps.map((st) => {
          const sv = steps.find((x) => x.stepId === st.id);
          const last = sv?.versions[sv.versions.length - 1];
          const qs = asked.filter((i) => i.stepId === st.id);
          return (
            // the owner's pick, 2026-11-12, "All folded": every step starts folded to its header line
            <Section key={st.id} id={`plan.step.${plan.id}.${st.id}`} open={false}
              title={<span data-step={st.id}>
                <span className={"step-state " + (sv?.state ?? "next")}>{sv?.state ?? "next"}</span>
                <b>{st.id} · {st.title}</b>{st.new && <span className="tag" title="Work the session's record does not hold">new</span>}
              </span>}
              tools={<span className="step-tools">
                <RunStep plan={plan} step={st} runs={runs} harness={harnessNote} />
                <StepActions step={st} />
                {sv && <MoreMenu path={`planSteps/${plan.id}_${st.id}`} />}
              </span>}>
              <div className="step-row" data-step={st.id}>
              <Md text={linkEntries(`${st.does}\n\n**Check:** ${st.check}`, plan)} cwd={plan.cwd} />
              <OnMessages runs={runs} plan={plan} where={{ stepId: st.id }} />
              {last && (
                <Section id={`plan.step.last.${plan.id}.${st.id}`} title={`Last reply · step version ${last.n}`} extra={when(last.at)}>
                  <Clamp><Md text={last.reply} cwd={plan.cwd} /></Clamp>
                </Section>
              )}
              {sv && sv.versions.length > 1 && (
                <Section id={`plan.step.older.${plan.id}.${st.id}`} title="Older step versions" extra={sv.versions.length - 1} open={false}>
                  {sv.versions.slice(0, -1).reverse().map((x) => (
                    <div key={x.n}>
                      <p className="small muted">step version {x.n} · {x.state} · {when(x.at)} · on plan v{x.planVersion}</p>
                      <Clamp><Md text={x.reply} cwd={plan.cwd} /></Clamp>
                    </div>
                  ))}
                </Section>
              )}
              {qs.map((q) => (
                <p key={q.id} className="small">
                  <button className="link" onClick={() => onOpenItem(q.id)}>{q.title}</button>{" "}
                  <span className={isWaiting(q) ? "wait-fg" : "muted"}>{isWaiting(q) ? "waiting for you" : q.answer?.choice ?? q.status}</span>
                </p>
              ))}
              </div>
            </Section>
          );
        })}
      </Section>

      <ResultsSection plan={plan} v={v} versions={versions} runs={runs} steps={steps} generated={generated} stale={staleMark(stale, "results")} />

      <DecisionsSection plan={plan} versions={versions} asked={asked} onOpenItem={onOpenItem} />

      {(v.parts.cite || before?.cite) && (
        // the owner's words, 2026-11-05: "move what the plan read ... out into the cite section like generated section"
        <Section id="plan.part.cite" title="Cite" extra="your words this plan reads" open={false}
          tools={<PartActions k="cite" name="Cite" lines={partLines(v.parts!, "cite")} />}>
          <div data-part="cite">
            <Part k="cite" parts={v.parts} before={before} plan={plan} />
          </div>
          <OnMessages runs={runs} plan={plan} where={{ part: "cite" }} />
        </Section>
      )}

      <GeneratedSection plan={plan} v={v} stale={staleMark(stale, "generated")} />

      <PlanMessage plan={plan} />
      {msgs.length > 0 && <RunList runs={msgs} title="Messages on this plan" />}

      {plan.source && (
        <Section id="plan.source" title="Read from" extra={`session ${plan.source.sessionId.slice(0, 8)} · ${plan.source.pages.length} pages`} open={false}>
          <ul>
            {plan.source.pages.map((p) => (
              <li key={p.file}>
                <code className="file-link" role="button" onClick={() => openFile(p.file, plan.source!.pagesDir)}>{p.file}</code>{" "}
                <span className="muted small">entries #{p.first} to #{p.last}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
