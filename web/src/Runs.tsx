import { useState } from "react";
import { sendMessage, startRun, stopRun, type Machine, type Run, type Session } from "./data";
import { usd } from "./Dashboard";
import { Md } from "./Markdown";
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

export function StartForm({ machines }: { machines: Machine[] }) {
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
      await startRun(f.machine, f.path, prompt.trim());
      setPrompt("");
    } catch (e) {
      setError(String((e as { code?: string }).code ?? e));
    }
    setBusy(false);
  }

  return (
    <Section id="runs.start" title="Start a session">
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
        placeholder="What should the session do?"
        onChange={(e) => {
          setPrompt(e.target.value);
          setError("");
        }}
      />
      {error && <p className="bad small">{error}</p>}
      <p className="muted small">
        Runs your own Claude Code on that machine. Every tool call that needs approval comes to the inbox.
      </p>
      <button className="primary" disabled={busy} onClick={start}>
        Start
      </button>
    </Section>
  );
}

export function MessageBox({ s, runs }: { s: Session; runs: Run[] }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mine = runs.filter((r) => r.action === "message" && r.sessionId === s.id);

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
      <p className="muted small">
        The bridge resumes the session with your message once it is closed. If it is open in a terminal or the desktop app,
        the message waits; close that window to let it through.
      </p>
      <button className="primary" disabled={busy} onClick={send}>
        Send
      </button>
      {mine.length > 0 && <RunList runs={mine} title="Messages to this session" />}
    </Section>
  );
}

export function RunList({ runs, title = "Runs from the dashboard" }: { runs: Run[]; title?: string }) {
  const shown = runs.filter((r) => r.action === "start" || r.action === "message");
  return (
    <div>
      <h2 className="label">{title}</h2>
      {shown.length === 0 && <p className="muted small">None yet.</p>}
      {shown.map((r) => (
        <Section
          key={r.id}
          id={"run." + r.id}
          open={LIVE.has(r.status)}
          title={
            <span className="run-head">
              <span className={"status " + r.status}>{r.status === "waiting" ? "waiting for the session to close" : r.status}</span>
              <span>{(r.prompt ?? "").split("\n")[0].slice(0, 90)}</span>
            </span>
          }
          extra={
            <>
              {r.action === "message" ? "message" : "new session"} · {r.workType ?? ""} · {r.machine} ·{" "}
              {ago(r.startedAt ?? r.createdAt)}
              {r.costUsd != null && <> · {usd(r.costUsd)}</>}
            </>
          }
        >
          <p className="label">Prompt</p>
          <Md text={r.prompt} />
          {r.result && (
            <>
              <p className="label">Result</p>
              <Md text={r.result} />
            </>
          )}
          {r.error && <p className="bad small">{r.error}</p>}
          {r.status === "running" && (
            <div className="actions">
              <button onClick={() => stopRun(r.machine, r.id)}>Stop</button>
            </div>
          )}
        </Section>
      ))}
    </div>
  );
}
