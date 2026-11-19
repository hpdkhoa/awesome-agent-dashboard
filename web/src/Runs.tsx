import { useEffect, useRef, useState } from "react";
import { forSession, QUOTE_EVENT, takeQuote } from "./quote";
import {
  addRoot, localRun, newestFirst, PAGE, cancelMessage, checkSession, continueRun, forceMessage, setAutoContinue, planFromSession, PLAN_KINDS, searchRun, sendMessage, setRunMode, startRun, stopRun, useRunMode,
  EFFORTS, exactEffort, exactModel, FRESH_OVER, MODELS, setRunPrefs, useRunPrefs, type Fresh, type RunWith,
  type LocalModel, type Machine, type Run, type Session,
} from "./data";
import { boxes, bridgePost, postTo } from "./bridge";
import { num, usd } from "./Dashboard";
import { Md } from "./Markdown";
import { LiveText, PcText } from "./FileView";
import { MoreMenu } from "./MoreMenu";
import { Section } from "./Section";
import { dt, tm, ago } from "./fmt";

const LIVE = new Set(["new", "waiting", "running", "stopping"]);


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

// plan 1c08f4c2 s5: every machine's local models, as "machine / model" with the model's score (the gate task set, s6)
const localChoices = (machines: Machine[]) =>
  machines.flatMap((m) => (m.avatar?.localModels?.models ?? []).map((x) => ({ machine: m.name, model: x })));
export const scoreText = (x: LocalModel) =>
  x.score ? `score ${x.score.pass}/${x.score.runs}${x.score.tokensPerSec != null ? `, ${x.score.tokensPerSec} tok/s` : ""}` : "no score yet";

export function StartForm({ machines, plan = false }: { machines: Machine[]; plan?: boolean }) {
  const folders = machines.flatMap((m) => (m.folders ?? []).map((f) => ({ ...f, machine: m.name })));
  const locals = plan ? [] : localChoices(machines);
  const [engine, setEngine] = useState("claude"); // "claude", or the index of a local model in locals
  const local = engine === "claude" ? null : locals[Number(engine)] ?? null;
  const [files, setFiles] = useState<string[]>([]);
  const [pick, setPick] = useState(0);
  const [w, setW] = useState<RunWith>({});
  const [keep, setKeep] = useState(true);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function start() {
    if (local) {
      if (!prompt.trim()) return setError("Write what the local model should do first.");
      setBusy(true);
      try {
        await localRun(local.machine, local.model.name, prompt.trim(), files);
        setPrompt("");
      } catch (e) {
        setError(String((e as { code?: string }).code ?? e));
      }
      return setBusy(false);
    }
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
      {!plan && (
        <div className="engine-pick" data-mark="engine">
          <span className="label">Run with</span>
          <select value={engine} onChange={(e) => (setEngine(e.target.value), setError(""))} aria-label="run with">
            <option value="claude">Claude Code (your plan)</option>
            {locals.map((l, n) => (
              <option key={n} value={String(n)}>
                {l.machine} / {l.model.name}{l.model.params ? ` · ${l.model.params}` : ""} · {scoreText(l.model)}
              </option>
            ))}
          </select>
          {!locals.length && <span className="muted small"> no local model published by a bridge yet</span>}
        </div>
      )}
      {local && <p className="small model-score" data-mark="score">{local.machine} / {local.model.name}{local.model.quant ? ` · ${local.model.quant}` : ""} · {scoreText(local.model)}</p>}
      {!local && (
        <select value={pick} onChange={(e) => setPick(Number(e.target.value))}>
          {folders.map((f, n) => (
            <option key={n} value={n}>
              {f.workType} · {f.machine} · {f.path}
            </option>
          ))}
        </select>
      )}
      {!local && <RunWithPicker value={w} onChange={setW} />}
      {local && <FilePicker machine={local.machine} picked={files} onChange={setFiles} />}
      {!plan && !local && (
        <label className="small keep-session">
          <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> keep the session
          <span className="muted"> (untick for a one-off job: nothing is saved, no session on the list, no message after)</span>
        </label>
      )}
      <textarea
        rows={3}
        value={prompt}
        placeholder={plan ? "What should the plan be about?" : local ? "What should the local model answer? The picked files go with it." : "What should the session do?"}
        onChange={(e) => {
          setPrompt(e.target.value);
          setError("");
        }}
      />
      {error && <p className="bad small">{error}</p>}
      <p className="muted small">
        {plan
          ? "Starts one session on that machine that plans with you: its questions come to the inbox, its versions show here."
          : local
            ? `Runs ${local.model.name} on the Ollama of ${local.machine} through its bridge, not Claude Code: prompt in, answer out, no tools. Files only from that machine's work folders. Counted in tokens, $0.`
            : "Runs your own Claude Code on that machine. Every tool call that needs approval comes to the inbox."}
      </p>
      <button className="primary" disabled={busy} onClick={start}>
        {local ? "Run locally" : "Start"}
      </button>
      {!plan && !local && <AddFolder machines={machines} />}
    </Section>
  );
}

