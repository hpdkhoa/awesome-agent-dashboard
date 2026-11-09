import { useState } from "react";
import { bridgePost } from "./FileView";
import { pageReads } from "./data";
import { countAll } from "./storeData";

// Usage check, in the right spend panel as its own block (the owner's words, 2026-11-09: "I want the usage check for
// my agent dashboard too, make it as a manual check button and render together in the spend zone"; the pick: "Both.
// Note: but need two separated button for claude and firestore"). Two buttons, nothing stored: each asks the bridge on
// the PC (bridge/agent_bridge/usage.py). Every bar shows its value, the legend says what the colours mean, and the
// numbers under it say what they are (the charts rule, 2026-11-08).

type Window = { key: string; label: string; percent: number; resetsAt?: string | null; locked?: string | null };
type ClaudeUsage = { windows: Window[]; plan?: string; tier?: string; extraUsage: boolean; checkedAt: string };
type FirestoreUsage = {
  today: { day?: string; reads?: number; writes?: number; deletes?: number; since?: string; at?: string };
  freeTier: Record<string, number>; checkedAt: string; counted: boolean;
};

const tone = (pct: number) => (pct >= 80 ? "hot" : pct >= 50 ? "warm" : "ok");
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : "unknown");
const left = (iso?: string | null) => {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "reset passed";
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return h >= 24 ? `${Math.floor(h / 24)} d ${h % 24} h left` : `${h} h ${m} min left`;
};

function Bar({ label, pct, value, means }: { label: string; pct: number; value: string; means: string }) {
  const p = Math.max(0, Math.min(100, pct));
  return (
    <div className="ubar" title={means}>
      <div className="ubar-head small">
        <span>{label}</span>
        <b>{value}</b>
      </div>
      <div className="ubar-track">
        <div className={"ubar-fill " + tone(p)} style={{ width: `${p}%` }} />
        <span className="ubar-pct small">{p.toFixed(0)}%</span>
      </div>
      <div className="small muted means">{means}</div>
    </div>
  );
}

const LEGEND = (
  <ul className="legend small">
    <li><span className="swatch ok" /> under 50% used</li>
    <li><span className="swatch warm" /> 50 to 80%</li>
    <li><span className="swatch hot" /> 80% and over: close to the limit</li>
  </ul>
);

function ClaudeBlock() {
  const [got, setGot] = useState<ClaudeUsage | string | null>(null);
  const [busy, setBusy] = useState(false);
  const check = () => {
    setBusy(true);
    bridgePost<ClaudeUsage>("/usage", { what: "claude" }).then(setGot, (e) => setGot(String(e.message ?? e))).finally(() => setBusy(false));
  };
  return (
    <div className="ucheck">
      <div className="ucheck-head">
        <b>Claude plan</b>
        <button className="chip" disabled={busy} onClick={check}>{busy ? "Checking" : "Check Claude"}</button>
      </div>
      {typeof got === "string" && <p className="bad small">{got}</p>}
      {got && typeof got !== "string" && (
        <>
          {got.windows.length === 0 && <p className="muted small">The account reports no limit window.</p>}
          {got.windows.map((w) => (
            <Bar
              key={w.key}
              label={w.label}
              pct={w.percent}
              value={`${w.percent.toFixed(0)}% used · resets ${when(w.resetsAt)}`}
              means={`${left(w.resetsAt)}${w.locked ? ` · locked: ${w.locked}` : ""} · the share of this window's allowance already spent; at 100% runs pause until the reset`}
            />
          ))}
          {LEGEND}
          <p className="small muted">
            plan {got.plan ?? "unknown"}{got.tier ? ` · tier ${got.tier}` : ""} · extra usage {got.extraUsage ? "on" : "off"} · checked {when(got.checkedAt)} · read on the PC from the Claude account the bridge signs in with
          </p>
        </>
      )}
      {!got && <p className="small muted">Your 5-hour and weekly windows, read from the signed-in Claude account on your PC. Nothing is stored.</p>}
    </div>
  );
}

function FirestoreBlock() {
  const [got, setGot] = useState<FirestoreUsage | string | null>(null);
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [reads, setReads] = useState(0);
  const [busy, setBusy] = useState(false);
  const check = () => {
    setBusy(true);
    setReads(pageReads());
    Promise.all([
      bridgePost<FirestoreUsage>("/usage", { what: "firestore" }).then(setGot, (e) => setGot(String(e.message ?? e))),
      countAll().then(setCounts, () => setCounts(null)),
    ]).finally(() => setBusy(false));
  };
  const t = got && typeof got !== "string" ? got.today : null;
  const tier = got && typeof got !== "string" ? got.freeTier : null;
  const docs = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;
  return (
    <div className="ucheck">
      <div className="ucheck-head">
        <b>Firestore</b>
        <button className="chip" disabled={busy} onClick={check}>{busy ? "Checking" : "Check Firestore"}</button>
      </div>
      {typeof got === "string" && <p className="bad small">{got}</p>}
      {t && tier && (
        <>
          {(["reads", "writes", "deletes"] as const).map((k) => {
            const bridge = t[k] ?? 0;
            const page = k === "reads" ? reads : 0;
            const n = bridge + page;
            return (
              <Bar
                key={k}
                label={`${k} today`}
                pct={(n / tier[k]) * 100}
                value={`${n.toLocaleString()} of ${tier[k].toLocaleString()}`}
                means={
                  k === "reads"
                    ? `bridge ${bridge.toLocaleString()} (its queries and listeners since ${when(t.since)}) + this page tab ${page.toLocaleString()} since it loaded · the free tier allows ${tier[k].toLocaleString()} document reads a day`
                    : `by the bridge since ${when(t.since)} · the free tier allows ${tier[k].toLocaleString()} a day`
                }
              />
            );
          })}
          {LEGEND}
          {counts && (
            <p className="small muted">
              stored: {docs.toLocaleString()} documents ·{" "}
              {Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ${c.toLocaleString()}`).join(" · ")} · counted with aggregation queries (one read per 1,000 documents)
            </p>
          )}
          <p className="small muted">
            checked {when(got && typeof got !== "string" ? got.checkedAt : undefined)} · counted by the bridge and this page, not Google's own meter; other open dashboard tabs add their own reads
          </p>
        </>
      )}
      {!got && <p className="small muted">Today's document reads, writes and deletes against the free tier, and how many documents each collection holds. Nothing is stored.</p>}
    </div>
  );
}

export function UsageCheck() {
  return (
    <div className="ucheck-wrap">
      <ClaudeBlock />
      <FirestoreBlock />
    </div>
  );
}
