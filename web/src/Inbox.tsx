import { useState } from "react";
import { answerItem, askBack, batchOf, cancelAnswer, forceAnswer, saveDraft, type InboxItem, type Plan, type Session } from "./data";
import { Example } from "./Example";
import { Md } from "./Markdown";
import { MoreMenu } from "./MoreMenu";
import { openFile } from "./FileView";
import { Section } from "./Section";

const KIND = { question: "Question", suggestion: "Suggestion", result: "Result to review", approval: "Approval" };
const STATUS = {
  open: "waiting for you",
  answered: "answered, waiting to reach the session",
  delivering: "sending to the session",
  delivered: "delivered",
  closed: "closed",
};

export const isWaiting = (i: InboxItem) => i.status === "open";

function ago(iso: string) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

export function InboxList({ items, picked, onPick }: { items: InboxItem[]; picked?: string; onPick: (id: string) => void }) {
  // one row per batch: its first question stands for it
  const sorted = [...items].filter((i) => !i.batchId || (i.batchIndex ?? 0) === 0)
    .sort((a, b) => Number(isWaiting(b)) - Number(isWaiting(a)));
  const size = (i: InboxItem) => (i.batchId ? items.filter((x) => x.batchId === i.batchId) : [i]);
  return (
    <ul className="list">
      {sorted.map((i) => (
        <li key={i.id} className={i.id === picked ? "row on" : "row"} onClick={() => onPick(i.id)}>
          <span className={size(i).some(isWaiting) ? "dot wait" : "dot"} />
          <div className="grow">
            <div className="title">{size(i).length > 1 ? `${size(i).length} questions: ` : ""}{i.title}</div>
            <div className="muted small">
              {KIND[i.kind]} · {i.workType} · {ago(i.createdAt)} · {STATUS[i.status]}
            </div>
          </div>
          <MoreMenu path={`inbox/${i.id}`} />
        </li>
      ))}
      {items.length === 0 && (
        <li className="muted row">
          Nothing yet. Sessions post here with inbox_ask, inbox_suggest and inbox_result, and their question box goes here
          first for 10 minutes.
        </li>
      )}
    </ul>
  );
}