// plan 1c08f4c2 s5 file picker: browse a machine's work folders (bridge POST /list, files.py listing) and tick files
// for a local run. Secret files are never listed; a folder outside the work folders is refused by the bridge.
type Listing = { folder: string; parent: string | null; entries: { name: string; path: string; dir: boolean; size?: number }[]; more?: number };
async function listOn(machine: string, folder: string): Promise<Listing> {
  const box = (await boxes()).find((b) => b.name === machine);
  return box ? postTo<Listing>(box.url, "/list", { folder }) : bridgePost<Listing>("/list", { folder });
}
const kb = (n?: number) => (n == null ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
export function FilePicker({ machine, picked, onChange }: { machine: string; picked: string[]; onChange: (p: string[]) => void }) {
  const [folder, setFolder] = useState("");
  const [list, setList] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setError("");
    listOn(machine, folder).then((l) => live && setList(l)).catch((e) => live && setError(String((e as Error).message ?? e)));
    return () => { live = false; };
  }, [machine, folder]);
  const toggle = (p: string) => onChange(picked.includes(p) ? picked.filter((x) => x !== p) : [...picked, p]);
  return (
    <div className="file-picker" data-mark="files">
      <p className="label">Files for the model ({picked.length} picked)</p>
      {picked.map((p) => (
        <p key={p} className="small picked"><button className="link" onClick={() => toggle(p)} title="remove">✕</button> {p}</p>
      ))}
      <p className="small muted">{list?.folder || "work folders"}{list && list.parent !== null && <> · <button className="link" onClick={() => setFolder(list.parent ?? "")}>up</button></>}</p>
      {error && <p className="bad small">{error}</p>}
      <div className="file-list">
        {(list?.entries ?? []).map((e) => e.dir ? (
          <p key={e.path} className="small"><button className="link" onClick={() => setFolder(e.path)}>📁 {e.name}</button></p>
        ) : (
          <label key={e.path} className="small"><input type="checkbox" checked={picked.includes(e.path)} onChange={() => toggle(e.path)} /> {e.name} <span className="muted">{kb(e.size)}</span></label>
        ))}
        {!!list?.more && <p className="muted small">{list.more} more not shown</p>}
      </div>
    </div>
  );
}

