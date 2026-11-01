import { useMemo, useState } from "react";
import { signOut } from "firebase/auth";
import { auth } from "./firebase";
import { useInbox, useMachines, usePlans, useRuns, useSessions, useUsage, useWorkTypes, type Run, type Session, type Tokens } from "./data";
import { MessageBox, RunList, StartForm } from "./Runs";
import { PlanList, PlanView } from "./Plans";
import { usePush, type PushState } from "./notify";
import { FileViewer } from "./FileView";

// A tap on a push opens /?item=<inbox id>, /?run=<command id> or /?plan=<plan id> (bridge/agent_bridge/push.py).
const opened = new URLSearchParams(window.location.search);
if ([...opened].length) window.history.replaceState(null, "", "/");

const PUSH_LABEL: Record<PushState, string> = {
  unsupported: "No notifications in this browser",
  "home-screen": "Notifications: add to Home Screen first",
  off: "Turn on notifications",
  denied: "Notifications blocked in Settings",
  on: "Notifications on",
  "no-key": "Notifications: run push-setup on the bridge",
};
import { Md } from "./Markdown";
import { Section } from "./Section";
import { InboxList, InboxView, isWaiting } from "./Inbox";
import { useEntries, useFx, useGold } from "./moneyData";
import { EntryForm, MoneyView } from "./Money";
import { RatesReport, RatesSide } from "./Rates";
import { StorageSide, StorageView } from "./Storage";

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
  const runs = useRuns();
  const plans = usePlans();
  const [pickedPlan, setPickedPlan] = useState<string | null>(opened.get("plan"));
  const [wt, setWt] = useState<string>("all");
  const [picked, setPicked] = useState<string | null>(null);
  const [tab, setTab] = useState<"inbox" | "plans" | "sessions" | "runs" | "money" | "rates" | "storage">(opened.get("run") ? "runs" : opened.get("plan") ? "plans" : "inbox");
  const [store, setStore] = useState("inbox");
  const [pickedItem, setPickedItem] = useState<string | null>(opened.get("item"));
  const [push, turnOnPush] = usePush();
  // Money data loads only while the Money or Rates tab is open.
  const entries = useEntries(tab === "money");
  const fx = useFx(tab === "money" || tab === "rates");
  const gold = useGold(tab === "money" || tab === "rates");

  const shown = useMemo(() => (sessions ?? []).filter((s) => wt === "all" || s.workType === wt), [sessions, wt]);
  const current = shown.find((s) => s.id === picked) ?? shown[0];
  const items = (inbox ?? []).filter((i) => wt === "all" || i.workType === wt);
  const waiting = (inbox ?? []).filter(isWaiting).length;
  const item = items.find((i) => i.id === pickedItem) ?? items.find(isWaiting) ?? items[0];
  const shownPlans = (plans ?? []).filter((p) => wt === "all" || p.workType === wt);
  const plan = shownPlans.find((p) => p.id === pickedPlan) ?? shownPlans[0];
  const openItem = (id: string) => (setPickedItem(id), setTab("inbox"));
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
        {push && (
          <button className={push === "off" ? "pill wait" : "pill"} disabled={push !== "off"} onClick={turnOnPush}
            title="A push when a run needs your approval and when a run ends">
            {PUSH_LABEL[push]}
          </button>
        )}
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
          <button className={tab === "plans" ? "tab on" : "tab"} onClick={() => setTab("plans")}>
            Plans
          </button>
          <button className={tab === "sessions" ? "tab on" : "tab"} onClick={() => setTab("sessions")}>
            Sessions
          </button>
          <button className={tab === "runs" ? "tab on" : "tab"} onClick={() => setTab("runs")}>
            Runs {(runs ?? []).some((r) => r.status === "running") && <span className="dot live inline" />}
          </button>
          <button className={tab === "money" ? "tab on" : "tab"} onClick={() => setTab("money")}>
            Money
          </button>
          <button className={tab === "rates" ? "tab on" : "tab"} onClick={() => setTab("rates")}>
            Rates
          </button>
          <button className={tab === "storage" ? "tab on" : "tab"} onClick={() => setTab("storage")}>
            Storage
          </button>
        </div>
        {tab === "storage" ? (
          <StorageSide picked={store} onPick={setStore} />
        ) : tab === "money" ? (
          <EntryForm fx={fx} gold={gold} />
        ) : tab === "rates" ? (
          <RatesSide fx={fx} gold={gold} />
        ) : tab === "runs" ? (
          <div className="pad">
            <StartForm machines={machines ?? []} />
          </div>
        ) : tab === "plans" ? (
          <PlanList plans={shownPlans} items={inbox} picked={plan?.id} onPick={setPickedPlan} />
        ) : tab === "inbox" ? (
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
        {tab === "storage" ? (
          <StorageView name={store} />
        ) : tab === "money" ? (
          entries && fx && gold ? <MoneyView entries={entries} fx={fx} gold={gold} /> : <p className="muted">Loading</p>
        ) : tab === "rates" ? (
          fx && gold ? <RatesReport fx={fx} gold={gold} /> : <p className="muted">Loading</p>
        ) : tab === "runs" ? (
          <RunList runs={runs ?? []} />
        ) : tab === "plans" ? (
          plan ? (
            <PlanView key={plan.id} plan={plan} items={inbox} session={sessions.find((s) => s.id === plan.sessionId)} onOpenItem={openItem} />
          ) : (
            <p className="muted">No plans yet.</p>
          )
        ) : tab === "inbox" ? (
          item ? (
            <InboxView key={item.id} item={item} session={sessions.find((s) => s.id === item.sessionId)}
              plan={(plans ?? []).find((p) => p.id === item.planId)} onOpenPlan={(id) => (setPickedPlan(id), setTab("plans"))} />
          ) : (
            <p className="muted">The inbox is empty.</p>
          )
        ) : current ? (
          <SessionView s={current} runs={runs ?? []} />
        ) : (
          <p className="muted">Pick a session.</p>
        )}
      </main>
      <FileViewer />

      <section className="usage">
        <Section id="usage.days" title="Spend by day" extra="last 14 days">
          <Bars days={[...usage].reverse().slice(-14)} />
        </Section>
        <Section id="usage.workTypes" title="By work type" extra={`last ${usage.length} days`}>
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
        </Section>
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

function SessionView({ s, runs }: { s: Session; runs: Run[] }) {
  return (
    <article>
      <h1>{s.title}</h1>
      <p className="meta">
        {s.workType} · {s.machine} · {s.cwd}
        <br />
        started {new Date(s.startedAt).toLocaleString()} · last {ago(s.lastAt)} · {s.prompts} prompts · {s.messages} replies ·{" "}
        {s.subagents} subagents · {Object.keys(s.models).join(", ")}
      </p>
      <MessageBox key={s.id} s={s} runs={runs} />
      <Section id="session.lastPrompt" title="Last prompt">
        <Md text={s.lastPrompt} cwd={s.cwd} />
      </Section>
      <Section id="session.lastReply" title="Last reply">
        <Md text={s.lastReply} cwd={s.cwd} />
      </Section>
      <Section id="session.tokens" title="Tokens" extra={`${num(s.tokens.total)} · ${usd(s.tokens.costUsd)} est.`} open={false}>
        <TokenTable t={s.tokens} />
      </Section>
      {s.firstPrompt && s.firstPrompt !== s.title && (
        <Section id="session.firstPrompt" title="First prompt" open={false}>
          <Md text={s.firstPrompt} cwd={s.cwd} />
        </Section>
      )}
    </article>
  );
}
