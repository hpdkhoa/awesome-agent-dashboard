import { useEffect, useState } from "react";
import { askGlance, usePlanGlance, type BoardCheck, type Plan } from "./data";
import { SrcLine, type SrcCtx } from "./SourceChip";

// s5 (plan 44fc4979), the owner's words "Both": the auto rule check (B1 to B10) on every version and the owner's 10 s
// glance test (what for, done, next, blocked) per redesign. Picks, 2026-11-20: "Check all 10, B2/B4/B7 'waits s7'",
// "Save + red flag" (a failing version is saved; its fails show here in red; refusing is open, the owner decides
// later), "Button on the board".

const STATE_CLASS = { pass: "rule-pass", fail: "rule-fail", "waits for s7": "rule-wait" } as const;

export function RulesBox({ check, ctx }: { check?: BoardCheck; ctx: SrcCtx }) {
  if (!check) return <p className="small muted" data-rules="none">Rules: no check on this version (made before s5).</p>;
  return (
    <details className="rules-box" data-rules={check.fail ? "fail" : "pass"} data-rules-fail={check.fail} open={check.fail > 0}>
      <summary className="small">
        <b className={check.fail ? "rule-fail" : "rule-pass"}>Rules: {check.fail} fail</b> · {check.pass} pass · {check.wait} wait for s7
      </summary>
      {check.rules.map((r) => (
        <SrcLine key={r.id} ids={[r.kb]} ctx={ctx} className="src-bullet">
          <span className={STATE_CLASS[r.state]} data-rule={r.id} data-rule-state={r.state}>
            {r.id} {r.name}: {r.state}{r.n ? ` (${r.n})` : ""}
          </span>
          {r.lines.length > 0 && <span className="small muted"> · {r.lines.join(" · ")}</span>}
        </SrcLine>
      ))}
    </details>
  );
}

const QS: [string, string][] = [["whatFor", "What is this plan for?"], ["done", "What is done?"], ["next", "What is next?"],
  ["blocked", "What is blocked or waits for you?"]];
const LOOK = 10;

export function GlanceTest({ plan, version }: { plan: Plan; version: number }) {
  const g = usePlanGlance(plan.id);
  const [phase, setPhase] = useState<"idle" | "look" | "ask">("idle");
  const [left, setLeft] = useState(LOOK);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  useEffect(() => {
    if (phase !== "look") return;
    if (left <= 0) { setPhase("ask"); return; }
    const t = setTimeout(() => setLeft(left - 1), 1000);
    return () => clearTimeout(t);
  }, [phase, left]);
  const last = g?.tests?.[0];
  const busy = g?.state === "queued" || g?.state === "running";
  return (
    <div className="glance" data-glance={last?.score ?? "none"}>
      <button className="link" disabled={phase !== "idle" || busy} onClick={() => { setAnswers({}); setLeft(LOOK); setPhase("look"); }}>
        Glance test</button>
      {busy && <span className="small muted"> · scoring…</span>}
      {last && (
        <details className="small">
          <summary>
            Glance v{last.version}: {last.score === null ? (last.error ? "not scored" : "scoring") : `${last.score} / 4`}
            <span className="muted"> · {new Date(last.at).toLocaleString()}</span>
          </summary>
          {last.error && <p className="bad">{last.error}</p>}
          {last.marks.map((m) => (
            <p key={m.q} className={m.verdict === "right" ? "rule-pass" : m.verdict === "partly" ? "rule-wait" : "rule-fail"}>
              {QS.find(([k]) => k === m.q)?.[1]} {m.verdict}: <span className="muted">"{last.answers[m.q] ?? ""}"</span> · {m.why}
            </p>
          ))}
          {(g?.tests?.length ?? 0) > 1 && <p className="muted">Earlier: {g!.tests!.slice(1).map((t) => `v${t.version} ${t.score ?? "-"}/4`).join(", ")}</p>}
        </details>
      )}
      {phase === "look" && <div className="glance-timer" data-glance-look={left}>Glance: look at the board · {left} s</div>}
      {phase === "ask" && (
        <div className="glance-cover" data-glance-ask>
          <div className="glance-form">
            <p><b>From memory, without the board</b></p>
            {QS.map(([k, q]) => (
              <label key={k}>{q}
                <input value={answers[k] ?? ""} onChange={(e) => setAnswers({ ...answers, [k]: e.target.value })} />
              </label>
            ))}
            <p>
              <button onClick={() => { askGlance(plan, version, answers); setPhase("idle"); }}>Send for scoring</button>{" "}
              <button className="link" onClick={() => setPhase("idle")}>Cancel</button>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
