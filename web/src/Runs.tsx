import { useEffect, useRef, useState } from "react";
import { forSession, QUOTE_EVENT, takeQuote } from "./quote";
import {
  addRoot, cancelMessage, checkSession, continueRun, forceMessage, setAutoContinue, planFromSession, PLAN_KINDS, sendMessage, setRunMode, startRun, stopRun, useRunMode,
  EFFORTS, exactEffort, exactModel, FRESH_OVER, MODELS, setRunPrefs, useRunPrefs, type Fresh, type RunWith,
  type Machine, type Run, type Session,
} from "./data";
import { num, usd } from "./Dashboard";
import { Md } from "./Markdown";
import { LiveText, PcText } from "./FileView";
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

// The prompt behind "Start a plan" (the owner's choice, 2026-11-02: "Do 1"): one session runs the whole plan. Pictures
// come when the owner asks (2026-11-04: "when almost good or whenever I need I will ask to generate the images,
// diagrams, graph, screenshot, mockup, data"; choice "Drop the auto mockup, keep option examples"), through the plan's
// Generate (planCheck.ts); an option the owner will see still carries before and after pictures ("images ... will need
// to show me the before and after").
export const planPrompt = (topic: string) =>
  `Plan this with the owner: ${topic}

Open the plan with plan_start (a short title). Make images, diagrams, mockups, screenshots and data only when the owner
asks. When an option changes what the owner will see (a screen, a layout, a picture), its example is an image example
with before and after pictures. Ask each round of questions with inbox_ask, with options and one marked
recommended. After each round, post the whole plan with plan_version and one line on what changed. Keep asking until
the owner agrees. Only the owner closes a plan, on the page. Keep the whole plan in this one session.`;

