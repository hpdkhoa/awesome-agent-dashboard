import { useState } from "react";
import { askEvidence, type EvidenceSet, type Plan, type PlanStep, type PlanVersion, type StepEvidence } from "./data";
import { LocalImg } from "./FileView";
import { Section } from "./Section";
import { dt } from "./fmt";

// 8. Evidence, after 7. Results (the owner's words, 2026-11-12: "I need the plan when done will have an evidence section
// after result section, which capture the evidence of done for each step, this section will have two flows: first is
// when done each step will add the evidence auto, second is I will have a button to manual generate the evidence and
// another button to do the auto check from LLM side"; notes: "I want to have the image evidences, not text", "I want to
// see the feature, the visual, the evidence"; picks: "Attach, else picture run", "Fresh one-off run", "Mark only").
// One fold per step: its newest pictures as a gallery, each with the LLM mark on it; older sets folded.

const when = (iso: string) => dt(iso);
const name = (p: string) => p.split(/[\\/]/).pop() ?? p;
const source = (s: EvidenceSet) =>
  s.by === "report" ? "attached by the done report" : s.trigger === "done" ? "picture run after the done report" : "picture run (Generate evidence)";

function Gallery({ set, cwd, marks }: { set: EvidenceSet; cwd: string; marks?: StepEvidence["check"] }) {
  const mark = (p: string) => (marks && marks.set === set.at ? marks.pictures.find((m) => m.path === p || name(m.path) === name(p)) : undefined);
  return (
    <div className="evidence-grid">
      {set.pictures.map((p) => {
        const m = mark(p);
        return (
          <figure key={p} className={"evidence-pic" + (m ? " " + m.verdict : "")}>
            <LocalImg src={p} alt={name(p)} cwd={cwd} />
            <figcaption className="small">
              {m && <span className={"check-chip " + m.verdict}>{m.verdict}</span>} {m?.why || <span className="muted">{name(p)}</span>}
            </figcaption>
          </figure>
        );
      })}
    </div>
  );
}

function StepEvidenceCard({ plan, id, title, done, e }: { plan: Plan; id: string; title: string; done: boolean; e?: StepEvidence }) {
  const [err, setErr] = useState("");
  const sets = e?.sets ?? [];
  const last = sets[0];
  const busy = e?.state === "queued" || e?.state === "running";
  const ck = e?.check;
  const checkedLast = !!ck && !!last && ck.set === last.at;
  const go = (what: "pictures" | "check") => askEvidence(plan, id, what).catch((x) => setErr(String(x?.message ?? x)));
  const label = busy ? (e?.what === "check" ? "LLM checking" : "taking pictures") + (e?.state === "queued" ? " (queued)" : "") : "";
  return (
    <Section id={`plan.evidence.${plan.id}.${id}`} open={false}
      title={<span className="result-head">
        <span className={"status " + (done ? "done" : "next")}>{done ? "done" : "not done"}</span>
        <b>{id} · {title}</b>
        <span className="small muted">{last ? `${last.pictures.length} picture${last.pictures.length === 1 ? "" : "s"}` : "no pictures"}</span>
        {checkedLast && <span className={"check-chip " + ck!.overall}>LLM {ck!.overall}</span>}
        {busy && <span className="status running">{label}</span>}
      </span>}>
      <div className="evidence-tools">
        <button className="primary" disabled={busy} onClick={() => go("pictures")}>Generate evidence</button>
        <button disabled={busy || !last} title={last ? undefined : "Generate evidence first"} onClick={() => go("check")}>LLM check</button>
        <span className="small muted">each is a fresh one-off run; the LLM check marks only, the step state stays</span>
      </div>
      {err && <p className="bad small">{err}</p>}
      {e?.error && !busy && <p className="bad small">{e.error}</p>}
      {!last && !busy && <p className="small muted">{done ? "No pictures yet: Generate evidence takes them." : "The step is not done; its done report adds the pictures."}</p>}
      {last && (
        <>
          <p className="small muted">{source(last)} · {when(last.at)}{last.stepVersion ? ` · step version ${last.stepVersion}` : ""}</p>
          {checkedLast && <p className="small"><span className={"check-chip " + ck!.overall}>LLM {ck!.overall}</span> {ck!.note} <span className="muted">· {when(ck!.at)}</span></p>}
          {ck && !checkedLast && <p className="small muted">The last LLM check ({ck.overall}, {when(ck.at)}) was on older pictures: LLM check again.</p>}
          <Gallery set={last} cwd={plan.cwd} marks={ck} />
        </>
      )}
      {sets.length > 1 && (
        <Section id={`plan.evidence.older.${plan.id}.${id}`} title="Older pictures" extra={sets.length - 1} open={false}>
          {sets.slice(1).map((s) => (
            <div key={s.at}>
              <p className="small muted">{source(s)} · {when(s.at)}</p>
              <Gallery set={s} cwd={plan.cwd} marks={ck} />
            </div>
          ))}
        </Section>
      )}
    </Section>
  );
}

export function EvidenceSection({ plan, v, steps, evidence }: { plan: Plan; v: PlanVersion; steps: PlanStep[]; evidence: StepEvidence[] }) {
  const list = v.parts?.steps ?? [];
  const withPics = list.filter((s) => evidence.find((e) => e.stepId === s.id)?.sets?.length).length;
  return (
    <Section id="plan.part.evidence" title="8. Evidence" extra={`${withPics} of ${list.length} steps with pictures`}>
      {list.length === 0 && <p className="small muted">No steps.</p>}
      {list.map((s) => (
        <StepEvidenceCard key={s.id} plan={plan} id={s.id} title={s.title} done={steps.find((x) => x.stepId === s.id)?.state === "done"}
          e={evidence.find((e) => e.stepId === s.id)} />
      ))}
    </Section>
  );
}
