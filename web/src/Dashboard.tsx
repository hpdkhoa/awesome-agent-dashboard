import { useEffect, useMemo, useRef, useState } from "react";
import { SelectAsk } from "./SelectAsk";
import { QUOTE_EVENT, type QuoteAsk } from "./quote";
import { clampWidth, gridColumns, loadLayout, saveLayout, type Layout } from "./layout";
import { signOut } from "firebase/auth";
import { auth } from "./firebase";
import { RECENT_DAYS, useInbox, useMachines, usePager, usePlanInbox, usePlanRuns, usePlans, useRuns, useSessions, useUsage, useWorkTypes, type InboxItem, type Pager, type Plan, type Run, type Session, type Tokens } from "./data";
import { MessageBox, ModeSwitch, PlanFromSession, RunList, StartForm } from "./Runs";
import { PlanBoard, PlanList, PlanView } from "./Plans";
import { usePush, type PushState } from "./notify";
import { FileViewer, PcText } from "./FileView";
import { SpendChart } from "./Charts";
import { useSource } from "./fs";
import { UsageCheck } from "./UsageCheck";
import { Boxes } from "./Boxes";
import { HealthPanel, HealthPill, useHealth } from "./Health";
import { MoreMenu } from "./MoreMenu";

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
import { DigestView, LocalSearch } from "./LocalSearch";
import { InboxList, InboxView, isWaiting } from "./Inbox";
import { usePhone } from "./phone";
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
const dedupe = <T extends { id: string }>(rows: T[]) => rows.filter((r, i) => rows.findIndex((x) => x.id === r.id) === i);

// Show more: the next 10 older rows, one read each, never a listener (the owner's words, 2026-11-13).
function MoreRow<T>({ pager, what }: { pager: Pager<T>; what: string }) {
  if (pager.done) return <li className="muted small">{pager.pages ? `no older ${what}` : ""}</li>;
  return (
    <li className="row muted small" onClick={pager.more}>
      {pager.loading ? "loading" : `Show more ${what} (10 older, 10 reads)`}
    </li>
  );
}

