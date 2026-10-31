import { useState } from "react";
import { startRun, stopRun, type Machine, type Run } from "./data";
import { usd } from "./Dashboard";

const LIVE = new Set(["new", "running", "stopping"]);

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
    <section>
      <h2>Start a session</h2>
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
    </section>
  );
}

export function RunList({ runs }: { runs: Run[] }) {
  const starts = runs.filter((r) => r.action === "start");
  return (
    <section>
      <h2>Runs from the dashboard</h2>
      {starts.length === 0 && <p className="muted small">None yet.</p>}
      {starts.map((r) => (
        <div key={r.id} className="run">
          <div className="small">
            <span className={LIVE.has(r.status) ? "dot live" : "dot"} /> <strong>{r.status}</strong> · {r.workType ?? ""} ·{" "}
            {r.machine} · {ago(r.startedAt ?? r.createdAt)}
            {r.costUsd != null && <> · {usd(r.costUsd)}</>}
          </div>
          <p className="quote small">{r.prompt}</p>
          {r.result && <p className="quote small">{r.result}</p>}
          {r.error && <p className="bad small">{r.error}</p>}
          {r.status === "running" && (
            <button onClick={() => stopRun(r.machine, r.id)}>Stop</button>
          )}
        </div>
      ))}
    </section>
  );
}
