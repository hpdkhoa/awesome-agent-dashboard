import { useState } from "react";
import { answerItem, cancelAnswer, forceAnswer, type InboxItem, type Plan, type Session } from "./data";
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
  const sorted = [...items].sort((a, b) => Number(isWaiting(b)) - Number(isWaiting(a)));
  return (
    <ul className="list">
      {sorted.map((i) => (
        <li key={i.id} className={i.id === picked ? "row on" : "row"} onClick={() => onPick(i.id)}>
          <span className={isWaiting(i) ? "dot wait" : "dot"} />
          <div className="grow">
            <div className="title">{i.title}</div>
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

export function InboxView({ item, session, plan, onOpenPlan }: {
  item: InboxItem; session?: Session; plan?: Plan; onOpenPlan?: (id: string) => void;
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

      {item.options.length > 0 && item.kind !== "approval" && (
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

      {open ? (
        <Section id="inbox.answer" title={item.kind === "result" ? "Review note (optional)" : "Your answer"}>
          <textarea
            value={text}
            rows={3}
            placeholder={item.kind === "question" ? "Free-text answer, or a note with your choice (markdown works)" : "Optional note"}
            onChange={(e) => {
              setText(e.target.value);
              setError("");
            }}
          />
          {error && <p className="bad small">{error}</p>}
          <div className="actions">
            {item.kind === "question" && (
              <button className="primary" disabled={busy} onClick={() => send(choice)}>
                Answer
              </button>
            )}
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
