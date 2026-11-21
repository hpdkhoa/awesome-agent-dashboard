import { useEffect, useMemo, useRef, useState } from "react";
import {
  PLAN_KINDS, runAllSteps, runStep, sendPlanMessage, setMaxTogether, setStepPick, stopChain, useHarness, usePlanChain, usePlanPicks, usePlanSteps,
  EFFORTS, exactEffort, exactModel, MODELS, useRunPrefs, type Fresh, type PlanPicks, type StepPick,
  checkTicked, runCheck, saveCheckCommand, tickCheck, useClaims, useStepChecks, type StepCheck,
  type InboxItem, type Parts, type Plan, type PlanGenerated, type PlanKind, type PlanStep, type PlanVersion, type Run,
} from "./data";
import { isWaiting } from "./Inbox";
import { LocalImg, openFile, PcText } from "./FileView";
import { askAbout, forPlan, QUOTE_EVENT, quotePart, quoteStep, takeQuote } from "./quote";
import { staleMark, staleness, versionAt } from "./planStale";
import { newestFirst, PAGE, usePlanGenerated } from "./data";
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
import { FoldAll, Section } from "./Section";
import { Clamp } from "./Clamp";
import { ReceiptBox, ReceiptChip } from "./Receipt";
import { ClaimChip, ClaimLine } from "./ClaimChip";
import { usePhone } from "./phone";
import { StepEvidenceCard } from "./EvidenceView";
import { keyNumber, openItems, sortCheck, sortReply, type Item, type Sorted } from "./reportSort";
import { useStepEvidence, type Material, type StepEvidence, type StepReport } from "./data";
import { dt, tm } from "./fmt";
import { boardMaterials, gathered } from "./materials";
import { SrcLine, type SrcCtx } from "./SourceChip";
import { CoverageBar } from "./Coverage";
import { Chunks, GlanceTest, RulesBox } from "./BoardRules";
import { saveBoardSeen, useBoardSeen } from "./data";

// A plan with six parts (plan from a session; the owner's words, 2026-11-03, in cc/dashboard/SESSION_PLAN.md).
// Plan versions change only with the plan's data; each step shows its own versions, the last reply like a message.

const KIND_NAME = Object.fromEntries(PLAN_KINDS) as Record<PlanKind, string>;
const HINT: Record<PlanKind, string> = {
  qa: "Ask about the plan. Nothing changes; if a change is needed, the session asks you to switch first.",
  goal: "The new goal. Steps that no longer fit change with it. A new plan version.",
  step: "A step, more work or more tests. A new plan version.",
  rule: "Add, edit or remove a rule. Steps that break it are marked. A new plan version.",
  lesson: "Which lesson to check, and what you doubt. The session answers with proof.",
  action: "The work to do: files, commands, fixes. The session does it, asks first for anything outside the plan, reports what it did. No plan version.",
};
const when = (iso: string) => dt(iso);
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
  // newest first, the newest open (the owner's words, 2026-11-14: "ordering from latest to older")
  const all = newestFirst(runs.filter((r) => r.planId === plan.id && r.kind && (where.stepId ? r.stepId === where.stepId : r.part === where.part)), "createdAt");
  // the newest 10, the rest behind Show more (the owner's words, 2026-11-14: "newest and top 10, the rest show in show more")
  const [count, setCount] = useState(PAGE);
  const list = all.slice(0, count);
  if (all.length === 0) return null;
  return (
    <div className="on-msgs">
      {/* the owner's pick, 2026-11-12, "Both": each message folds to its header, the newest starts open, and its
          text and reply show 4 lines, then Show more */}
      {list.map((r, i) => (
        <Section key={r.id} id={`plan.msg.${r.id}`} open={i === 0}
          title={<>{KIND_NAME[r.kind!]} · {when(r.createdAt)} · <span className={"status " + r.status}>{r.status}</span></>}>
          <Clamp><Md text={r.ownerText ?? r.prompt ?? ""} cwd={plan.cwd} /></Clamp>
          {(r.status === "done" || r.status === "lost") && (
            <Section id="plan.msg.reply" title="Reply">
              <Clamp><PcText run={r.id} cwd={plan.cwd} /></Clamp>
            </Section>
          )}
        </Section>
      ))}
      {list.length < all.length && (
        <button className="link small" onClick={() => setCount(count + PAGE)}>
          Show more ({Math.min(PAGE, all.length - list.length)} older of {all.length - list.length} left)
        </button>
      )}
    </div>
  );
}

// Run reports (the owner's pick, 2026-11-15: "A + exact report fields"; the owner's words: "I don't see the report
// result after run and the shortlist of the result, kind of report about the execution plan, what has been built, the
// benchmarked numbers and the test methods"; "I want better report but not losing data"). A board with one row per step,
// then one card per step: its report fields (exact when the session gave them, else every reply line placed in one
// field, "read from the reply"), its pictures, the full reply, older step versions and every run's reply.
const stepOf = (r: Run) => (r.stepId && !r.kind ? r.stepId : r.answerStep) ?? "";
const lastOf = (sv?: PlanStep) => sv?.versions[sv.versions.length - 1];
const md = (t: string, plan: Plan) => <Md text={linkEntries(t, plan)} cwd={plan.cwd} />;

// The board, the plan's main look (the owner's words, 2026-11-16: "Make this report become the main look where I can
// see what this plan used for (the meaning), the idea, what is the progress (means what is currently build and progress
// compare with the final product of the plan). Not redunant what I can look at the steps section"; "what is done what
// is important not read papers"; pick "Product board, new fields"). What for and Idea come from parts.board, written by
// the session; each product feature is colored live from its steps' states and open items, so it never goes stale.
type FeatureState = "built" | "open" | "doing" | "failed" | "next";
const FEATURE: Record<FeatureState, string> = {
  built: "built, no open item", open: "built, open item", doing: "being built", failed: "failed", next: "not built",
};
// s7 (plan 44fc4979), rule B4 "One cue per meaning", the owner's pick "Amber = needs you only": one colour per state,
// the same on every board part (ui.css [data-state]): done green, doing blue, next grey, failed red, need amber.
// A feature built with an open item waits for the owner, so it takes the needs-you colour.
const STATE_OF: Record<FeatureState, string> = { built: "done", open: "need", doing: "doing", failed: "failed", next: "next" };
// rule B2, the owner's pick "By meaning": features grouped by state, each group headed by what it holds
const FEATURE_HEAD: Record<FeatureState, string> = {
  built: "Features built", open: "Features with open items", doing: "Features being built", failed: "Features failed", next: "Features not built",
};

