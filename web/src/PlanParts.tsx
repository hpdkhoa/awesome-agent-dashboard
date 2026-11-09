import { useEffect, useRef, useState } from "react";
import {
  PLAN_KINDS, runStep, sendPlanMessage, useHarness, usePlanSteps,
  type InboxItem, type Parts, type Plan, type PlanKind, type PlanVersion, type Run,
} from "./data";
import { isWaiting } from "./Inbox";
import { openFile, PcText } from "./FileView";
import { askAbout, QUOTE_EVENT, quotePart, quoteStep, quoteWords, type QuoteAsk } from "./quote";
import { Md } from "./Markdown";
import { MoreMenu } from "./MoreMenu";
import { diffLines, linkEntries, PART_NAMES, partLines } from "./planDiff";
import { phaseName, phaseOf, phaseStarts } from "./phases";
import { HarnessSection } from "./HarnessView";
import { GeneratedSection } from "./GeneratedView";
import { buildNote } from "./harness";
import { RunList } from "./Runs";
import { Section } from "./Section";

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
  const [on, setOn] = useState<On | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    // Ask, Change or Quote on a step or a part, or "Ask about this" on selected words (quote.ts): the quote lands here
    const fill = (e: Event) => {
      const q = (e as CustomEvent<QuoteAsk>).detail;
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
    window.addEventListener(QUOTE_EVENT, fill);
    return () => window.removeEventListener(QUOTE_EVENT, fill);
  }, []);
  async function send() {
    if (!text.trim()) return setError("Write a message first.");
    setBusy(true);
    try {
      await sendPlanMessage(plan, kind, text.trim(), on ?? undefined);
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
      {list.map((r) => (
        <div key={r.id} className="on-msg">
          <p className="small muted">
            {KIND_NAME[r.kind!]} · {when(r.createdAt)} · <span className={"status " + r.status}>{r.status}</span>
          </p>
          <Md text={r.ownerText ?? r.prompt ?? ""} cwd={plan.cwd} />
          {(r.status === "done" || r.status === "lost") && (
            <>
              <p className="label">Reply</p>
              <PcText run={r.id} cwd={plan.cwd} />
            </>
          )}
        </div>
      ))}
    </div>
  );
}

// Select words anywhere in the plan: a small "Ask about this" button appears at the selection and quotes just them.
function SelectAsk({ root }: { root: React.RefObject<HTMLDivElement | null> }) {
  const [at, setAt] = useState<{ x: number; y: number; text: string; stepId?: string; part?: string } | null>(null);
  useEffect(() => {
    const look = () => {
      const sel = document.getSelection();
      const text = sel?.toString().trim() ?? "";
      if (!sel || !text || sel.rangeCount === 0 || !root.current) return setAt(null);
      const range = sel.getRangeAt(0);
      const node = range.commonAncestorContainer;
      const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
      if (!el || !root.current.contains(el) || el.closest("textarea, .on-msgs, .float-ask")) return setAt(null);
      const rect = range.getBoundingClientRect();
      const host = el.closest<HTMLElement>("[data-step],[data-part]");
      setAt({ x: rect.left + rect.width / 2, y: Math.max(8, rect.top - 34), text, stepId: host?.dataset.step, part: host?.dataset.part });
    };
    document.addEventListener("selectionchange", look);
    document.addEventListener("mouseup", look);
    window.addEventListener("scroll", look, true);
    return () => {
      document.removeEventListener("selectionchange", look);
      document.removeEventListener("mouseup", look);
      window.removeEventListener("scroll", look, true);
    };
  }, [root]);
  if (!at) return null;
  return (
    <button
      className="float-ask"
      style={{ left: at.x, top: at.y }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        askAbout({ text: quoteWords(at.text), kind: "qa", stepId: at.stepId, part: at.part });
        document.getSelection()?.removeAllRanges();
        setAt(null);
      }}
    >
      Ask about this
    </button>
  );
}

function RunStep({ plan, step, runs, harness }: { plan: Plan; step: Parts["steps"][number]; runs: Run[]; harness: string }) {
  const [error, setError] = useState("");
  const going = runs.some((r) => r.planId === plan.id && r.stepId === step.id && (r.status === "new" || r.status === "running"));
  const explore = phaseOf(plan) === "explore"; // no step runs before the owner moves the plan to Build
  return (
    <>
      <button className="chip primary" disabled={going || explore} title={explore ? "Off in Explore: move the plan to Build first" : undefined} onClick={() => runStep(plan, step, harness).catch((e) => setError(String(e?.code ?? e)))}>
        {going ? "Running" : "Run step"}
      </button>
      {error && <span className="bad small"> {error}</span>}
    </>
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
  return (
    <div ref={root}>
      <SelectAsk root={root} />
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
      </div>
      <p className="change-note small">
        v{v.n} · {when(v.createdAt)} · {v.change ? <b>{KIND_NAME[v.change.kind]}</b> : null}
        {v.change ? `: ${v.change.message}` : v.note} <MoreMenu path={`planVersions/${plan.id}_v${v.n}`} />
      </p>

      <HarnessSection plan={plan} v={v} parent={parent} />

      {PART_NAMES.filter(([k]) => k !== "steps").map(([k, name]) => (
        <Section key={k} id={`plan.part.${k}`} title={name} tools={<PartActions k={k} name={name} lines={partLines(v.parts!, k)} />}>
          <div data-part={k}>
            <Part k={k} parts={v.parts!} before={before} plan={plan} />
          </div>
          <OnMessages runs={runs} plan={plan} where={{ part: k }} />
        </Section>
      ))}

      <Section id="plan.part.steps" title="6. Steps" extra={`${v.parts.steps.length} steps`}>
        {before && <DiffBlock a={partLines(before, "steps")} b={partLines(v.parts, "steps")} />}
        {v.parts.steps.map((st) => {
          const sv = steps.find((x) => x.stepId === st.id);
          const last = sv?.versions[sv.versions.length - 1];
          const qs = asked.filter((i) => i.stepId === st.id);
          return (
            <div key={st.id} className="step-row" data-step={st.id}>
              <div>
                <span className={"step-state " + (sv?.state ?? "next")}>{sv?.state ?? "next"}</span>
                <b>{st.id} · {st.title}</b>{st.new && <span className="tag" title="Work the session's record does not hold">new</span>}{" "}
                <RunStep plan={plan} step={st} runs={runs} harness={harnessNote} />
                <StepActions step={st} />
                {sv && <MoreMenu path={`planSteps/${plan.id}_${st.id}`} />}
              </div>
              <Md text={linkEntries(`${st.does}\n\n**Check:** ${st.check}`, plan)} cwd={plan.cwd} />
              <OnMessages runs={runs} plan={plan} where={{ stepId: st.id }} />
              {last && (
                <Section id="plan.step.last" title={`Last reply · step version ${last.n}`} extra={when(last.at)}>
                  <Md text={last.reply} cwd={plan.cwd} />
                </Section>
              )}
              {sv && sv.versions.length > 1 && (
                <Section id="plan.step.older" title="Older step versions" extra={sv.versions.length - 1} open={false}>
                  {sv.versions.slice(0, -1).reverse().map((x) => (
                    <div key={x.n}>
                      <p className="small muted">step version {x.n} · {x.state} · {when(x.at)} · on plan v{x.planVersion}</p>
                      <Md text={x.reply} cwd={plan.cwd} />
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
          );
        })}
      </Section>

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

      <GeneratedSection plan={plan} v={v} />

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