// One question of a batch (the owner's words, 2026-11-07): options drawn or with their difference, a text box for your
// own answer or a question instead of a pick (like "Other"), your saved answers kept as a thread, and ask back.
function QuestionCard({ q, batch, k }: { q: InboxItem; batch: InboxItem[]; k: number }) {
  const [choice, setChoice] = useState(q.draft?.choice ?? "");
  const [text, setText] = useState(q.draft?.text ?? "");
  const [ask, setAsk] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const open = q.status === "open";
  const shown = open ? choice : q.answer?.choice ?? "";
  async function run(f: () => Promise<unknown>) {
    setBusy(true);
    try {
      await f();
    } catch (e) {
      setError(String((e as { code?: string }).code ?? e));
    }
    setBusy(false);
  }
  const left = batch.filter((x) => x.status === "open" && !x.draft && x.id !== q.id).length;
  return (
    <div className="qcard">
      <b>{batch.length > 1 ? `${k + 1}. ` : ""}{q.title}</b>
      {q.text && q.text !== q.title && <Md text={q.text} cwd={q.cwd} />}
      {q.options.length > 0 && (
        <div className={q.options.some((o) => o.example) ? "options wide" : "options"}>
          {q.options.map((o, n) => {
            const picked = shown.split(", ");
            const on = q.multi ? picked.includes(o.label) : shown === o.label;
            return (
              <div key={n} className="option-wrap">
                <button className={on ? "option on" : "option"} disabled={!open || busy}
                  onClick={() => {
                    if (q.multi) {
                      const next = on ? picked.filter((l) => l !== o.label) : [...picked.filter(Boolean), o.label];
                      setChoice(q.options.map((x) => x.label).filter((l) => next.includes(l)).join(", "));
                    } else setChoice(on ? "" : o.label);
                    setError("");
                  }}>
                  <span>
                    ({String.fromCharCode(97 + n)}) {o.label}
                    {q.recommended === n && <span className="tag">Recommended</span>}
                  </span>
                  {o.detail && <span className="muted small">{o.detail}</span>}
                  {o.differs && <span className="small differs">≠ {o.differs}</span>}
                </button>
                {o.example && <Example e={o.example} cwd={q.cwd} />}
              </div>
            );
          })}
        </div>
      )}
      {open && (
        <>
          <textarea rows={2} value={text} placeholder="Your own answer, or a question back, instead of a pick"
            onChange={(e) => (setText(e.target.value), setError(""))} />
          {error && <p className="bad small">{error}</p>}
          <div className="actions">
            <button className="primary" disabled={busy}
              onClick={() => (!choice && !text.trim() ? setError("Pick an option or write something first.")
                : run(() => saveDraft(q, batch, choice, text.trim())))}>
              {q.draft ? "Change my answer" : "Save my answer"}
            </button>
            <span className="small muted">
              {q.draft ? `saved: ${[q.draft.choice, q.draft.text].filter(Boolean).join(" · ")}` : "not saved yet"}
              {left > 0 ? ` · sent when ${left === 1 ? "1 more question is" : `${left} more questions are`} saved` : ""}
            </span>
          </div>
          {q.via !== "hook" && (
            <div className="actions">
              <input value={ask} placeholder="Ask back: a short question, the session replies here" onChange={(e) => setAsk(e.target.value)} />
              <button disabled={busy || !ask.trim()} onClick={() => run(async () => (await askBack(q, ask.trim()), setAsk("")))}>Ask back</button>
            </div>
          )}
        </>
      )}
      {!open && (
        <p className="small ok-fg">sent: {[q.answer?.choice, q.answer?.text].filter(Boolean).join(" · ") || "no answer"}</p>
      )}
      {(q.thread ?? []).length > 0 && (
        <Section id="inbox.thread" title="Thread" extra={(q.thread ?? []).length} open={open}>
          <ul className="thread">
            {(q.thread ?? []).map((t, n) => (
              <li key={n} className={t.who}>
                <span className="small muted">{t.who === "owner" ? (t.kind === "ask" ? "you asked" : "you saved") : "session"} · {ago(t.at)}</span>{" "}
                {t.kind === "answer" ? <b>{[t.choice, t.text].filter(Boolean).join(" · ")}</b> : <Md text={t.text ?? ""} cwd={q.cwd} />}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

export function InboxView({ item, session, plan, onOpenPlan, items = [] }: {
  item: InboxItem; session?: Session; plan?: Plan; onOpenPlan?: (id: string) => void; items?: InboxItem[];
}) {
  const [choice, setChoice] = useState<string>("");
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function send(c: string) {
    if (item.kind === "question" && !c && !text.trim()) {
      setError("Pick an option or write an answer first.");
      return;
    }
    setBusy(true);
    try {
      await answerItem(item.id, c, text.trim());
    } catch (e) {
      setError(String((e as { code?: string }).code ?? e));
    }
    setBusy(false);
  }

  const open = item.status === "open";
  const body = item.kind === "approval" ? "```json\n" + item.text + "\n```" : item.text;
  return (
    <article>
      <h1>{item.title}</h1>
      <p className="meta">
        {KIND[item.kind]} · {item.workType} · {item.machine} · {ago(item.createdAt)} · {STATUS[item.status]}
        <br />
        from session: {session?.title ?? item.sessionId}
        {plan && (
          <>
            <br />
            part of plan{" "}
            <button className="link" onClick={() => onOpenPlan?.(plan.id)}>
              {plan.title}
            </button>
            , {item.round ? `questions on v${item.round}` : "questions before v1"}
          </>
        )}
        {item.via === "hook" && open && (
          <>
            <br />
            from the session's question box: answer within 10 minutes of {new Date(item.createdAt).toLocaleTimeString()}, or the
            session asks there instead
          </>
        )}
      </p>

      <Section id="inbox.text" title={item.kind === "approval" ? "The call" : "Details"}>
        <Md text={body} cwd={item.cwd} />
      </Section>

      {item.files.length > 0 && (
        <Section id="inbox.files" title="Files" extra={item.files.length}>
          <ul className="small">
            {item.files.map((f) => (
              <li key={f}>
                <code className="file-link" role="button" onClick={() => openFile(f, item.cwd)}>{f}</code>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {item.kind === "question" && (() => {
        const batch = batchOf(item, items.length ? items : [item]);
        return (
          <Section id="inbox.batch" title={batch.length > 1 ? `${batch.length} questions, answered together` : "The question"}>
            {batch.map((q, k) => <QuestionCard key={q.id} q={q} batch={batch} k={k} />)}
          </Section>
        );
      })()}

      {item.options.length > 0 && item.kind !== "approval" && item.kind !== "question" && (
        <Section id="inbox.options" title="Options" extra={item.options.length}>
          <div className={item.options.some((o) => o.example) ? "options wide" : "options"}>
            {item.options.map((o, n) => {
              const picked = (open ? choice : item.answer?.choice ?? "").split(", ");
              const on = item.multi ? picked.includes(o.label) : (open ? choice : item.answer?.choice) === o.label;
              return (
                <div key={n} className="option-wrap">
                <button
                  className={on ? "option on" : "option"}
                  disabled={!open}
                  onClick={() => {
                    if (item.multi) {
                      // the labels in the order Claude offered them, joined the way Claude Code joins a multi-select answer
                      const next = on ? picked.filter((l) => l !== o.label) : [...picked, o.label];
                      setChoice(item.options.map((x) => x.label).filter((l) => next.includes(l)).join(", "));
                    } else setChoice(o.label);
                    setError("");
                  }}
                >
                  <span>
                    ({String.fromCharCode(97 + n)}) {o.label}
                    {item.recommended === n && <span className="tag">Recommended</span>}
                  </span>
                  {o.detail && <span className="muted small">{o.detail}</span>}
                </button>
                {o.example && <Example e={o.example} cwd={item.cwd} />}
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {item.kind === "question" ? null : open ? (
        <Section id="inbox.answer" title={item.kind === "result" ? "Review note (optional)" : "Your answer"}>
          <textarea
            value={text}
            rows={3}
            placeholder="Optional note"
            onChange={(e) => {
              setText(e.target.value);
              setError("");
            }}
          />
          {error && <p className="bad small">{error}</p>}
          <div className="actions">
            {item.kind === "suggestion" && (
              <>
                <button className="primary" disabled={busy} onClick={() => send("Accept")}>
                  Accept
                </button>
                <button disabled={busy} onClick={() => send("Decline")}>
                  Decline
                </button>
              </>
            )}
            {item.kind === "approval" && (
              <>
                <button className="primary" disabled={busy} onClick={() => send("Allow")}>
                  Allow
                </button>
                <button disabled={busy} onClick={() => send("Deny")}>
                  Deny
                </button>
              </>
            )}
            {item.kind === "result" && (
              <button className="primary" disabled={busy} onClick={() => send(text.trim() ? "Reviewed, see note" : "")}>
                Mark reviewed
              </button>
            )}
          </div>
        </Section>
      ) : (
        <Section
          id="inbox.answered"
          title="Your answer"
          extra={item.deliveredVia ? (item.deliveredVia === "live" ? "delivered to the open session" : "delivered by resume") : ""}
        >
          <Md text={[item.answer?.choice && `**${item.answer.choice}**`, item.answer?.text].filter(Boolean).join("\n\n") || "Reviewed, no note"} />
        </Section>
      )}
      {item.followUp && (
        <Section id="inbox.followup" title="The session's reply">
          <Md text={item.followUp} cwd={item.cwd} />
        </Section>
      )}
      {(item.status === "answered" || item.status === "delivering") && item.waitReason && (
        <div className="actions">
          <p className="small">
            {item.waitReason === "turn"
              ? "The session is in a turn: your answer goes when it ends."
              : item.waitReason === "upgrade"
              ? "The plan is being moved to the latest format first: your answer goes to the new plan's session."
              : "The session was last used in the app or a terminal and may still be open there: tell it through Remote Control, or send it anyway."}
          </p>
          <button onClick={() => cancelAnswer(item)}>Cancel</button>
          {item.waitReason === "app" && (
            <button onClick={() => forceAnswer(item)} disabled={item.force}>
              {item.force ? "Sending anyway" : "Send anyway (a second process: the open window won't see it)"}
            </button>
          )}
        </div>
      )}
      {item.error && <p className="bad small">Delivery problem: {item.error}</p>}
    </article>
  );
}