// s9 (plan c5cb9485, the owner's pick "A: top of the Runs tab"): ask the web through a machine's bridge (Gemini Flash +
// Google Search, bridge search.py). The answer streams in under the box; the search is also a run in the list below.
const secs = (ms?: number | null) => (ms == null ? "" : `${(ms / 1000).toFixed(1)} s`);
export function SearchBox({ machines, runs }: { machines: Machine[]; runs: Run[] }) {
  const [box, setBox] = useState("");
  const [q, setQ] = useState("");
  const [mine, setMine] = useState<string | null>(null);
  const [error, setError] = useState("");
  const name = box || machines[0]?.name || "";
  const r = runs.find((x) => x.id === mine);
  async function go() {
    if (!name) return setError("No machine yet: start a bridge first.");
    if (!q.trim()) return setError("Write a question first.");
    setError("");
    try {
      setMine(await searchRun(name, q.trim()));
    } catch (e) {
      setError(String((e as { code?: string }).code ?? e));
    }
  }
  return (
    <Section id="runs.search" title="Search the web (Gemini Flash + Google Search)" extra={r ? r.status : ""}>
      <div className="search-row">
        <select value={name} onChange={(e) => setBox(e.target.value)}>
          {machines.map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
        </select>
        <input value={q} placeholder="ask the web..." onChange={(e) => (setQ(e.target.value), setError(""))}
          onKeyDown={(e) => e.key === "Enter" && go()} />
        <button className="primary" disabled={!!r && LIVE.has(r.status)} onClick={go}>Search</button>
      </div>
      {error && <p className="bad small">{error}</p>}
      <p className="muted small">Runs on that machine's bridge with the Gemini key in its .env; the question goes to Google. Each search is a run.</p>
      {mine && !r && <p className="muted small">sent…</p>}
      {r && (
        <div className="search-answer">
          <p className="small">
            <span className={"status " + r.status}>{r.status}</span>
            {r.model && <> · {r.model}</>}
            {r.firstTokenMs != null && <> · first token {secs(r.firstTokenMs)}</>}
            {r.totalMs != null && <> · total {secs(r.totalMs)}</>}
            {r.sources && <> · {r.sources.length} sources</>}
          </p>
          {r.status === "running" && <LiveText run={r.id} cwd="" />}
          {(r.status === "done" || r.status === "stopped") && <PcText run={r.id} cwd="" />}
          {r.error && <p className="bad small">{r.error}</p>}
        </div>
      )}
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
    ? `open in ${c.openIn === "app" ? "the app" : "a terminal"} since ${tm(c.openSince!)}: messages wait`
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
  const at = r.pausedUntilAt ? dt(r.pausedUntilAt) : "";
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

// paged: the newest PAGE rows, the rest behind Show more, PAGE more a click (the owner's words, 2026-11-14: "I want to
// see the messages newest and top 10, the rest show in show more"). The rows are already read, so Show more reads nothing.
export function RunList({ runs, title = "Runs from the dashboard", paged = false }: { runs: Run[]; title?: string; paged?: boolean }) {
  // newest first wherever a list of runs shows: the Runs tab, messages to a session, messages on a plan (2026-11-14)
  const all = newestFirst(runs.filter((r) => r.action === "start" || r.action === "message" || r.action === "plan" || r.action === "search" || r.action === "local"), "createdAt");
  const [count, setCount] = useState(PAGE);
  const shown = paged ? all.slice(0, count) : all;
  return (
    <div>
      <h2 className="label">{title}{paged && all.length > PAGE ? ` (${shown.length} of ${all.length})` : ""}</h2>
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
              {(r.headline || r.status === "running") && <Headline r={r} />}
              {r.endGuard && <EndGuard g={r.endGuard} />}
            </span>
          }
          extra={
            <>
              {r.action === "message" ? (r.kind ? `plan message: ${KIND_NAME[r.kind]}` : "message")
                : r.action === "plan" ? `plan from session${r.status === "running" && r.stage ? ": " + r.stage : ""}`
                : r.action === "search" ? `search${r.firstTokenMs != null ? " · first token " + secs(r.firstTokenMs) : ""}${r.sources ? ` · ${r.sources.length} sources` : ""}`
                : r.action === "local" ? `local run${r.tokensPerSec != null ? ` · ${r.tokensPerSec} tok/s` : ""}${r.promptTokens != null ? ` · ${num(r.promptTokens)} in / ${num(r.outputTokens ?? 0)} out tokens` : ""} · $0`
                : "new session"}
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
          <KbLine r={r} />
          <p className="label">Prompt</p>
          <Md text={r.prompt} cwd={r.cwd ?? r.folder ?? ""} />
          {r.action === "local" && (r.context ?? []).length > 0 && (
            <>
              <p className="label">Context sent</p>
              {r.context!.map((c) => (
                <p key={c.name} className="small">{c.name}: {num(c.sent)} of {num(c.chars)} chars{c.chunks ? ` (chunks ${c.chunks})` : ""}</p>
              ))}
            </>
          )}
          {r.stoppedOnRepeat && <p className="small bad">Stopped: the answer repeated itself.</p>}
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
          {/* the owner's words, 2026-11-18: "the stop button always show when run item is not done or stopped or canceled" */}
          {r.status !== "done" && r.status !== "stopped" && r.status !== "cancelled" && (
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
      {shown.length < all.length && (
        <button className="link small" onClick={() => setCount(count + PAGE)}>
          Show more ({Math.min(PAGE, all.length - shown.length)} older of {all.length - shown.length} left)
        </button>
      )}
    </div>
  );
}


// F11 run end guard (plan bf73af63; the step: "a run that ends on a promise ('I will ...') or with an open step is
// flagged"): shown on the run's head, so it is seen with the run folded
function EndGuard({ g }: { g: NonNullable<Run["endGuard"]> }) {
  if (g.error) return <span className="end-guard" data-end-guard="error" title={g.error}>⚠ end guard failed</span>;
  return (
    <span className="end-guard" data-end-guard={[g.promise ? "promise" : "", g.openStep ? "open-step" : ""].filter(Boolean).join(" ")}>
      {g.promise && <span title={g.promise.join(" / ")}>⚠ ends on a promise: "{g.promise[0].slice(0, 110)}"{g.promise.length > 1 ? ` (+${g.promise.length - 1})` : ""}</span>}
      {g.promise && g.openStep && " · "}
      {g.openStep && <span>⚠ no report on step {g.openStep} this run</span>}
    </span>
  );
}


// KB first on each run (plan bf73af63 F1): the records the bridge gave the run, which its report cited, and the rule
// versions it ran under (F3). A rule above v1 is named with its version, so an edited rule shows on the next run.
function KbLine({ r }: { r: Run }) {
  if (!r.kb && !r.rulesAt) return null;
  const given = r.kb?.given ?? [];
  const cited = new Set(r.kb?.cited ?? []);
  const rules = Object.entries(r.rulesAt ?? {});
  const moved = rules.filter(([, v]) => v > 1).sort((a, b) => b[1] - a[1]);
  return (
    <p className="small kb-line" data-kb-line>
      <b>KB</b>{" "}
      {r.kb?.error ? <span className="bad">records failed: {r.kb.error}</span>
        : given.length === 0 ? <span className="muted">no record matched</span>
        : <>{given.length} given ({given.map((g, i) => <span key={g}>{i ? ", " : ""}<span className={cited.has(g) ? "good" : ""}>{g}</span></span>)})
            {" · "}{r.kb?.cited ? `${cited.size} cited` : "not cited yet"}{r.kb?.how && r.kb.how !== "meaning+words" ? ` · ${r.kb.how}` : ""}</>}
      {rules.length > 0 && <>{" · "}<b>rules</b> {rules.length}{moved.length > 0 && <> ({moved.map(([k, v]) => `${k} v${v}`).join(", ")})</>}
        {(r.rulesChanged ?? []).length > 0 && <span className="warn"> · new version: {r.rulesChanged!.join(", ")}</span>}</>}
    </p>
  );
}


// F2 session headline (plan bf73af63; the source rule, rules-review.md section 15: "Update the headline at least every 5
// minutes: what you're doing now and next. Heavy work shows a percentage plus done/total units and an ETA"). The session
// writes it with the inbox tool headline; older than 5 minutes on a running run it shows as stale.
const STALE_MS = 5 * 60 * 1000;
function Headline({ r }: { r: Run }) {
  const [t, setT] = useState(Date.now());
  useEffect(() => {
    if (r.status !== "running") return;
    const i = setInterval(() => setT(Date.now()), 15000);
    return () => clearInterval(i);
  }, [r.status]);
  const h = r.headline;
  if (!h) return <span className="headline stale" data-headline="none">no headline yet</span>;
  const age = t - Date.parse(h.at);
  const stale = r.status === "running" && age > STALE_MS;
  const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <span className={stale ? "headline stale" : "headline"} data-headline={stale ? "stale" : "fresh"}>
      <b>Now</b> {h.now}{h.next && <> · <b>Next</b> {h.next}</>}
      {h.total != null && <> · {h.done}/{h.total} ({h.pct}%)<progress max={h.total} value={h.done} /></>}
      {h.eta && <> · ETA {clock(h.eta)}</>}
      <span className="muted"> · {Math.max(0, Math.round(age / 60000))} min ago{stale ? " (stale: over 5 min)" : ""}</span>
    </span>
  );
}
