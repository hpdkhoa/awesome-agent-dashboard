import { useState } from "react";
import { answerItem, type InboxItem, type Session } from "./data";

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
        </li>
      ))}
      {items.length === 0 && (
        <li className="muted row">Nothing yet. Sessions post here with inbox_ask, inbox_suggest and inbox_result.</li>
      )}
    </ul>
  );
}

export function InboxView({ item, session }: { item: InboxItem; session?: Session }) {
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
  return (
    <article>
      <p className="muted small">
        {KIND[item.kind]} · {item.workType} · {item.machine} · {ago(item.createdAt)} · {STATUS[item.status]}
        <br />
        from session: {session?.title ?? item.sessionId}
      </p>
      <h1>{item.title}</h1>
      <p className={item.kind === "approval" ? "quote mono" : "quote"}>{item.text}</p>

      {item.files.length > 0 && (
        <>
          <h2>Files</h2>
          <ul className="small">
            {item.files.map((f) => (
              <li key={f}>
                <code>{f}</code>
              </li>
            ))}
          </ul>
        </>
      )}

      {item.options.length > 0 && item.kind !== "approval" && (
        <>
          <h2>Options</h2>
          <div className="options">
            {item.options.map((o, n) => {
              const on = (open ? choice : item.answer?.choice) === o.label;
              return (
                <button
                  key={n}
                  className={on ? "option on" : "option"}
                  disabled={!open}
                  onClick={() => {
                    setChoice(o.label);
                    setError("");
                  }}
                >
                  <span>
                    ({String.fromCharCode(97 + n)}) {o.label}
                    {item.recommended === n && <span className="tag">Recommended</span>}
                  </span>
                  {o.detail && <span className="muted small">{o.detail}</span>}
                </button>
              );
            })}
          </div>
        </>
      )}

      {open ? (
        <>
          <h2>{item.kind === "result" ? "Review note (optional)" : "Your answer"}</h2>
          <textarea
            value={text}
            rows={3}
            placeholder={item.kind === "question" ? "Free-text answer, or a note with your choice" : "Optional note"}
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
        </>
      ) : (
        <>
          <h2>Answer</h2>
          <p className="quote">
            {[item.answer?.choice, item.answer?.text].filter(Boolean).join(" · ") || "Reviewed, no note"}
          </p>
          {item.deliveredVia && (
            <p className="muted small">
              Delivered {item.deliveredVia === "live" ? "to the open session" : "by resuming the closed session"}
              {item.deliveredAt ? " " + ago(item.deliveredAt) : ""}.
            </p>
          )}
          {item.followUp && (
            <>
              <h2>The session's reply</h2>
              <p className="quote">{item.followUp}</p>
            </>
          )}
        </>
      )}
      {item.error && <p className="bad small">Delivery problem: {item.error}</p>}
    </article>
  );
}
