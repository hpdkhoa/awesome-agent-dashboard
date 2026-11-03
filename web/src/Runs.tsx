import { useState } from "react";
import {
  cancelMessage, checkSession, forceMessage, planFromSession, PLAN_KINDS, sendMessage, setRunMode, startRun, stopRun, useRunMode,
  type Machine, type Run, type Session,
} from "./data";
import { usd } from "./Dashboard";
import { Md } from "./Markdown";
import { MoreMenu } from "./MoreMenu";
import { Section } from "./Section";

const LIVE = new Set(["new", "waiting", "running", "stopping"]);

function ago(iso?: string) {
  if (!iso) return "";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

// The prompt behind "Start a plan" (the owner's choice, 2026-11-02: "Do 1"): one session runs the whole plan.
export const planPrompt = (topic: string) =>
  `Plan this with the owner: ${topic}

Open the plan with plan_start (a short title). Ask each round of questions with inbox_ask, with options and one marked
recommended. After each round, post the whole plan with plan_version and one line on what changed. Keep asking until
the owner agrees, then close it with plan_close. Keep the whole plan in this one session.`;

export function StartForm({ machines, plan = false }: { machines: Machine[]; plan?: boolean }) {
  const folders = machines.flatMap((m) => (m.folders ?? []).map((f) => ({ ...f, machine: m.name })));
  const [pick, setPick] = useState(0);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function start() {
    const f = folders[pick];
    if (!f) return setError("No registered folder. Set WORK_ROOTS in the bridge's .env.");
    if (!prompt.trim()) return setError("Write what the session should do first.");
    setBusy(true);
    try {
      await startRun(f.machine, f.path, plan ? planPrompt(prompt.trim()) : prompt.trim());
      setPrompt("");
    } catch (e) {
      setError(String((e as { code?: string }).code ?? e));
    }
    setBusy(false);
  }

  return (
    <Section id={plan ? "plans.start" : "runs.start"} title={plan ? "Start a plan" : "Start a session"}>
      <select value={pick} onChange={(e) => setPick(Number(e.target.value))}>
        {folders.map((f, n) => (
          <option key={n} value={n}>
            {f.workType} · {f.machine} · {f.path}
          </option>
        ))}
      </select>
      <textarea
        rows={3}
        value={prompt}
        placeholder={plan ? "What should the plan be about?" : "What should the session do?"}
        onChange={(e) => {
          setPrompt(e.target.value);
          setError("");
        }}
      />
      {error && <p className="bad small">{error}</p>}
      <p className="muted small">
        {plan
          ? "Starts one session on that machine that plans with you: its questions come to the inbox, its versions show here."
          : "Runs your own Claude Code on that machine. Every tool call that needs approval comes to the inbox."}
      </p>
      <button className="primary" disabled={busy} onClick={start}>
        Start
      </button>
    </Section>
  );
}

// claude.ai names a Remote Control session "session_..."; the log names the same id "cse_...".
// Why a message waits (bridge/agent_bridge/runs.py wait_reason).
const WAIT_LABEL: Record<string, string> = {
  turn: "waiting for the session's turn to end",
  app: "waiting: last used in the app or a terminal, send it with Remote Control",
};

// What the wait rule saw on the last "Check now" (the owner's choice, 2026-11-02: "do both").
function StatusLine({ check }: { check?: Run }) {
  const c = check?.check;
  if (!check) return <span className="muted">Status: not checked yet.</span>;
  if (!c) return <span className="muted">Status: asking the PC.</span>;
  const when = `checked ${ago(check.endedAt)}`;
  if (c.open === null) return <span>Status: the PC could not read its process list ({when}).</span>;
  const turn = c.turn ? "a turn is running" : "no turn running";
  const open = c.open
    ? `open in ${c.openIn === "app" ? "the app" : "a terminal"} since ${new Date(c.openSince!).toLocaleTimeString()}: messages wait`
    : "closed: messages go now";
  return <span>Status: {open}, {turn} ({when}).</span>;
}

export const remoteUrl = (id: string) => `https://claude.ai/code/${id.replace(/^cse_/, "session_")}`;

export function MessageBox({ s, runs }: { s: Session; runs: Run[] }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mine = runs.filter((r) => r.action === "message" && r.sessionId === s.id);
  const check = runs.find((r) => r.action === "check" && r.sessionId === s.id);

  async function send() {
    if (!text.trim()) return setError("Write a message first.");
    setBusy(true);
    try {
      await sendMessage(s.machine, s.id, s.cwd, text.trim());
      setText("");
    } catch (e) {
      setError(String((e as { code?: string }).code ?? e));
    }
    setBusy(false);
  }

  return (
    <Section id="session.message" title="Send a message to this session" extra={mine.length ? `${mine.length} sent` : ""}>
      <textarea
        rows={3}
        value={text}
        placeholder="What should the session do next? (markdown works)"
        onChange={(e) => {
          setText(e.target.value);
          setError("");
        }}
      />
      {error && <p className="bad small">{error}</p>}
      <p className="small">
        <StatusLine check={check} />{" "}
        <button onClick={() => checkSession(s.machine, s.id)} disabled={check?.status === "new"}>
          {check?.status === "new" ? "Checking" : "Check now"}
        </button>
      </p>
      {s.remoteId && (
        <p className="small">
          <a href={remoteUrl(s.remoteId)} target="_blank" rel="noreferrer">
            Open this session in Remote Control
          </a>
          : what you type there shows in the open window and counts as you, approvals included. Needs Remote Control on in
          that window.
        </p>
      )}
      <p className="muted small">
        Send here runs in the background and the reply shows on this page. The message waits while the session is in a
        turn, and goes when the turn ends. A session last used in the app or a terminal may still be open there, so a
        message to it waits: use Remote Control above instead.
      </p>
      <button className="primary" disabled={busy} onClick={send}>
        Send
      </button>
      {mine.length > 0 && <RunList runs={mine} title="Messages to this session" />}
    </Section>
  );
}

// One switch for every run the dashboard sends: starts, plans, messages and late answers.
export function ModeSwitch() {
  const mode = useRunMode();
  if (!mode) return null;
  return (
    <div className="mode-switch">
      <span className="label">Approvals</span>
      <button className={mode === "manual" ? "tab on" : "tab"} onClick={() => setRunMode("manual")}>Manual</button>
      <button className={mode === "auto" ? "tab on" : "tab"} onClick={() => setRunMode("auto")}>Auto</button>
      <span className="muted small">
        {mode === "auto"
          ? "Claude Code's safety check approves most steps; the inbox gets the rest. For every run from here on."
          : "Every approval comes to the inbox. For every run from here on."}
      </span>
    </div>
  );
}

// Plan from a session (the owner's words, 2026-11-03: "get all the data from the session, read all real execution to
// start a plan"): the bridge reads the whole log in pages, notes each page, and a new session writes the plan.
export function PlanFromSession({ s, runs }: { s: Session; runs: Run[] }) {
  const [error, setError] = useState("");
  const mine = runs.filter((r) => r.action === "plan" && r.sourceSessionId === s.id);
  const going = mine.some((r) => r.status === "new" || r.status === "running");
  return (
    <Section id="session.plan" title="Plan from this session" extra={mine.length ? `${mine.length} made` : ""} open={false}>
      <p className="muted small">
        Reads this session's whole record on your PC: your prompts, the replies, every tool call and output, and each
        subagent's final report. It writes notes per page, then a new session writes the plan: goal, summary, rules,
        lessons and where they were applied, leftover, and steps. Nothing is changed.
      </p>
      {error && <p className="bad small">{error}</p>}
      <button className="primary" disabled={going} onClick={() => planFromSession(s).catch((e) => setError(String(e?.code ?? e)))}>
        {going ? "Reading" : "Plan from this session"}
      </button>
      {mine.length > 0 && <RunList runs={mine} title="Plans from this session" />}
    </Section>
  );
}

const KIND_NAME = Object.fromEntries(PLAN_KINDS) as Record<string, string>;

export function RunList({ runs, title = "Runs from the dashboard" }: { runs: Run[]; title?: string }) {
  const shown = runs.filter((r) => r.action === "start" || r.action === "message" || r.action === "plan");
  return (
    <div>
      <h2 className="label">{title}</h2>
      {shown.length === 0 && <p className="muted small">None yet.</p>}
      {shown.map((r) => (
        <Section
          key={r.id}
          id={"run." + r.id}
          open={LIVE.has(r.status)}
          tools={<MoreMenu path={`commands/${r.id}`} />}
          title={
            <span className="run-head">
              <span className={"status " + r.status}>{r.status === "waiting" ? WAIT_LABEL[r.waitReason ?? "turn"] : r.status}</span>
              <span>{(r.prompt ?? "").split("\n")[0].slice(0, 90)}</span>
            </span>
          }
          extra={
            <>
              {r.action === "message" ? (r.kind ? `plan message: ${KIND_NAME[r.kind]}` : "message")
                : r.action === "plan" ? `plan from session${r.status === "running" && r.stage ? ": " + r.stage : ""}` : "new session"}
              {r.quotes ? ` · quotes ${r.quotes.checked} checked, ${r.quotes.marked} marked` : ""}{" "}
              · {r.workType ?? ""} · {r.machine} ·{" "}
              {r.permissionMode === "auto" && <>auto · </>}
              {ago(r.startedAt ?? r.createdAt)}
              {r.costUsd != null && <> · {usd(r.costUsd)}</>}
            </>
          }
        >
          <p className="label">Prompt</p>
          <Md text={r.prompt} cwd={r.cwd ?? r.folder ?? ""} />
          {r.result && (
            <>
              <p className="label">Result</p>
              <Md text={r.result} cwd={r.cwd ?? r.folder ?? ""} />
            </>
          )}
          {r.error && <p className="bad small">{r.error}</p>}
          {r.status === "running" && (
            <div className="actions">
              <button onClick={() => stopRun(r.machine, r.id)}>Stop</button>
            </div>
          )}
          {r.status === "waiting" && (
            <div className="actions">
              <button onClick={() => cancelMessage(r.id)}>Cancel</button>
              {r.waitReason === "app" && (
                <button onClick={() => forceMessage(r.id)} disabled={r.force}>
                  {r.force ? "Sending anyway" : "Send anyway (a second process: the open window won't see it)"}
                </button>
              )}
            </div>
          )}
        </Section>
      ))}
    </div>
  );
}
