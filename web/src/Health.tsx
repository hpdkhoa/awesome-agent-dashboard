import { useEffect, useRef, useState } from "react";
import { auth } from "./firebase";
import { filesUrl } from "./FileView";

// The health panel (plan 4672cf3d step i10). The owner's choices, 2026-11-12: "Ping through the tunnel" (this page asks
// the bridge's signed POST /health every 20 s while it is open: no answer is red, 0 Firestore writes); "Task watchdog"
// (the Windows task starts a stopped bridge within 1 min); "Load new code" (Update shows when the repo's commit is not
// the one the bridge runs, and restarts to load it). Restart and Update: "Confirm tap, owner only" (round 2); the
// bridge writes who and when to its restarts.log (bridge/agent_bridge/health.py).

export type HealthAnswer = {
  alive: boolean; machine: string; pid: number; startedAt: string; uptimeSeconds: number; runningCommit: string;
  repoCommit: string; newCode: boolean; lastSync: string; runsGoing: number; lastRestart: string; at: string;
  errors: { count: number; hours: number; last: { at: string; line: string }[] };
};
export type HealthState =
  | { kind: "wait" }
  | { kind: "ok"; h: HealthAnswer; at: number }
  | { kind: "down"; why: string; since: number; last?: HealthAnswer };

const EVERY_MS = 20_000;
const FAST_MS = 3_000; // after a restart tap, until the bridge answers with a new start time
const TIMEOUT_MS = 8_000;

async function call<T>(path: string, body: unknown): Promise<T> {
  const url = await filesUrl();
  if (!url) throw new Error("The file viewer is off: set FILES_URL on the bridge.");
  const token = await auth.currentUser?.getIdToken();
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), TIMEOUT_MS);
  let r: Response;
  try {
    r = await fetch(url + path, {
      method: "POST",
      signal: stop.signal,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("no answer from the PC");
  } finally {
    clearTimeout(timer);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `the bridge answered ${r.status}`);
  return j as T;
}

export function useHealth(): [HealthState, (why: "restart" | "update") => Promise<string>] {
  const [st, setSt] = useState<HealthState>({ kind: "wait" });
  const restartedFrom = useRef<string | null>(null);
  const last = useRef<HealthAnswer | undefined>(undefined);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let gone = false;
    const tick = async () => {
      if (document.visibilityState === "visible") {
        try {
          const h = await call<HealthAnswer>("/health", {});
          if (restartedFrom.current !== null && h.startedAt !== restartedFrom.current) restartedFrom.current = null;
          last.current = h;
          if (!gone) setSt({ kind: "ok", h, at: Date.now() });
        } catch (e) {
          if (!gone)
            setSt((s) => ({
              kind: "down",
              why: String((e as Error).message ?? e),
              since: s.kind === "down" ? s.since : Date.now(),
              last: last.current,
            }));
        }
      }
      if (!gone) timer = setTimeout(tick, restartedFrom.current !== null ? FAST_MS : EVERY_MS);
    };
    const wake = () => {
      if (document.visibilityState === "visible") {
        clearTimeout(timer);
        tick();
      }
    };
    tick();
    document.addEventListener("visibilitychange", wake);
    return () => {
      gone = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
    };
  }, []);
  const restart = async (why: "restart" | "update") => {
    const r = await call<{ at: string }>("/restart", { confirm: true, why });
    restartedFrom.current = last.current?.startedAt ?? "";
    return r.at;
  };
  return [st, restart];
}

const ago = (iso?: string) => {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};
const span = (sec: number) =>
  sec < 3600 ? `${Math.round(sec / 60)} min` : sec < 86400 ? `${(sec / 3600).toFixed(1)} h` : `${(sec / 86400).toFixed(1)} d`;

export function HealthPill({ st }: { st: HealthState }) {
  if (st.kind === "wait") return <span className="stat muted">bridge: checking</span>;
  if (st.kind === "down")
    return (
      <span className="pill bad" title={st.why}>
        <span className="dot bad inline" /> bridge down {ago(new Date(st.since).toISOString())}
      </span>
    );
  return (
    <span className={st.h.newCode ? "pill wait" : "stat"} title={`answered ${ago(st.h.at)}`}>
      <span className="dot live inline" /> bridge{st.h.newCode ? " · new code" : ""}
    </span>
  );
}

export function HealthPanel({ st, restart }: { st: HealthState; restart: (why: "restart" | "update") => Promise<string> }) {
  const [ask, setAsk] = useState<"restart" | "update" | null>(null);
  const [msg, setMsg] = useState("");
  const h = st.kind === "ok" ? st.h : st.kind === "down" ? st.last : undefined;
  const go = (why: "restart" | "update") =>
    restart(why).then(
      (at) => setMsg(`${why} asked at ${new Date(at).toLocaleTimeString()}; waiting for the bridge to answer again`),
      (e) => setMsg(String(e.message ?? e)),
    );
  return (
    <div className="health">
      <p className={st.kind === "down" ? "bad-text" : ""}>
        <span className={"dot inline " + (st.kind === "ok" ? "live" : st.kind === "down" ? "bad" : "")} />{" "}
        {st.kind === "ok"
          ? `Answering · checked ${ago(new Date(st.at).toISOString())}`
          : st.kind === "down"
            ? `Down since ${new Date(st.since).toLocaleTimeString()}: ${st.why}. The task watchdog starts it within 1 min.`
            : "Checking"}
      </p>
      {h && (
        <table className="small">
          <tbody>
            <tr><td>Code it runs</td><td className="num">{h.runningCommit || "unknown"}</td></tr>
            <tr><td>Code in the repo</td><td className={"num" + (h.newCode ? " warn-text" : "")}>{h.repoCommit || "unknown"}</td></tr>
            <tr><td>Up for</td><td className="num">{span(h.uptimeSeconds)}</td></tr>
            <tr><td>Last sync</td><td className="num">{ago(h.lastSync)}</td></tr>
            <tr><td>Runs going</td><td className="num">{h.runsGoing}</td></tr>
            <tr>
              <td>Log errors, last {h.errors.hours} h</td>
              <td className={"num" + (h.errors.count ? " warn-text" : "")}>{h.errors.count}</td>
            </tr>
          </tbody>
        </table>
      )}
      {h && h.errors.last.length > 0 && (
        <ul className="small muted">
          {h.errors.last.map((e, i) => (
            <li key={i}>
              {new Date(e.at).toLocaleString()}: {e.line}
            </li>
          ))}
        </ul>
      )}
      {h?.lastRestart && <p className="small muted">Last restart: {h.lastRestart}</p>}
      {st.kind === "ok" && !ask && (
        <p>
          <button className="danger" onClick={() => setAsk("restart")}>Restart bridge</button>{" "}
          {st.h.newCode && (
            <button className="primary" onClick={() => setAsk("update")}>Update: load {st.h.repoCommit}</button>
          )}
        </p>
      )}
      {ask && (
        <p>
          {ask === "update" ? "Restart to load the new code?" : "Restart the bridge?"}
          {h && h.runsGoing > 0 ? ` ${h.runsGoing} run(s) keep going and finish from their output file.` : ""}{" "}
          <button className="danger" onClick={() => { go(ask); setAsk(null); }}>Yes, {ask}</button>{" "}
          <button onClick={() => setAsk(null)}>Cancel</button>
        </p>
      )}
      {msg && <p className="small muted">{msg}</p>}
    </div>
  );
}