// The board's materials, grouped (the owner's pick: the recommended three groups); the session sends only the latest
// version of each, and the bridge drops older vN of the same file.
const MATERIAL_GROUPS: [Material["kind"], string][] = [["story", "Stories"], ["material", "Materials"], ["file", "Other files"]];

function featureOf(ids: string[], steps: PlanStep[]) {
  const svs = ids.map((id) => steps.find((x) => x.stepId === id));
  const lasts = svs.map((sv) => lastOf(sv)).filter((x): x is NonNullable<typeof x> => !!x);
  const open = svs.reduce((n, sv) => { const l = lastOf(sv); return n + (l ? openItems(l.reply, l.report).length : 0); }, 0);
  const st = svs.map((sv) => sv?.state ?? "next");
  const state: FeatureState = !ids.length ? "next" : st.includes("failed") ? "failed"
    : st.every((x) => x === "done") ? (open ? "open" : "built") : st.some((x) => x === "done" || x === "now" || x === "checking") ? "doing" : "next";
  const newest = [...lasts].sort((a, b) => b.at.localeCompare(a.at))[0];
  return { state, open, key: newest ? keyNumber(newest.reply, newest.report) : "" };
}

export function ReportBoard({ plan, v, steps, evidence, asked, onOpenItem, stale }: {
  plan: Plan; v: PlanVersion; steps: PlanStep[]; evidence: StepEvidence[]; asked: InboxItem[]; onOpenItem: (id: string) => void; stale?: string;
}) {
  const b = v.parts?.board;
  const rows = v.parts?.steps ?? [];
  const feats = (b?.product ?? []).map((f) => ({ ...f, ...featureOf(f.steps, steps) }));
  const count = (s: FeatureState) => feats.filter((f) => f.state === s).length;
  const order: FeatureState[] = ["built", "open", "doing", "failed", "next"];
  const pct = (n: number) => (feats.length ? Math.round((100 * n) / feats.length) : 0);
  const failed = rows.filter((st) => steps.find((x) => x.stepId === st.id)?.state === "failed");
  const waiting = asked.filter(isWaiting);
  const openTotal = rows.reduce((n, st) => { const l = lastOf(steps.find((x) => x.stepId === st.id)); return n + (l ? openItems(l.reply, l.report).length : 0); }, 0);
  const latest = steps.filter((x) => x.state === "done" || x.state === "failed")
    .map((x) => ({ sv: x, last: lastOf(x)! })).filter((x) => x.last).sort((a, b) => b.last.at.localeCompare(a.last.at))[0];
  const latestPic = latest && evidence.find((e) => e.stepId === latest.sv.stepId)?.sets?.[0]?.pictures[0];
  const title = (id: string) => rows.find((st) => st.id === id)?.title ?? id;
  // the session's list plus the files the reports point to (the owner's pick "Cả hai", 2026-11-17), newest of each
  const mats = b ? boardMaterials(b.materials ?? [], gathered(plan.cwd, steps, evidence, asked)) : [];
  // source chips (plan 44fc4979 s3): What for and Idea name their sources; the other lines take theirs from the data
  const ctx: SrcCtx = { parts: v.parts, steps, cwd: plan.cwd };
  const ideaSrc = b?.src?.idea ?? [];
  const noSrc = b ? (b.src?.whatFor?.length ? 0 : 1) + b.idea.filter((_, i) => !ideaSrc[i]?.length).length : 0;
  // every chip id the board shows (s4 coverage counts what these chips open): What for, Idea, features, materials,
  // Needs you and Latest result
  const boardIds = b ? [...(b.src?.whatFor ?? []), ...ideaSrc.flat(), ...feats.flatMap((f) => f.steps), ...mats.map((m) => m.path ?? "").filter(Boolean),
    ...failed.map((st) => st.id), ...waiting.map((q) => q.stepId ?? "").filter(Boolean), ...(openTotal > 0 ? ["leftover"] : []),
    ...(latest ? [latest.sv.stepId] : []), ...(b.stepCards ?? []).flatMap((c) => [c.step, ...(c.src ?? [])])] : [];
  const reports = rows.filter((st) => (steps.find((x) => x.stepId === st.id)?.versions ?? []).length > 0).map((st) => ({ id: st.id, title: st.title }));
  const stOf = (id: string) => steps.find((x) => x.stepId === id)?.state ?? "next";
  // s8 step cards (the owner's pick "A: step cards For / How / Result"; the owner's words 2026-11-21: "what the step
  // for, how it will do, what is the result or outcome or benefit"): one card per step, For and How from board data,
  // Result from the step's newest report (its first 2 numbers, else its key number), grouped by state in chunks of 4
  const CARD_STATE: Record<string, string> = { done: "done", now: "doing", checking: "doing", failed: "failed", next: "next" };
  const CARD_GROUPS: [string, string][] = [["doing", "Steps running"], ["failed", "Steps failed"], ["next", "Steps not run yet"], ["done", "Steps done"]];
  const cardOf = (id: string) => b?.stepCards?.find((c) => c.step === id);
  const resultOf = (id: string) => {
    const sv = steps.find((x) => x.stepId === id);
    if (!sv || !sv.versions.length) return "not run yet";
    const rep = [...sv.versions].reverse().find((x) => x.report)?.report ?? null;
    const nums = (rep?.numbers ?? []).slice(0, 2).map((n) => `${n.metric}: ${n.before ? `${n.before} → ` : ""}${n.after}`);
    if (nums.length) return nums.join(" · ");
    // a step not done or failed has no result yet: never a number picked from a running or stopped reply
    if (sv.state === "next") return "not run yet";
    if (sv.state !== "done" && sv.state !== "failed") return "running, no result yet";
    return keyNumber(lastOf(sv)?.reply ?? "", rep) || "no numbers in the report";
  };
  const cards = rows.map((st) => ({ st, c: cardOf(st.id), state: CARD_STATE[stOf(st.id)] ?? "next", result: resultOf(st.id) }));
  const cardKey = (x: (typeof cards)[number]) => `card|${x.st.id}|${x.state}|${x.c?.for ?? ""}|${x.c?.how ?? ""}|${x.result}`;
  // s7 rule B7, the owner's pick "Bridge, all devices": each line as a key; a key the last look did not hold is changed.
  // The last look is read once when the board opens; the lines shown are saved after they stay the same for 3 s.
  const keys = {
    what: b ? `what|${b.whatFor}` : "", idea: (b?.idea ?? []).map((x) => `idea|${x}`),
    open: `open|${openTotal}`, latest: latest ? `latest|${latest.sv.stepId}|${latest.sv.state}|${latest.last.at}` : "",
  };
  const featKey = (f: { feature: string; state: FeatureState }) => `feat|${f.feature}|${f.state}`;
  const allKeys = [keys.what, ...keys.idea, ...feats.map(featKey), ...failed.map((st) => `failed|${st.id}`),
    ...waiting.map((q) => `wait|${q.id}`), ...(openTotal ? [keys.open] : []), keys.latest, ...cards.map(cardKey)].filter(Boolean);
  const seen = useBoardSeen(plan.id);
  const isCurrent = v.n === plan.current;
  const prev = useMemo(() => (seen.prev ? new Set(seen.prev.lines) : null), [seen.prev]);
  const changed = (k: string) => !!(isCurrent && prev && k && !prev.has(k));
  const nChanged = allKeys.filter(changed).length;
  const keyStr = allKeys.join("\n");
  useEffect(() => {
    if (!seen.loaded || !isCurrent || !b) return;
    if (seen.prev && seen.prev.lines.join("\n") === keyStr) return;
    const t = setTimeout(() => saveBoardSeen(plan.id, v.n, keyStr.split("\n")), 3000);
    return () => clearTimeout(t);
  }, [seen.loaded, keyStr, isCurrent, plan.id, v.n]);
  // s8 (plan 44fc4979), the owner's pick "4-line answer strip": the glance test's 4 questions answered on top, one
  // line each: For (What for), Done (steps done of all), Next (the step running now, else the first not done in plan
  // order), Waits for you (failed steps, questions waiting, open items). The owner's words: "I don't see it yet".
  const doneIds = rows.filter((st) => stOf(st.id) === "done").map((st) => st.id);
  const nowRows = rows.filter((st) => ["now", "checking"].includes(stOf(st.id)));
  const nextRows = nowRows.length ? nowRows : rows.filter((st) => !["done", "failed"].includes(stOf(st.id))).slice(0, 1);
  const waitN = failed.length + waiting.length + (openTotal ? 1 : 0);
  const waitText = [failed.length ? `${failed.length} failed` : "", waiting.length ? `${waiting.length} question${waiting.length > 1 ? "s" : ""}` : "",
    openTotal ? `${openTotal} open item${openTotal > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ");
  // the newest version of the latest step that carries a report (a receipt version after a done report has none)
  const latestReport = latest ? [...latest.sv.versions].reverse().find((x) => x.report)?.report ?? null : null;
  const latestNums = (latestReport?.numbers ?? []).slice(0, 4);
  // Idea in its named sub-groups (ideaGroups, rule B2); a board that names none shows one list and the rule check flags it
  const ideaLine = (x: string, i: number) => (
    <SrcLine key={i} ids={ideaSrc[i] ?? null} ctx={ctx} className="src-bullet" changed={changed(keys.idea[i])}>{md(x, plan)}</SrcLine>);
  const ig = b?.ideaGroups ?? [];
  const igOk = !!b && ig.length > 0 && ig.reduce((n, g) => n + g.count, 0) === b.idea.length;
  let at = 0;
  const ideaGroups = igOk ? ig.map((g) => { const from = at; at += g.count; return { head: g.head, idx: b!.idea.map((_, i) => i).slice(from, at) }; }) : [];
  return (
    <Section id="plan.board" main stale={stale} title="Report board"
      extra={b ? `${count("built") + count("open")} of ${feats.length} features built${noSrc ? ` · ${noSrc} lines without source` : ""}${v.boardCheck?.fail ? ` · rules: ${v.boardCheck.fail} fail` : ""}${nChanged ? ` · ${nChanged} changed since your last look` : ""}` : "no board yet"}>
      {!b && <p className="small muted">This plan has no board yet: its session adds What for, Idea and the product list with the next plan version.</p>}
      {b && (
        <>
          <div className="board-box glance-strip" data-strip>
            <p className="board-lab">At a glance</p>
            <SrcLine ids={b.src?.whatFor ?? null} ctx={ctx} changed={changed(keys.what)}>
              <p data-strip-line="for"><b>For</b> {b.whatFor}</p>
            </SrcLine>
            <SrcLine ids={doneIds.length ? doneIds : ["steps"]} ctx={ctx}>
              <p data-strip-line="done"><b data-state="done">Done {doneIds.length} of {rows.length}</b>{doneIds.length ? "" : " · none yet"}</p>
            </SrcLine>
            <SrcLine ids={nextRows.length ? nextRows.map((st) => st.id) : ["steps"]} ctx={ctx}>
              <p data-strip-line="next">{nextRows.length
                ? <><b data-state={nowRows.length ? "doing" : "next"}>Next</b> {nextRows.map((st) => `${st.id} ${st.title}${nowRows.length ? " (running)" : ""}`).join(" · ")}</>
                : <><b data-state="done">Next</b> nothing: every step is done or failed</>}</p>
            </SrcLine>
            <SrcLine ids={waitN ? [...failed.map((st) => st.id), ...(openTotal ? ["leftover"] : [])] : ["leftover"]} ctx={ctx}
              own={waiting[0] ? { label: "inbox", open: () => onOpenItem(waiting[0].id) } : undefined}>
              <p data-strip-line="waits">{waitN
                ? <><b data-state="need">Waits for you</b> <span data-state="need">{waitText}</span></>
                : <><b data-state="done">Waits for you</b> nothing</>}</p>
            </SrcLine>
          </div>
          <div className="board-box" data-step-cards>
            <p className="board-lab">Steps · For / How / Result</p>
            {CARD_GROUPS.map(([state, head]) => (
              <Chunks key={state} head={head} state={state} wrap="step-cards" items={cards.filter((x) => x.state === state).map((x) => (
                <div key={x.st.id} className="step-card" data-state={state} data-step-card={x.st.id}>
                  <SrcLine ids={[x.st.id, ...(x.c?.src ?? [])]} ctx={ctx} changed={changed(cardKey(x))}>
                    <p className="step-card-head"><b data-state={state}>{x.st.id}</b> {x.st.title}</p>
                    <p data-card-line="for"><b>For</b> {x.c?.for || <span className="muted">not written yet</span>}</p>
                    <p data-card-line="how"><b>How</b> {x.c?.how || <span className="muted">not written yet</span>}</p>
                    <p data-card-line="result"><b>Result</b> <span data-state={state === "next" ? "next" : state}>{x.result}</span></p>
                  </SrcLine>
                </div>
              ))} />
            ))}
          </div>
          {latest && (
            <div className="board-box" data-latest>
              <p className="board-lab">Latest result · {latest.sv.stepId} {title(latest.sv.stepId)}</p>
              <SrcLine ids={[latest.sv.stepId]} ctx={ctx} changed={changed(keys.latest)}>
                <p className="small"><span className={"status " + latest.sv.state} data-state={latest.sv.state === "done" ? "done" : latest.sv.state === "failed" ? "failed" : "doing"}>{latest.sv.state}</span> <span className="muted">· {when(latest.last.at)}</span></p>
              </SrcLine>
              {latestNums.length > 0
                ? <table className="latest-nums small"><tbody>{latestNums.map((n, i) => (
                    <tr key={i}><td>{n.metric}</td><td className="num">{n.before || "·"}</td><td>→</td><td className="num"><b>{n.after}</b></td></tr>))}</tbody></table>
                : <p className="small">{keyNumber(latest.last.reply, latestReport) || "no numbers in the report"}</p>}
              {latestPic ? <LocalImg src={latestPic} alt={latestPic.split(/[\/]/).pop()} cwd={plan.cwd} /> : <p className="small muted">no picture</p>}
            </div>
          )}
          <CoverageBar planId={plan.id} ctx={ctx} base={{ boardIds, goal: v.parts?.goal ?? "", rules: v.parts ? partLines(v.parts, "rules") : [],
            lessons: v.parts ? partLines(v.parts, "lessons") : [], leftover: v.parts?.leftover ?? [], reports }} />
          {b.idea.length > 0 && (
            <div className="board-box">
              <Section id="plan.board.idea" title={`Idea (${b.idea.length})`} extra={igOk ? ideaGroups.map((g) => g.head).join(" · ") : ""}>
              {igOk
                ? ideaGroups.map((g) => <Chunks key={g.head} head={g.head} items={g.idx.map((i) => ideaLine(b.idea[i], i))} />)
                : b.idea.map(ideaLine)}
              </Section>
            </div>
          )}
          <div className="board-box">
            <p className="board-lab">Progress vs the final product</p>
            <div className="board-bar" role="img" aria-label={order.map((s) => `${FEATURE[s]} ${count(s)}`).join(", ")}>
              {order.map((s) => count(s) > 0 && <i key={s} className={"f-" + s} data-state={STATE_OF[s]} style={{ width: `${pct(count(s))}%` }} title={`${FEATURE[s]}: ${count(s)} of ${feats.length}`} />)}
            </div>
            <p className="board-legend small">
              {order.filter((s) => count(s)).map((s) => <span key={s}><i className={"sw f-" + s} data-state={STATE_OF[s]} />{FEATURE[s]}: {count(s)} of {feats.length} ({pct(count(s))}%)</span>)}
            </p>
            <p className="small muted">each feature takes its color from its steps: all done and nothing open = built; done with open items = open item; any failed = failed</p>
            {order.map((s) => (
              <Chunks key={s} head={FEATURE_HEAD[s]} state={STATE_OF[s]} wrap="board-feats" items={feats.filter((f) => f.state === s).map((f) => (
                <div key={f.feature} className={"board-feat f-" + f.state} data-state={STATE_OF[f.state]} title={f.steps.map(title).join(" · ")}>
                  <SrcLine ids={f.steps.length ? f.steps : null} ctx={ctx} changed={changed(featKey(f))}>
                    <b>{f.feature}</b>
                    <span className="board-key">{f.state === "next" ? FEATURE.next : f.key || FEATURE[f.state]}</span>
                    {f.open > 0 && <span className="small muted">{f.open} open</span>}
                  </SrcLine>
                </div>
              ))} />
            ))}
          </div>
          {mats.length > 0 && (
            <div className="board-box">
              {/* folds like Coverage (the owner, 2026-11-20: "material section got the same problem") */}
              <Section id="plan.board.materials" title={`Materials · latest version of each (${mats.length})`}
                extra={MATERIAL_GROUPS.map(([kind, label]) => [label, mats.filter((m) => m.kind === kind).length] as const).filter(([, n]) => n).map(([l, n]) => `${l} ${n}`).join(" · ")}>
              {MATERIAL_GROUPS.map(([kind, label]) => {
                const list = mats.filter((m) => m.kind === kind);
                return list.length > 0 && (
                  <div key={kind} className="board-mats">
                    <Chunks head={label} items={list.map((m, i) => (
                      <SrcLine key={i} ids={m.path ? [m.path] : null} ctx={ctx} className="src-bullet">
                        {md(`${m.path ? `[${m.name}](<${m.path}>)` : m.name}${m.note ? ` · ${m.note}` : ""}${m.auto ? " · *tự gom*" : ""}`, plan)}
                      </SrcLine>
                    ))} />
                  </div>
                );
              })}
              </Section>
            </div>
          )}
        </>
      )}
      <div className="board-row">
        <div className="board-box">
          <p className="board-lab">Needs you ({failed.length + waiting.length + (openTotal ? 1 : 0)})</p>
          {failed.length + waiting.length + openTotal === 0 && <p className="small muted">Nothing waits for you.</p>}
          <div className="board-need">
            <Chunks head="Steps failed" state="need" items={failed.map((st) => (
              <SrcLine key={st.id} ids={[st.id]} ctx={ctx} changed={changed(`failed|${st.id}`)}><span className="need" data-state="need">✖ {st.id} {st.title} failed</span></SrcLine>))} />
            <Chunks head="Questions waiting" state="need" items={waiting.map((q) => (
              <SrcLine key={q.id} ids={q.stepId ? [q.stepId] : null} ctx={ctx} own={{ label: "inbox", open: () => onOpenItem(q.id) }} changed={changed(`wait|${q.id}`)}>
                <span className="need" data-state="need">? <button className="link need" onClick={() => onOpenItem(q.id)}>{q.title}</button></span>
              </SrcLine>
            ))} />
            <Chunks head="Open items" state="need" items={openTotal > 0 ? [
              <SrcLine key="o" ids={["leftover"]} ctx={ctx} changed={changed(keys.open)}><span className="need" data-state="need">○ {openTotal} open items</span></SrcLine>] : []} />
          </div>
        </div>
      </div>
      {b && (  // s5: after the board's content, so What for stays near the top (rule B1)
        <div className="board-box"><p className="board-lab">Rules and glance</p>
          <RulesBox check={v.boardCheck} ctx={ctx} />
          {/* s8, the owner's pick "Fold it under the board": the board shows the answers; the test sits folded here */}
          <Section id="plan.board.glance" title="Glance test" open={false} extra="folded: the board above shows the answers">
            <GlanceTest plan={plan} version={v.n} />
          </Section>
        </div>
      )}
    </Section>
  );
}

function ItemList({ items, plan }: { items: Item[]; plan: Plan }) {
  return (
    <>
      {items.map((it, i) => it.kind === "table"
        ? <div key={i}>{md(it.rows.join("\n"), plan)}</div>
        : <div key={i} className={it.sub ? "report-line sub" : "report-line"}>{md("- " + it.text, plan)}</div>)}
    </>
  );
}

const SORTED_NAMES: [keyof Sorted, string][] = [
  ["built", "Built"], ["numbers", "Numbers"], ["tests", "Tested by"], ["notDone", "Not done → what to do"],
  ["pictures", "Pictures named in the reply"], ["notes", "Notes"],
];

function ExactFields({ r, plan }: { r: StepReport; plan: Plan }) {
  return (
    <>
      {r.built?.length ? <Section id="step.report.built" title="Built" extra={r.built.length}>{md(r.built.map((b) => `- ${b}`).join("\n"), plan)}</Section> : null}
      {r.numbers?.length ? (
        <Section id="step.report.numbers" title="Numbers" extra={r.numbers.length}>
          <table>
            <thead><tr><th>Metric</th><th>Before</th><th>After</th><th>Measured by</th></tr></thead>
            <tbody>{r.numbers.map((n, i) => <tr key={i}><td>{md(n.metric, plan)}</td><td>{md(n.before || "-", plan)}</td><td><b>{md(n.after, plan)}</b></td><td className="small">{md(n.how, plan)}</td></tr>)}</tbody>
          </table>
        </Section>
      ) : null}
      {r.tests?.length ? (
        <Section id="step.report.tests" title="Tested by" extra={r.tests.length}>
          <table>
            <thead><tr><th>Method</th><th>Result</th></tr></thead>
            <tbody>{r.tests.map((t, i) => <tr key={i}><td>{md(t.method, plan)}</td><td>{md(t.result, plan)}</td></tr>)}</tbody>
          </table>
        </Section>
      ) : null}
      {r.not_done?.length ? <Section id="step.report.notdone" title="Not done → what to do" extra={r.not_done.length}>{md(r.not_done.map((x) => `- ${x.item}${x.fix ? ` → ${x.fix}` : ""}`).join("\n"), plan)}</Section> : null}
    </>
  );
}

function SortedFields({ reply, plan }: { reply: string; plan: Plan }) {
  const { fields } = sortReply(reply);
  const ck = sortCheck(reply);
  return (
    <>
      <p className="small muted">
        Read from the reply (made before the report fields): {ck.placed} of {ck.lines} lines placed · {ck.numbers} numbers,{" "}
        {ck.missing.length ? <span className="bad">missing: {ck.missing.join(", ")}</span> : "none missing"} · a line may sit
        in a near field; the full reply is below
      </p>
      {SORTED_NAMES.filter(([k]) => fields[k].length).map(([k, name]) => (
        <Section key={k} id={`step.report.sorted.${k}`} title={name} extra={fields[k].length}><ItemList items={fields[k]} plan={plan} /></Section>
      ))}
    </>
  );
}

function RunReports({ plan, v, runs, steps, evidence, generated, stale }: {
  plan: Plan; v: PlanVersion; runs: Run[]; steps: PlanStep[]; evidence: StepEvidence[]; generated: PlanGenerated | null; stale?: string;
}) {
  const rows = (v.parts?.steps ?? []).filter((st) => steps.some((x) => x.stepId === st.id && x.versions.length));
  const stepRuns = runs.filter((r) => r.planId === plan.id && stepOf(r) && r.action === "message")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <Section id="plan.part.reports" title="Run reports" extra={rows.length ? `${rows.length} steps reported` : "none yet"} stale={stale}>
      {rows.length === 0 && <p className="muted small">No step has reported yet. Run step on a step in Build, and its report lands here.</p>}
      {rows.map((st) => {
        const sv = steps.find((x) => x.stepId === st.id)!;
        const last = lastOf(sv)!;
        const mine = stepRuns.filter((r) => stepOf(r) === st.id);
        const files = generated?.versions?.[`v${last.planVersion}`] ?? [];
        return (
          <Section key={st.id} id={`plan.report.${plan.id}.${st.id}`}
            title={<span className="result-head">
              <span className={"status " + sv.state}>{sv.state}</span>
              <b>{st.id} · {st.title}</b>
              <span className="small muted">step version {last.n} · {when(last.at)} · {last.report ? "report fields" : "read from the reply"}</span>
            </span>}>
            <p className="small muted">check: {st.check}</p>
            {last.report ? <ExactFields r={last.report} plan={plan} /> : <SortedFields reply={last.reply} plan={plan} />}
            <StepEvidenceCard plan={plan} id={st.id} title={`Pictures · ${st.title}`} done={sv.state === "done"} e={evidence.find((e) => e.stepId === st.id)} />
            <Section id={`plan.report.reply.${plan.id}.${st.id}`} title="Full reply, as written" extra={`${last.reply.length.toLocaleString()} chars`}>
              {md(last.reply, plan)}
            </Section>
            {sv.versions.length > 1 && (
              <Section id={`plan.report.older.${plan.id}.${st.id}`} title="Older step versions" extra={sv.versions.length - 1}>
                {sv.versions.slice(0, -1).reverse().map((x) => (
                  <div key={x.n}>
                    <p className="small muted">step version {x.n} · {x.state} · {when(x.at)} · on plan v{x.planVersion}</p>
                    {x.report ? <ExactFields r={x.report} plan={plan} /> : null}
                    {md(x.reply, plan)}
                  </div>
                ))}
              </Section>
            )}
            {mine.length > 0 && (
              <Section id={`plan.report.runs.${plan.id}.${st.id}`} title="Run replies" extra={`${mine.length} runs`}>
                {mine.map((r) => (
                  <Section key={r.id} id={`plan.result.${r.id}`}
                    title={<span className="result-head">
                      <span className={"status " + r.status}>{r.status}</span>
                      {r.answerStep && <span className="tag" title="The run that took your answer to a question on this step">your answer</span>}
                      <span className="small muted">ran {when(r.startedAt ?? r.createdAt)}{r.endedAt ? ` → ${when(r.endedAt)}` : ""}</span>
                    </span>}>
                    {(r.status === "done" || r.status === "lost") && <PcText run={r.id} cwd={plan.cwd} />}
                    {r.status !== "done" && r.status !== "lost" && r.error && <p className="bad small">{r.error}</p>}
                  </Section>
                ))}
              </Section>
            )}
            <p className="small muted">
              files approved for v{last.planVersion}:{" "}
              {files.length
                ? files.map((f) => <code key={f.file} className="file-link" role="button" onClick={() => openFile(f.file, plan.cwd)}>{f.file.split(/[\\/]/).pop()}</code>)
                    .reduce<React.ReactNode[]>((a, x, i) => (i ? [...a, " · ", x] : [x]), [])
                : "none"}
            </p>
          </Section>
        );
      })}
    </Section>
  );
}

// Leftover, open items: every report's "Not done" lines (they cannot go stale), then the plan text's own Leftover.
function LeftoverSection({ plan, v, steps }: { plan: Plan; v: PlanVersion; steps: PlanStep[] }) {
  const fromReports = (v.parts?.steps ?? []).flatMap((st) => {
    const last = lastOf(steps.find((x) => x.stepId === st.id));
    return last ? openItems(last.reply, last.report).map((t) => ({ step: st.id, t })) : [];
  });
  const written = v.parts?.leftover ?? [];
  return (
    <Section id="plan.part.open" title="Leftover · open items" extra={`${fromReports.length} from the reports · ${written.length} in the plan text`}>
      {fromReports.length === 0 && written.length === 0 && <p className="muted small">Nothing open.</p>}
      {md([...fromReports.map((x) => `- **${x.step}:** ${x.t}`), ...written.map((t) => `- **plan text:** ${t}`)].join("\n"), plan)}
    </Section>
  );
}

// 9. Decisions (the owner's words, 2026-11-10: "I see the missing in images and artifacts after I approved, no where to
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
    <Section id="plan.part.decisions" title="9. Decisions" extra={`${answered.length} decided · ${qs.length - answered.length} waiting`}>
      {qs.length === 0 && <p className="muted small">No question asked on this plan yet.</p>}
      {rounds.map((r) => (
        <Section key={r} id={`plan.decisions.round.${r}`} title={r ? `Round on v${r}` : "Before v1"} extra={qs.filter((q) => (q.round ?? 0) === r).length}>
          {qs.filter((q) => (q.round ?? 0) === r).map((q) => {
            const picked = q.answer ? (q.multi ? q.answer.choice.split(", ") : [q.answer.choice]) : [];
            const chosen = q.options.filter((o) => picked.includes(o.label));
            const others = q.options.filter((o) => !picked.includes(o.label));
            const made = q.answer ? madeIn(q) : undefined;
            // one line each, the rest folded (the owner's pick, 2026-11-15: "A")
            return (
              <Section key={q.id} id={`plan.decision.${q.id}`}
                title={<span>{q.title} → {q.answer
                  ? <b>{q.answer.choice || "your own answer"}</b>
                  : <span className="status waiting">waiting for you</span>}
                  <span className="small muted">{made ? ` · made v${made}` : ""}{q.answer ? ` · ${dt(q.answer.at)}` : ""} · {q.kind}</span></span>}>
              <div className="decision">
                <p><button className="link" onClick={() => onOpenItem(q.id)}>Open in the inbox</button></p>
                {q.answer?.text && <p className="small">Your note: <Md line text={q.answer.text} /></p>}
                {q.history?.length ? <p className="small muted">Earlier: {q.history.map((h) => h.choice).join(" → ")}</p> : null}
                {chosen.map((o) => (
                  <div key={o.label} className="decision-pick">
                    {o.detail && <Md className="small muted" text={o.detail} cwd={q.cwd || plan.cwd} />}
                    <KeptExample q={q} o={o} cwd={q.cwd || plan.cwd} />
                  </div>
                ))}
                {q.answer && !chosen.length && <p className="small muted">Your own answer: no option of the list.</p>}
                {q.answer && others.length > 0 && (
                  <Section id="plan.decision.others" title={`Not picked (${others.length})`} open={false}>
                    {others.map((o) => (
                      <div key={o.label} className="decision-pick">
                        <p className="small"><b>{o.label}</b>{o.detail ? <> · <Md line text={o.detail} cwd={q.cwd || plan.cwd} /></> : ""}</p>
                        <KeptExample q={q} o={o} cwd={q.cwd || plan.cwd} />
                      </div>
                    ))}
                  </Section>
                )}
              </div>
              </Section>
            );
          })}
        </Section>
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
      {q.snapshot?.pointed && <p className="small muted">✓ Pointed to {q.snapshot.pointed.to.split(/[\\/]/).pop()} on your word ({dt(q.snapshot.pointed.at)})</p>}
      {kept && !q.snapshot?.pointed && !changed.length && !missing.length && <p className="small muted">✓ Kept as at your answer ({dt(q.snapshot!.at)})</p>}
    </>
  );
}

// The Steps bar and the per-step picks (the owner's pick, 2026-11-16: "Bar + per-step picks table"; the owner's words:
// "which can provide me the feature of choosing what runner and model and effort for each step when run?"). One bar on
// top: the step, Run step, Run all (the bridge runs the steps not done in order and stops on a fail, chain.py). Each
// step's runner, model, effort and handoff live in the folded table below, saved per plan (planPicks); Run step and
// Run all both use the step's own row. Runner: Claude only now (the owner's pick: "Claude only now, local later").
type StepRow = Parts["steps"][number];
const pickOf = (picks: PlanPicks | null, id: string, prefs: { model?: string; effort?: string } | null) => {
  const p = picks?.steps?.[id] ?? {};
  return { model: p.model || exactModel(prefs?.model), effort: p.effort || exactEffort(prefs?.effort), fresh: (p.fresh ?? "auto") as Fresh,
    together: !!p.together, heavy: !!p.heavy };
};

function StepBar({ plan, rows, steps, runs, harness, picks }: {
  plan: Plan; rows: StepRow[]; steps: PlanStep[]; runs: Run[]; harness: string; picks: PlanPicks | null;
}) {
  const chain = usePlanChain(plan.id);
  const prefs = useRunPrefs();
  const [error, setError] = useState("");
  const [pick, setPick] = useState("");
  if (phaseOf(plan) === "explore") return <p className="small muted">Run step and Run all are off in Explore: move the plan to Build first.</p>;
  const done = (id: string) => steps.find((x) => x.stepId === id)?.state === "done";
  const first = rows.find((r) => !done(r.id))?.id ?? rows[0]?.id ?? "";
  const id = rows.some((r) => r.id === pick) ? pick : first;
  const step = rows.find((r) => r.id === id);
  const on = chain?.state === "on";
  const going = runs.some((r) => r.planId === plan.id && r.stepId === id && (r.status === "new" || r.status === "running"));
  const left = rows.filter((r) => !done(r.id)).length;
  const w = step ? pickOf(picks, step.id, prefs) : null;
  const fail = (e: { code?: string }) => setError(String(e?.code ?? e));
  const max = picks?.maxTogether ?? 2;
  const together = rows.filter((r) => picks?.steps?.[r.id]?.together).length;
  return (
    <div className="run-all step-bar">
      <select value={id} onChange={(e) => setPick(e.target.value)} aria-label="step">
        {rows.map((r) => <option key={r.id} value={r.id}>{r.id} · {done(r.id) ? "done" : "not done"} · {r.title.slice(0, 40)}</option>)}
      </select>
      <button className="primary" disabled={!step || going}
        onClick={() => step && w && runStep(plan, step, harness, w).catch(fail)}>{going ? `${id} running` : `Run step ${id}`}</button>
      {on ? (
        <button className="danger" onClick={() => stopChain(plan.id).catch(fail)}>Stop run all</button>
      ) : (
        <button disabled={!left} title={left ? "Each step runs with its own row in Per-step picks" : "Every step is done; rerun one by hand"}
          onClick={() => runAllSteps(plan).catch(fail)}>Run all steps ({left} not done)</button>
      )}
      <label className="small" title="How many steps ticked Together may run at once (each in its own fresh session)">
        max at once{" "}
        <select value={max} onChange={(e) => setMaxTogether(plan.id, Number(e.target.value)).catch(fail)} aria-label="max at once">
          {[1, 2, 3, 4].map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
      </label>
      {together > 0 && <span className="small muted">{together} ticked Together</span>}
      {w && <span className="small muted">{id}: Claude · {w.model} · {w.effort} · handoff {w.fresh}</span>}
      {chain && (
        <span className={"status " + (on ? "running" : chain.state === "done" ? "done" : "failed")}>
          {on ? `${chain.failing ? "stopping after the runs going" : "running"} ${Object.keys(chain.running ?? {}).join(", ") || chain.stepId || "…"}${chain.left ? ` · ${chain.left} left` : ""}` : chain.state === "done" ? `all done · ${chain.reason ?? ""}` : `stopped · ${chain.reason ?? ""}`}
        </span>
      )}
      {error && <span className="bad small"> {error}</span>}
    </div>
  );
}

function PicksTable({ plan, rows, picks }: { plan: Plan; rows: StepRow[]; picks: PlanPicks | null }) {
  const prefs = useRunPrefs();
  const [error, setError] = useState("");
  // a change saves the step's whole row as shown, so the row always names exactly what runs
  const set = (id: string, change: Partial<StepPick>) =>
    setStepPick(plan.id, id, { ...pickOf(picks, id, prefs), ...change }).catch((e) => setError(String(e?.code ?? e)));
  const saved = rows.filter((r) => picks?.steps?.[r.id]).length;
  return (
    <Section id="plan.steps.picks" title="Per-step picks" extra={`runner, model, effort, handoff, together, heavy · ${saved} of ${rows.length} set, the rest follow the Runs tab`} open={false}>
      <table className="picks">
        <thead><tr><th>Step</th><th>Runner</th><th>Model</th><th>Effort</th><th>Handoff</th>
          <th title="May run beside other ticked steps, each in its own fresh session">Together</th>
          <th title="Blender, Unreal, GPU: runs alone, even when ticked Together">Heavy</th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const w = pickOf(picks, r.id, prefs);
            const own = !!picks?.steps?.[r.id];
            return (
              <tr key={r.id} data-step={r.id}>
                <td title={r.title}><b>{r.id}</b> <span className="small">{r.title.slice(0, 36)}</span>{own ? "" : <span className="small muted"> · Runs tab</span>}</td>
                <td>
                  <select value="claude" aria-label={`${r.id} runner`} onChange={() => undefined}>
                    <option value="claude">Claude</option>
                    <option value="local" disabled>local model (needs agent stage)</option>
                  </select>
                </td>
                <td>
                  <select value={w.model} aria-label={`${r.id} model`} onChange={(e) => set(r.id, { model: e.target.value })}>
                    {MODELS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
                  </select>
                </td>
                <td>
                  <select value={w.effort} aria-label={`${r.id} effort`} onChange={(e) => set(r.id, { effort: e.target.value })}>
                    {EFFORTS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
                  </select>
                </td>
                <td>
                  <select value={w.fresh} aria-label={`${r.id} handoff`} onChange={(e) => set(r.id, { fresh: e.target.value as Fresh })}>
                    <option value="auto">auto</option>
                    <option value="always">fresh with a handoff</option>
                    <option value="never">resume as is</option>
                  </select>
                </td>
                <td><input type="checkbox" checked={w.together} aria-label={`${r.id} together`} onChange={(e) => set(r.id, { together: e.target.checked })} /></td>
                <td><input type="checkbox" checked={w.heavy} aria-label={`${r.id} heavy`} onChange={(e) => set(r.id, { heavy: e.target.checked })} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {error && <p className="bad small">{error}</p>}
    </Section>
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
    case "board":
      return md(partLines(parts, "board").map((x) => `- ${x}`).join("\n") || "none yet");
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
      // the raw step text, as the session reads it (the Steps section shows them with their states and runs)
      return (
        <table>
          <thead><tr><th>Step</th><th>Does</th><th>Check</th></tr></thead>
          <tbody>{parts.steps.map((s) => <tr key={s.id}><td>{s.id} · {s.title}</td><td>{md(s.does)}</td><td className="small">{md(s.check)}</td></tr>)}</tbody>
        </table>
      );
  }
}

export function PartsView({ plan, versions, items, runs, onOpenItem }: {
  plan: Plan; versions: PlanVersion[]; items: InboxItem[]; runs: Run[]; onOpenItem: (id: string) => void;
}) {
  const steps = usePlanSteps(plan.id) ?? [];
  const checks = useStepChecks(plan.id);
  const claims = useClaims(plan.id);
  const evidence = useStepEvidence(plan.id);
  const ticks = useHarness(plan.id);
  const generated = usePlanGenerated(plan.id);
  const [checked, setChecked] = useState<string | null>(null); // when Check plan was pressed
  const picks = usePlanPicks(plan.id);
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
    <FoldAll.Provider value={true}>
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
        <button className="chip primary" onClick={() => setChecked(tm(Date.now()))} title="Does every section follow the current version?">
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

      <ReportBoard plan={plan} v={v} steps={steps} evidence={evidence} asked={asked} onOpenItem={onOpenItem} stale={v.n === plan.current ? staleMark(stale, "board") : undefined} />

      <RunReports plan={plan} v={v} runs={runs} steps={steps} evidence={evidence} generated={generated} stale={staleMark(stale, "results")} />

      <Section id="plan.part.steps" title="6. Steps" extra={`${v.parts.steps.length} steps`} stale={staleMark(stale, "results")}>
        {before && <DiffBlock a={partLines(before, "steps")} b={partLines(v.parts, "steps")} />}
        {!before && v.n === plan.current && (
          <>
            <StepBar plan={plan} rows={v.parts.steps} runs={runs} harness={harnessNote} picks={picks}
              steps={steps.filter((x) => v.parts!.steps.some((st) => st.id === x.stepId))} />
            {phaseOf(plan) !== "explore" && <PicksTable plan={plan} rows={v.parts.steps} picks={picks} />}
          </>
        )}
        {v.parts.steps.map((st) => {
          const sv = steps.find((x) => x.stepId === st.id);
          const qs = asked.filter((i) => i.stepId === st.id);
          return (
            // the owner's pick, 2026-11-12, "All folded": every step starts folded to its header line
            <Section key={st.id} id={`plan.step.${plan.id}.${st.id}`} open={false}
              title={<span data-step={st.id}>
                <span className={"step-state " + (sv?.state ?? "next")}>{sv?.state ?? "next"}</span>
                <b>{st.id} · {st.title}</b>{st.new && <span className="tag" title="Work the session's record does not hold">new</span>}
                {" "}<ReceiptChip sv={sv} c={checks.find((x) => x.stepId === st.id)} />
                {" "}<ClaimChip c={claims.find((x) => x.kind === "step" && x.stepId === st.id)} />
              </span>}
              tools={sv ? <MoreMenu path={`planSteps/${plan.id}_${st.id}`} /> : undefined}>
              <div className="step-row" data-step={st.id}>
              <p className="step-tools"><StepActions step={st} /></p>
              <ClaimLine c={claims.find((x) => x.kind === "step" && x.stepId === st.id)} />
              <Md text={linkEntries(`${st.does}\n\n**Check:** ${st.check}`, plan)} cwd={plan.cwd} />
              <ReceiptBox sv={sv} c={checks.find((x) => x.stepId === st.id)} />
              <StepCheckBox plan={plan} stepId={st.id} c={checks.find((x) => x.stepId === st.id)} done={sv?.state === "done" || sv?.state === "failed" || sv?.state === "checking"} />
              <OnMessages runs={runs} plan={plan} where={{ stepId: st.id }} />
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

      <LeftoverSection plan={plan} v={v} steps={steps} />

      <DecisionsSection plan={plan} versions={versions} asked={asked} onOpenItem={onOpenItem} />

      <HarnessSection plan={plan} v={v} parent={parent} stale={staleMark(stale, "harness")} />

      <GeneratedSection plan={plan} v={v} stale={staleMark(stale, "generated")} />

      <PlanMessage plan={plan} />
      {msgs.length > 0 && <RunList runs={msgs} title="Messages on this plan" paged />}

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

      {/* the plan text as the session reads it, at the end (the owner's words, 2026-11-15: "the 'Plan text folded,
          unchanged' should be show in the end so I still can see the raw data which LLM can see as its database") */}
      <Section id="plan.part.raw" title="Plan text · raw, as the session reads it" extra={`v${v.n} · board, goal, summary, rules, lessons, leftover, steps`}>

      {PART_NAMES.map(([k, name]) => (
        <Section key={k} id={`plan.part.${k}`} title={name} stale={v.n === plan.current ? staleMark(stale, k) : undefined}
          tools={<PartActions k={k} name={name} lines={partLines(v.parts!, k)} />}>
          <div data-part={k}>
            <Part k={k} parts={v.parts!} before={before} plan={plan} />
          </div>
          <OnMessages runs={runs} plan={plan} where={{ part: k }} />
        </Section>
      ))}

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

      </Section>
    </div>
    </FoldAll.Provider>
  );
}

// Step check runner (step i8; the owner's picks 2026-11-12: "Session proposes, you edit + tick", "On done + a Run check
// button", "Step turns failed, chain stops", "PowerShell, plan folder, 10 min"). The bridge runs only a ticked command;
// an edit unticks it. Its last run shows the exit code, the time and the last lines of output.
function StepCheckBox({ plan, stepId, c, done }: { plan: Plan; stepId: string; c?: StepCheck; done: boolean }) {
  const [text, setText] = useState(c?.command ?? "");
  const phone = usePhone();
  // the box grows to its whole wrapped text (measured, not guessed from the length)
  const grow = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const t = grow.current;
    if (t) (t.style.height = "auto", t.style.height = t.scrollHeight + 2 + "px");
  }, [text, phone]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => setText(c?.command ?? ""), [c?.command]);
  const ok = checkTicked(c);
  const changed = text.trim() !== (c?.command ?? "").trim();
  const going = c?.state === "queued" || c?.state === "running";
  const r = c?.last;
  async function act(f: () => Promise<unknown>) {
    setBusy(true);
    setErr("");
    try {
      await f();
    } catch (e) {
      setErr(String((e as { code?: string; message?: string }).message ?? e));
    }
    setBusy(false);
  }
  return (
    <div className="stepcheck" data-check={stepId}>
      <div className="stepcheck-row">
        <span className="small muted">Check command{c?.proposedBy ? ` (${c.proposedBy === "session" ? "proposed by the session" : "edited by you"})` : ""}</span>
        {/* the owner's pick, 2026-11-16: "2-line box on phones", note "make it become text wrap so can display multiple
            lines": on a phone the command wraps and the box grows to show all of it; desktop keeps one line */}
        {phone ? (
          <textarea ref={grow} className="mono" value={text} rows={2}
            placeholder="none yet: the session proposes one, or type it" onChange={(e) => setText(e.target.value.replace(/\n/g, " "))} />
        ) : (
          <input className="mono" value={text} placeholder="none yet: the session proposes one, or type it" onChange={(e) => setText(e.target.value)} />
        )}
        {changed && <button disabled={busy || !text.trim()} onClick={() => act(() => saveCheckCommand(plan.id, stepId, text))}>Save</button>}
        {c?.command && !changed && (
          <label className="small stepcheck-tick">
            <input type="checkbox" checked={ok} disabled={busy} onChange={(e) => act(() => tickCheck(c, e.target.checked))} />
            {ok ? "ticked: the bridge runs it" : "tick to let the bridge run it"}
          </label>
        )}
        {c && ok && !changed && (
          <button className="primary" disabled={busy || going} onClick={() => act(() => runCheck(plan, c))}>
            {c.state === "running" ? "Running" : c.state === "queued" ? "Queued" : "Run check"}
          </button>
        )}
      </div>
      {err && <p className="bad small">{err}</p>}
      {done && c?.command && !ok && !r && <p className="small muted">not ticked: not run on the done report</p>}
      {r && (
        <div className="stepcheck-last">
          <span className={r.exit === 0 ? "check-chip pass" : "check-chip fail"}>
            {r.timedOut ? "stopped at 10 min" : `exit ${r.exit}`}
          </span>{" "}
          <span className="small muted">{r.seconds} s · on {r.trigger === "done" ? "the done report" : "Run check"} · {dt(r.endedAt)}</span>
          {r.command !== c?.command && <span className="small muted"> · ran: <code>{r.command}</code></span>}
          <Clamp><pre className="mono check-out">{r.tail || "(no output)"}</pre></Clamp>
        </div>
      )}
    </div>
  );
}