export function Dashboard() {
  const [older] = useState(false);
  const liveSessions = useSessions(older);
  // older rows behind Show more, 10 a page (the owner's words, 2026-11-13)
  const moreSessions = usePager<Session>("sessions", "lastAt");
  const moreRuns = usePager<Run>("commands", "createdAt");
  const moreInbox = usePager<InboxItem>("inbox", "createdAt");
  const morePlans = usePager<Plan>("plans", "updatedAt");
  const sessions = liveSessions ? dedupe([...liveSessions, ...moreSessions.rows]) : null;
  const source = useSource(); // "bridge": the local database on the PC; "backup": Firestore, read-only, while the PC is off
  const [spendDays, setSpendDays] = useState(1); // the spend range: today by default (the owner's words, 2026-11-13)
  const usage = useUsage(spendDays);
  const workTypes = useWorkTypes();
  const machines = useMachines();
  const liveInbox = useInbox();
  const inbox = liveInbox ? dedupe([...liveInbox, ...moreInbox.rows]) : null;
  const liveRuns = useRuns();
  const runs = liveRuns ? dedupe([...liveRuns, ...moreRuns.rows]) : null;
  const livePlans = usePlans();
  const plans = livePlans ? dedupe([...livePlans, ...morePlans.rows]) : null;
  const [pickedPlan, setPickedPlan] = useState<string | null>(opened.get("plan"));
  const [wt, setWt] = useState<string>("all");
  const [picked, setPicked] = useState<string | null>(null);
  const [tab, setTab] = useState<"inbox" | "plans" | "sessions" | "runs" | "money" | "rates" | "storage">(opened.get("run") ? "runs" : opened.get("plan") ? "plans" : "inbox");
  // "Ask about this" on words of a plan, a session or a run (SelectAsk.tsx): open the plan or the session whose message
  // box takes the quote, if it is not on screen (the owner's words, 2026-11-10: "when in sessions and run then the cite
  // will direct to the message box")
  const mainRef = useRef<HTMLElement>(null);
  const known = useRef<Session[]>([]);
  known.current = sessions ?? [];
  useEffect(() => {
    const go = (e: Event) => {
      const q = (e as CustomEvent<QuoteAsk>).detail;
      if (q.planId) {
        setPickedPlan(q.planId);
        setTab("plans");
      } else if (q.sessionId) {
        setWt("all");
        if (!known.current.some((x) => x.id === q.sessionId)) moreSessions.more(); // older than the last day: the next 10
        setPicked(q.sessionId);
        setTab("sessions");
      }
    };
    window.addEventListener(QUOTE_EVENT, go);
    return () => window.removeEventListener(QUOTE_EVENT, go);
  }, []);
  // the left and right panels: drag to resize, hide and show each (layout.ts), remembered in this browser
  const [layout, setLayout] = useState<Layout>(loadLayout);
  useEffect(() => saveLayout(layout), [layout]);
  const drag = (side: "left" | "right") => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX, start = layout[side];
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      setLayout((l) => ({ ...l, [side]: clampWidth(side === "left" ? start + dx : start - dx, window.innerWidth) }));
    };
    const up = () => (window.removeEventListener("pointermove", move), window.removeEventListener("pointerup", up));
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const [store, setStore] = useState("inbox");
  const [pickedItem, setPickedItem] = useState<string | null>(opened.get("item"));
  // step i7, "Full screen, Back to list": on a phone the inbox is a list screen and an item screen; a link with ?item=
  // (a push) opens the item screen straight away
  const phone = usePhone();
  const [phoneOpen, setPhoneOpen] = useState(!!opened.get("item"));
  const pickItem = (id: string) => (setPickedItem(id), setPhoneOpen(true), window.scrollTo(0, 0));
  const [push, turnOnPush] = usePush();
  const [health, restartBridge] = useHealth();
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
  const planInbox = usePlanInbox(plan?.id);
  const planRuns = usePlanRuns(plan?.id);
  const openItem = (id: string) => (pickItem(id), setTab("inbox"));
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
    <div className={phone && tab === "inbox" ? (phoneOpen && item ? "app phone-item" : "app phone-list") : "app"}
      style={{ gridTemplateColumns: gridColumns(layout) }}>
      <header className="top">
        <button className="chip panel-btn" title={layout.leftHidden ? "Show the left panel" : "Hide the left panel"}
          onClick={() => setLayout((l) => ({ ...l, leftHidden: !l.leftHidden }))}>{layout.leftHidden ? "›" : "‹"}</button>
        <strong>Agent dashboard</strong>
        {source.source === "backup" && <span className="stat wait-fg" title="No bridge answers: this is the Firestore backup, read-only. The page tries the boxes again every 30 s.">PC off · backup, read-only</span>}
        {source.source === "bridge" && source.boxes.some((b) => !b.up) && (
          <span className="stat wait-fg" title="This box's bridge does not answer: its records are missing until it is back. The page tries again every 30 s.">
            off: {source.boxes.filter((b) => !b.up).map((b) => b.name || "the bridge").join(", ")}
          </span>
        )}
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
          {spendDays === 1 ? "today" : `${usage.length} days`} {num(month.tokens)} tok · {usd(month.cost)} est.
        </span>
        <span className="stat muted">{lastSync ? "synced " + ago(lastSync) : "no sync yet"}</span>
        <HealthPill st={health} />
        {push && (
          <button className={push === "off" ? "pill wait" : "pill"} disabled={push !== "off"} onClick={turnOnPush}
            title="A push when a run needs your approval and when a run ends">
            {PUSH_LABEL[push]}
          </button>
        )}
        <button className="right" onClick={() => signOut(auth)}>
          Sign out
        </button>
        <button className="chip panel-btn" title={layout.rightHidden ? "Show the right panel" : "Hide the right panel"}
          onClick={() => setLayout((l) => ({ ...l, rightHidden: !l.rightHidden }))}>{layout.rightHidden ? "‹" : "›"}</button>
      </header>

      <aside className="side" hidden={layout.leftHidden}>
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
          <>
            <div className="pad">
              <StartForm machines={machines ?? []} plan />
            </div>
            <PlanList plans={shownPlans} items={inbox} picked={plan?.id} onPick={setPickedPlan} />
            <ul className="list"><MoreRow pager={morePlans} what="plans" /></ul>
          </>
        ) : tab === "inbox" ? (
          <>
            <InboxList items={items} picked={item?.id} onPick={pickItem} />
            <ul className="list"><MoreRow pager={moreInbox} what="items" /></ul>
          </>
        ) : (
        <>
        <div className="pad">
          <LocalSearch onPick={setPicked} known={new Set(sessions.map((s) => s.id))} />
        </div>
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
              <MoreMenu path={`sessions/${s.id}`} />
            </li>
          ))}
          {shown.length === 0 && <li className="muted">No sessions in the last {RECENT_DAYS} day.</li>}
          <MoreRow pager={moreSessions} what="sessions" />
        </ul>
        </>
        )}
      </aside>
      <div className="gutter gl" hidden={layout.leftHidden} onPointerDown={drag("left")} title="Drag to resize the left panel" />

      <main className="main" ref={mainRef}>
        <SelectAsk root={mainRef} />
        {tab === "storage" ? (
          <StorageView name={store} />
        ) : tab === "money" ? (
          entries && fx && gold ? <MoneyView entries={entries} fx={fx} gold={gold} /> : <p className="muted">Loading</p>
        ) : tab === "rates" ? (
          fx && gold ? <RatesReport fx={fx} gold={gold} /> : <p className="muted">Loading</p>
        ) : tab === "runs" ? (
          <>
            <ModeSwitch />
            <RunList runs={liveRuns ?? []} title="Runs going now" />
            {moreRuns.rows.length > 0 && <RunList runs={moreRuns.rows} title="Older runs" />}
            <ul className="list"><MoreRow pager={moreRuns} what="runs" /></ul>
          </>
        ) : tab === "plans" ? (
          plan ? (
            <>
              <PlanBoard plans={shownPlans} items={inbox} picked={plan.id} onPick={setPickedPlan} />
              <PlanView key={plan.id} plan={plan} items={dedupe([...(inbox ?? []), ...planInbox])} session={sessions.find((s) => s.id === plan.sessionId)}
                runs={dedupe([...(runs ?? []), ...planRuns])} onOpenItem={openItem} />
            </>
          ) : (
            <p className="muted">No plans yet.</p>
          )
        ) : tab === "inbox" ? (
          item ? (
            <InboxView key={item.id} item={item} session={sessions.find((s) => s.id === item.sessionId)}
              plan={(plans ?? []).find((p) => p.id === item.planId)} onOpenPlan={(id) => (setPickedPlan(id), setTab("plans"))}
              items={inbox} phone={phone} onBack={phone ? () => (setPhoneOpen(false), window.scrollTo(0, 0)) : undefined} />
          ) : (
            <p className="muted">The inbox is empty.</p>
          )
        ) : (
          <>
            {/* step i6: the daily digest sits above the session, where it has the room (on a phone the list panel is
                half the screen) */}
            <DigestView />
            {current ? <SessionView s={current} runs={runs ?? []} /> : <p className="muted">Pick a session.</p>}
          </>
        )}
      </main>
      <div className="gutter gr" hidden={layout.rightHidden} onPointerDown={drag("right")} title="Drag to resize the right panel" />
      <FileViewer />

      <section className="usage" hidden={layout.rightHidden}>
        <Section id="usage.health" title="Bridge health" extra="pinged every 20 s through the tunnel">
          <HealthPanel st={health} restart={restartBridge} />
        </Section>
        <Section id="usage.days" title="Spend by day" extra={spendDays === 1 ? "today" : spendDays ? `last ${spendDays} days` : `${usage.length} days, whole history`}>
          <SpendChart usage={usage} range={spendDays} onRange={setSpendDays} />
        </Section>
        <Section id="usage.boxes" title="Boxes" extra={`${source.boxes.filter((b) => b.up).length} on`} open={false}>
          <Boxes />
        </Section>
        <Section id="usage.check" title="Usage check" extra="Claude plan · Firestore">
          <UsageCheck />
        </Section>
        <Section id="usage.workTypes" title="By work type" extra={spendDays === 1 ? "today" : `${usage.length} days`}>
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
      </section>
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
    <article data-quote-session={s.id}>
      <h1>{s.title}</h1>
      <p className="meta">
        {s.workType} · {s.machine} · {s.cwd}
        <br />
        started {new Date(s.startedAt).toLocaleString()} · last {ago(s.lastAt)} · {s.prompts} prompts · {s.messages} replies ·{" "}
        {s.subagents} subagents · {Object.keys(s.models).join(", ")}
      </p>
      <MessageBox key={s.id} s={s} runs={runs} />
      <PlanFromSession s={s} runs={runs} />
      <Section id="session.lastPrompt" title="Last prompt">
        <Md text={s.lastPrompt} cwd={s.cwd} />
      </Section>
      <Section id="session.lastReply" title="Last reply">
        <PcText session={s.id} cwd={s.cwd} />
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
