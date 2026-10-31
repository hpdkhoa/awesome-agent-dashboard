import { useMemo, useState } from "react";
import { signOut } from "firebase/auth";
import { auth } from "./firebase";
import { useInbox, useMachines, useSessions, useUsage, useWorkTypes, type Session, type Tokens } from "./data";
import { InboxList, InboxView, isWaiting } from "./Inbox";

const ACTIVE_MS = 5 * 60 * 1000;

export const num = (n: number) =>
  n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);
export const usd = (n: number) => "$" + n.toLocaleString(undefined, { maximumFractionDigits: n < 10 ? 2 : 0 });

function ago(iso: string) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

const isActive = (s: Session) => Date.now() - Date.parse(s.lastAt) < ACTIVE_MS;
const today = () => new Date().toLocaleDateString("en-CA");

export function Dashboard() {
  const sessions = useSessions();
  const usage = useUsage();
  const workTypes = useWorkTypes();
  const machines = useMachines();
  const inbox = useInbox();
  const [wt, setWt] = useState<string>("all");
  const [picked, setPicked] = useState<string | null>(null);
  const [tab, setTab] = useState<"inbox" | "sessions">("inbox");
  const [pickedItem, setPickedItem] = useState<string | null>(null);

  const shown = useMemo(() => (sessions ?? []).filter((s) => wt === "all" || s.workType === wt), [sessions, wt]);
  const current = shown.find((s) => s.id === picked) ?? shown[0];
  const items = (inbox ?? []).filter((i) => wt === "all" || i.workType === wt);
  const waiting = (inbox ?? []).filter(isWaiting).length;
  const item = items.find((i) => i.id === pickedItem) ?? items.find(isWaiting) ?? items[0];
  const todayUse = usage?.find((u) => u.day === today());
  const month = (usage ?? []).reduce((a, u) => ({ tokens: a.tokens + u.total, cost: a.cost + u.costUsd }), { tokens: 0, cost: 0 });
  const lastSync = (machines ?? []).map((m) => m.syncedAt).sort().at(-1);
  // Work type spend over the same days as the header, so the two always add up.
  const byWorkType = Object.entries(
    (usage ?? []).reduce<Record<string, { total: number; costUsd: number }>>((acc, u) => {
      for (const [w, t] of Object.entries(u.byWorkType)) {
        const a = (acc[w] ??= { total: 0, costUsd: 0 });
        a.total += t.total;
        a.costUsd += t.costUsd;
      }
      return acc;
    }, {}),
  ).sort((a, b) => b[1].costUsd - a[1].costUsd);

  if (!sessions || !usage || !workTypes || !inbox) return <main className="card">Loading</main>;

  return (
    <div className="app">
      <header className="top">
        <strong>Agent dashboard</strong>
        <button className={waiting ? "pill wait" : "pill"} onClick={() => setTab("inbox")}>
          {waiting} waiting for you
        </button>
        <span className="stat">
          {sessions.filter(isActive).length} active
        </span>
        <span className="stat" title="list-price estimate; your plan is a subscription, not this bill">
          today {num(todayUse?.total ?? 0)} tok · {usd(todayUse?.costUsd ?? 0)} est.
        </span>
        <span className="stat">
          {usage.length} days {num(month.tokens)} tok · {usd(month.cost)} est.
        </span>
        <span className="stat muted">{lastSync ? "synced " + ago(lastSync) : "no sync yet"}</span>
        <button className="right" onClick={() => signOut(auth)}>
          Sign out
        </button>
      </header>

      <aside className="side">
        <div className="chips">
          {[{ id: "all", sessions: sessions.length }, ...[...workTypes].sort((a, b) => b.lastAt.localeCompare(a.lastAt))].map((w) => (
            <button key={w.id} className={wt === w.id ? "chip on" : "chip"} onClick={() => setWt(w.id)}>
              {w.id} <span className="muted">{w.sessions}</span>
            </button>
          ))}
        </div>
        <div className="tabs">
          <button className={tab === "inbox" ? "tab on" : "tab"} onClick={() => setTab("inbox")}>
            Inbox {waiting > 0 && <span className="count">{waiting}</span>}
          </button>
          <button className={tab === "sessions" ? "tab on" : "tab"} onClick={() => setTab("sessions")}>
            Sessions
          </button>
        </div>
        {tab === "inbox" ? (
          <InboxList items={items} picked={item?.id} onPick={setPickedItem} />
        ) : (
        <ul className="list">
          {shown.map((s) => (
            <li key={s.id} className={s.id === current?.id ? "row on" : "row"} onClick={() => setPicked(s.id)}>
              <span className={isActive(s) ? "dot live" : "dot"} />
              <div className="grow">
                <div className="title">{s.title}</div>
                <div className="muted small">
                  {s.workType} · {ago(s.lastAt)} · {num(s.tokens.total)} tok · {usd(s.tokens.costUsd)}
                </div>
              </div>
            </li>
          ))}
          {shown.length === 0 && <li className="muted">No sessions yet. Run the bridge: agent-bridge sync</li>}
        </ul>
        )}
      </aside>

      <main className="main">
        {tab === "inbox" ? (
          item ? (
            <InboxView key={item.id} item={item} session={sessions.find((s) => s.id === item.sessionId)} />
          ) : (
            <p className="muted">The inbox is empty.</p>
          )
        ) : current ? (
          <SessionView s={current} />
        ) : (
          <p className="muted">Pick a session.</p>
        )}
      </main>

      <section className="usage">
        <h2>Spend by day</h2>
        <Bars days={[...usage].reverse().slice(-14)} />
        <h2>By work type, last {usage.length} days</h2>
        <table>
          <tbody>
            {byWorkType.map(([w, t]) => (
              <tr key={w}>
                <td>{w}</td>
                <td className="num">{num(t.total)}</td>
                <td className="num">{usd(t.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">Dollars are list-price estimates from token counts. Your plan is a subscription.</p>
      </section>
    </div>
  );
}

function Bars({ days }: { days: { day: string; costUsd: number; total: number }[] }) {
  const max = Math.max(1, ...days.map((d) => d.costUsd));
  return (
    <div className="bars">
      {days.map((d) => (
        <div key={d.day} className="bar" title={`${d.day}: ${num(d.total)} tokens, ${usd(d.costUsd)}`}>
          <div className="fill" style={{ height: `${(d.costUsd / max) * 100}%` }} />
          <span className="small muted">{d.day.slice(8)}</span>
        </div>
      ))}
    </div>
  );
}

function TokenTable({ t }: { t: Tokens }) {
  const rows: [string, number][] = [
    ["Input", t.input],
    ["Output", t.output],
    ["Cache write 5m", t.cacheWrite5m],
    ["Cache write 1h", t.cacheWrite1h],
    ["Cache read", t.cacheRead],
  ];
  return (
    <table>
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <td>{k}</td>
            <td className="num">{v.toLocaleString()}</td>
          </tr>
        ))}
        <tr className="sum">
          <td>Total</td>
          <td className="num">
            {t.total.toLocaleString()} · {usd(t.costUsd)} est.
          </td>
        </tr>
      </tbody>
    </table>
  );
}

function SessionView({ s }: { s: Session }) {
  return (
    <article>
      <h1>{s.title}</h1>
      <p className="muted small">
        {s.workType} · {s.machine} · {s.cwd}
        <br />
        started {new Date(s.startedAt).toLocaleString()} · last {ago(s.lastAt)} · {s.prompts} prompts · {s.messages} replies ·{" "}
        {s.subagents} subagents · {Object.keys(s.models).join(", ")}
      </p>
      <h2>Last prompt</h2>
      <p className="quote">{s.lastPrompt || "none"}</p>
      <h2>Last reply</h2>
      <p className="quote">{s.lastReply || "none"}</p>
      <h2>Tokens</h2>
      <TokenTable t={s.tokens} />
      {s.firstPrompt && s.firstPrompt !== s.title && (
        <>
          <h2>First prompt</h2>
          <p className="quote">{s.firstPrompt}</p>
        </>
      )}
    </article>
  );
}