// Model and effort for one run, preset to the setting on the Runs tab (the owner's pick, 2026-11-10: "Setting plus a
// choice on each message"). Exact names only, no "default" (2026-11-10: "I want exact option"); untouched, it shows the setting.
export function RunWithPicker({ value, onChange, compact = false, fresh = false }: { value: RunWith; onChange: (w: RunWith) => void; compact?: boolean; fresh?: boolean }) {
  const prefs = useRunPrefs();
  // the exact values; untouched, the run takes the Runs tab setting, shown here by its exact name
  const model = value.model || exactModel(prefs?.model);
  const effort = value.effort || exactEffort(prefs?.effort);
  return (
    <span className={"run-with" + (compact ? " compact" : "")} title="Model and effort for this run; starts on the setting on the Runs tab">
      <select value={model} onChange={(e) => onChange({ ...value, model: e.target.value })} aria-label="model">
        {MODELS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
      </select>
      <select value={effort} onChange={(e) => onChange({ ...value, effort: e.target.value })} aria-label="effort">
        {EFFORTS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
      </select>
      {fresh && (
        <select value={value.fresh ?? "auto"} onChange={(e) => onChange({ ...value, fresh: e.target.value as Fresh })} aria-label="fresh session with a handoff"
          title="A fresh session with a handoff keeps turns fast; auto follows the size rule on the Runs tab">
          <option value="auto">handoff: auto{prefs ? ` (over ${prefs.freshOver ? num(prefs.freshOver) : "off"})` : ""}</option>
          <option value="always">fresh with a handoff</option>
          <option value="never">resume as is</option>
        </select>
      )}
    </span>
  );
}

export function StartForm({ machines, plan = false }: { machines: Machine[]; plan?: boolean }) {
  const folders = machines.flatMap((m) => (m.folders ?? []).map((f) => ({ ...f, machine: m.name })));
  const [pick, setPick] = useState(0);
  const [w, setW] = useState<RunWith>({});
  const [keep, setKeep] = useState(true);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function start() {
    const f = folders[pick];
    if (!f) return setError("No registered folder. Set WORK_ROOTS in the bridge's .env.");
    if (!prompt.trim()) return setError("Write what the session should do first.");
    setBusy(true);
    try {
      await startRun(f.machine, f.path, plan ? planPrompt(prompt.trim()) : prompt.trim(), w, plan || keep);
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
      <RunWithPicker value={w} onChange={setW} />
      {!plan && (
        <label className="small keep-session">
          <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> keep the session
          <span className="muted"> (untick for a one-off job: nothing is saved, no session on the list, no message after)</span>
        </label>
      )}
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
      {!plan && <AddFolder machines={machines} />}
    </Section>
  );
}

// Step i4 (the owner's choice, 2026-11-12: "Bridge checks"): add a work folder on a machine; usable with no restart.
function AddFolder({ machines }: { machines: Machine[] }) {
  const [open, setOpen] = useState(false);
  const [machine, setMachine] = useState(machines[0]?.name ?? "");
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open) return <p className="small"><button onClick={() => setOpen(true)}>Add a work folder</button></p>;
  async function add() {
    const m = machine || machines[0]?.name;
    if (!m || !name.trim() || !folder.trim()) return setNote({ ok: false, text: "Pick a machine, give a name and the whole path." });
    setBusy(true);
    setNote({ ok: true, text: "asking the bridge" });
    const sent = Date.now();
    try {
      await addRoot(m, name.trim(), folder.trim(), (ok, why) => {
        setBusy(false);
        setNote({ ok, text: ok ? `Added ${why} in ${((Date.now() - sent) / 1000).toFixed(1)} s: pick it above.` : why });
        if (ok) (setName(""), setFolder(""));
      });
    } catch (e) {
      setBusy(false);
      setNote({ ok: false, text: String((e as { code?: string }).code ?? e) });
    }
  }
  return (
    <div className="add-folder">
      <p className="label">Add a work folder</p>
      {machines.length > 1 && (
        <select value={machine} onChange={(e) => setMachine(e.target.value)}>
          {machines.map((m) => (
            <option key={m.name} value={m.name}>{m.name}</option>
          ))}
        </select>
      )}
      <input value={name} placeholder="name, such as labs" onChange={(e) => (setName(e.target.value), setNote(null))} />
      <input value={folder} placeholder="whole path, such as K:\Projects\new" onChange={(e) => (setFolder(e.target.value), setNote(null))} />
      {note && <p className={(note.ok ? "muted" : "bad") + " small"}>{note.text}</p>}
      <p className="muted small">The bridge refuses a drive root, your user folder, AppData and .ssh.</p>
      <button disabled={busy} onClick={add}>Add</button>
    </div>
  );
}

// claude.ai names a Remote Control session "session_..."; the log names the same id "cse_...".
// Why a message waits (bridge/agent_bridge/runs.py wait_reason).
const ARCHIVE_LABEL: Record<string, string> = {
  asked: "the archiver is asked to free the session",
  archived: "session archived, sending now",
  unarchiving: "sent; unarchiving the session",
  done: "sent; the session is back in your list",
  refused: "the archiver could not free it",
  "unarchive failed": "sent; unarchive failed: unarchive it in the app",
};
const WAIT_LABEL: Record<string, string> = {
  turn: "waiting for the session's turn to end",
  app: "waiting: last used in the app or a terminal, send it with Remote Control",
  upgrade: "waiting: the plan is being moved to the latest format first",
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
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    // "Ask about this" on words of this session or of its runs (SelectAsk.tsx): the quote lands here
    const fill = () => {
      const q = takeQuote(forSession(s.id));
      if (!q) return;
      setText((t) => (t.trim() ? t.trimEnd() + "\n\n" : "") + q.text + "\n\n");
      setTimeout(() => {
        const el = box.current;
        if (!el) return;
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }, 0);
    };
    fill();
    window.addEventListener(QUOTE_EVENT, fill);
    return () => window.removeEventListener(QUOTE_EVENT, fill);
  }, [s.id]);
  const [w, setW] = useState<RunWith>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mine = runs.filter((r) => r.action === "message" && r.sessionId === s.id);
  const check = runs.find((r) => r.action === "check" && r.sessionId === s.id);

  async function send() {
    if (!text.trim()) return setError("Write a message first.");
    setBusy(true);
    try {
      await sendMessage(s.machine, s.id, s.cwd, text.trim(), w);
      setText("");
    } catch (e) {
      setError(String((e as { code?: string }).code ?? e));
    }
    setBusy(false);
  }

  return (
    <Section id="session.message" title="Send a message to this session" extra={mine.length ? `${mine.length} sent` : ""}>
      <textarea
        ref={box}
        rows={3}
        value={text}
        placeholder="What should the session do next? (markdown works)"
        onChange={(e) => {
          setText(e.target.value);
          setError("");
        }}
      />
      <RunWithPicker value={w} onChange={setW} fresh />
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
  const prefs = useRunPrefs();
  if (!mode) return null;
  return (
    <div className="mode-switch">
      <span className="label">Approvals</span>
      <button className={mode === "manual" ? "tab on" : "tab"} onClick={() => setRunMode("manual")}>Manual</button>
      <button className={mode === "auto" ? "tab on" : "tab"} onClick={() => setRunMode("auto")}>Auto</button>
      <span className="label">Model</span>
      <select value={exactModel(prefs?.model)} onChange={(e) => setRunPrefs({ model: e.target.value })} aria-label="model setting">
        {MODELS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
      </select>
      <span className="label">Effort</span>
      <select value={exactEffort(prefs?.effort)} onChange={(e) => setRunPrefs({ effort: e.target.value })} aria-label="effort setting">
        {EFFORTS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
      </select>
      <span className="label">Fresh with a handoff over</span>
      <select value={prefs?.freshOver ?? 300000} onChange={(e) => setRunPrefs({ freshOver: Number(e.target.value) })} aria-label="fresh session over"
        title="A message to a session whose context is over this size goes to a fresh session with a handoff: faster turns, less of your 5-hour window">
        {FRESH_OVER.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
      </select>
      <span className="muted small">Model and effort for every run from here on, unless a message picks its own. Over the size, a message starts a fresh session with a handoff (the last turns and the plan) instead of resuming the whole conversation.</span>
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
  const [goal, setGoal] = useState("");
  const mine = runs.filter((r) => r.action === "plan" && r.sourceSessionId === s.id);
  const going = mine.some((r) => r.status === "new" || r.status === "running");
  return (
    <Section id="session.plan" title="Plan from this session" extra={mine.length ? `${mine.length} made` : ""} open={false}>
      <p className="muted small">
        Reads this session's whole record on your PC: your prompts, the replies, every tool call and output, and each
        subagent's final report. It writes notes per page, then a new session writes the plan: goal, summary, rules,
        lessons and where they were applied, leftover, and steps. Nothing is changed.
      </p>
      <textarea rows={3} value={goal} placeholder="Goal for the new plan (optional). The session's record is read as data and the plan focuses on this goal."
        onChange={(e) => (setGoal(e.target.value), setError(""))} />
      {error && <p className="bad small">{error}</p>}
      <button className="primary" disabled={going} onClick={() => planFromSession(s, goal).then(() => setGoal("")).catch((e) => setError(String(e?.code ?? e)))}>
        {going ? "Reading" : "Plan from this session"}
      </button>
      {mine.length > 0 && <RunList runs={mine} title="Plans from this session" />}
    </Section>
  );
}

const KIND_NAME = Object.fromEntries(PLAN_KINDS) as Record<string, string>;

// Continue on a paused run, or a failed plan from a session (bridge runs.py continue_run): the leftover work only. The
// run that paused last continues by itself at the reset; any other paused run does when the owner turns Auto on.
function ContinueBar({ r }: { r: Run }) {
  const [sent, setSent] = useState<"" | "continue" | "auto">("");
  const [error, setError] = useState("");
  if (r.continuedBy) return <p className="muted small">Continued as run {r.continuedBy}.</p>;
  const paused = r.status === "paused";
  if (!paused && !(r.action === "plan" && r.status === "failed")) return null;
  const at = r.pausedUntilAt ? new Date(r.pausedUntilAt).toLocaleString() : "";
  const fail = (e: unknown) => (setSent(""), setError(String((e as { code?: string }).code ?? e)));
  return (
    <div className="actions">
      {paused && (
        <p className="small">
          {!at ? "Reset time unknown: press Continue after the limit lifts."
            : r.autoContinue ? `Continues by itself at ${at}${r.autoBy === "owner" ? " (your pick)" : " (the last paused run)"}.`
            : `Waits for Continue (the limit resets ${at}).`}
        </p>
      )}
      <button className="primary" disabled={sent === "continue"}
        onClick={() => (setSent("continue"), continueRun(r.machine, r.id).catch(fail))}>
        {sent === "continue" ? "Continuing" : "Continue"}
      </button>
      {paused && at && (
        <button disabled={sent === "auto"} onClick={() => (setSent("auto"), setAutoContinue(r.machine, r.id, !r.autoContinue).then(() => setSent("")).catch(fail))}>
          {r.autoContinue ? "Auto at reset: on (turn off)" : "Auto at reset: off (turn on)"}
        </button>
      )}
      {error && <p className="bad small">{error}</p>}
    </div>
  );
}

// Where words of a run are quoted (SelectAsk.tsx): a plan's run to the plan's box, any other run to its session's box;
// a one-off run has no session to send to.
const quoteTarget = (r: Run): Record<string, string> =>
  r.planId ? { "data-quote-plan": r.planId } : r.sessionId && !r.noSession ? { "data-quote-session": r.sessionId } : {};

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
          open={LIVE.has(r.status) || (r.status === "paused" && !r.continuedBy)}
          tools={<MoreMenu path={`commands/${r.id}`} />}
          title={
            <span className="run-head">
              <span className={"status " + r.status}>{r.status === "waiting" ? WAIT_LABEL[r.waitReason ?? "turn"] : r.status === "paused" ? `paused until ${r.pausedUntil ?? "the limit resets"}` : r.status}</span>
              <span>{(r.prompt ?? "").split("\n")[0].slice(0, 90)}</span>
            </span>
          }
          extra={
            <>
              {r.action === "message" ? (r.kind ? `plan message: ${KIND_NAME[r.kind]}` : "message")
                : r.action === "plan" ? `plan from session${r.status === "running" && r.stage ? ": " + r.stage : ""}` : "new session"}
              {r.archive ? ` · ${ARCHIVE_LABEL[r.archive] ?? r.archive}${r.archiveNote ? ": " + r.archiveNote : ""}` : ""}
              {r.quotes ? ` · quotes ${r.quotes.checked} checked, ${r.quotes.marked} marked` : ""}{" "}
              · {r.workType ?? ""} · {r.machine} ·{" "}
              {r.permissionMode === "auto" && <>auto · </>}
              {r.noSession && <>one-off · </>}
              {r.freshFrom && <>fresh with a handoff from {r.freshFrom.slice(0, 8)} ({num(r.contextTokens ?? 0)} tok) · </>}
              {r.model && <>{r.model} · </>}
              {r.effort && <>{r.effort} · </>}
              {ago(r.startedAt ?? r.createdAt)}
              {r.costUsd != null && <> · {usd(r.costUsd)}</>}
            </>
          }
        >
          <div {...quoteTarget(r)}>
          <p className="label">Prompt</p>
          <Md text={r.prompt} cwd={r.cwd ?? r.folder ?? ""} />
          {(r.status === "done" || r.status === "lost") && (
            <>
              <p className="label">Result</p>
              <PcText run={r.id} cwd={r.cwd ?? r.folder ?? ""} />
            </>
          )}
          </div>
          {r.error && <p className="bad small">{r.error}</p>}
          {r.status === "running" && r.action !== "plan" && (
            <>
              <p className="label">Live</p>
              <LiveText run={r.id} cwd={r.cwd ?? r.folder ?? ""} />
            </>
          )}
          {r.status === "running" && (
            <div className="actions">
              <button onClick={() => stopRun(r.machine, r.id)}>Stop</button>
            </div>
          )}
          <ContinueBar r={r} />
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
