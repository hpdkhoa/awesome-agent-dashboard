import { useState } from "react";
import { PcText } from "./FileView";
import { answerItem, askBack, batchOf, cancelAnswer, forceAnswer, saveDraft, sendApproveGenerated, sendBatch, type InboxItem, type Plan, type Session } from "./data";
import { relPath, tmpFolderOf, versionFolderOf } from "./planCheck";
import { dotState, isSaved, nextTodo, step, swipeDir } from "./phone";
import { Example } from "./Example";
import { Md } from "./Markdown";
import { MoreMenu } from "./MoreMenu";
import { fileName, openFile } from "./FileView";
import { Section } from "./Section";
import { tm, ago } from "./fmt";

const KIND = { question: "Question", suggestion: "Suggestion", result: "Result to review", approval: "Approval" };
// F7: a question's owner topic, shown on the row and the item (why it is the owner's to decide)
const OWNER_TOPICS = ["scope", "policy", "approval", "spend"];
function Topic({ item }: { item: InboxItem }) {
  if (!item.topic || !OWNER_TOPICS.includes(item.topic)) return null;
  return <span className="topic-chip" data-topic={item.topic} title="Only you decide this: it was routed to your inbox">{item.topic}</span>;
}
const STATUS = {
  open: "waiting for you",
  answered: "answered, waiting to reach the session",
  delivering: "sending to the session",
  delivered: "delivered",
  closed: "closed",
};

export const isWaiting = (i: InboxItem) => i.status === "open";

// The owner's pick 2026-11-16, "Fix the dashboard": an approved answer on a Generated result approves that result's
// files alone (from <version>/tmp/ to <version>/, onto the plan's Generated section) and keeps the rest of tmp/.
// Approved = the Approve button, or a note that starts with "approve" / "approved" (the owner's own answer).
export const approvesNote = (choice: string, note: string) => choice === "Approve" || /^\s*approved?\b/i.test(note);
export function generatedApproval(item: InboxItem, plan?: Plan) {
  if (item.kind !== "result" || !plan || !/^generated\b/i.test(item.title ?? "")) return null;
  const keep = (item.files ?? []).map((f) => relPath(f, plan.cwd)).filter((f) => tmpFolderOf(f) && versionFolderOf(f, plan.id));
  const folder = keep.length ? tmpFolderOf(keep[0]) : null;
  return folder ? { folder, keep: keep.filter((f) => tmpFolderOf(f) === folder), drop: [] as string[], keepTmp: true } : null;
}


export function InboxList({ items, picked, onPick }: { items: InboxItem[]; picked?: string; onPick: (id: string) => void }) {
  // one row per batch: its first question stands for it
  // the lowest index still stored, so a batch whose first question is gone still has a row
  const head = (i: InboxItem) =>
    !i.batchId || !items.some((x) => x.batchId === i.batchId && (x.batchIndex ?? 0) < (i.batchIndex ?? 0));
  const sorted = [...items].filter(head)
    .sort((a, b) => Number(isWaiting(b)) - Number(isWaiting(a)));
  const size = (i: InboxItem) => (i.batchId ? items.filter((x) => x.batchId === i.batchId) : [i]);
  return (
    <ul className="list">
      {sorted.map((i) => (
        <li key={i.id} className={i.id === picked ? "row on" : "row"} onClick={() => onPick(i.id)}>
          <span className={size(i).some(isWaiting) ? "dot wait" : "dot"} />
          <div className="grow">
            <div className="title"><Topic item={i} />{size(i).length > 1 ? `${size(i).length} questions: ` : ""}{i.title}</div>
            <div className="muted small">
              {KIND[i.kind]} · {i.workType} · {ago(i.editedAt ?? i.createdAt)} · {i.withdrawn ? "withdrawn by the session" : STATUS[i.status]}
              {(i.version ?? 1) > 1 && <span className="tag" data-edited>edited v{i.version}</span>}
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
// phone (step i7): a tap on an option saves it at once and onSaved moves to the next question; the batch is sent only
// by the Send button (the owner's pick "Tap = save, go to next; Send at the end").
function QuestionCard({ q, batch, k, onSaved }: { q: InboxItem; batch: InboxItem[]; k: number; onSaved?: (id: string) => void }) {
  const [choice, setChoice] = useState(q.draft?.choice ?? "");
  const [text, setText] = useState(q.draft?.text ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const open = q.status === "open";
  const shown = open ? choice : q.answer?.choice ?? "";
  const phone = !!onSaved;
  async function run(f: () => Promise<unknown>) {
    setBusy(true);
    let ok = true;
    try {
      await f();
    } catch (e) {
      ok = false;
      setError(String((e as { code?: string }).code ?? e));
    }
    setBusy(false);
    return ok;
  }
  const save = (c: string) =>
    phone ? run(() => saveDraft(q, batch, c, text.trim(), false)).then((ok) => ok && onSaved!(q.id))
      : run(() => saveDraft(q, batch, c, text.trim()));
  const left = batch.filter((x) => x.status === "open" && !x.draft && x.id !== q.id).length;
  return (
    <div className="qcard">
      {/* one question: its title is the page's title already, so it is not shown twice */}
      {batch.length > 1 && <b>{k + 1}. {q.title}</b>}{q.redrawn && <span className="tag">Redrawn {ago(q.redrawn)}{(q.revisions?.length ?? 0) > 1 ? ` · ${q.revisions!.length}x` : ""}</span>}
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
                    } else if (phone && open) {
                      setChoice(o.label);
                      setError("");
                      save(o.label);
                      return;
                    } else setChoice(on ? "" : o.label);
                    setError("");
                  }}>
                  <span>
                    ({String.fromCharCode(97 + n)}) {o.label}
                    {q.recommended === n && <span className="tag">Recommended</span>}
                  </span>
                  {o.detail && <Md line className="muted small" text={o.detail} />}
                  {o.differs && <span className="small differs">≠ <Md line text={o.differs} /></span>}
                </button>
                {o.example && <Example e={o.example} cwd={q.cwd} />}
              </div>
            );
          })}
        </div>
      )}
      {open && (
        <>
          <textarea rows={2} value={text} placeholder={q.via === "hook" ? "Your own answer, instead of a pick" : "Your own answer, or a question back: Save keeps it as your answer, Ask back asks the session"}
            onChange={(e) => (setText(e.target.value), setError(""))} />
          {error && <p className="bad small">{error}</p>}
          <div className="actions">
            <button className="primary" disabled={busy}
              onClick={() => (!choice && !text.trim() ? setError("Pick an option or write something first.")
                : save(choice))}>
              {phone ? "Save, next" : q.draft ? "Change my answer" : "Save my answer"}
            </button>
            <span className="small muted">
              {q.draft ? `saved: ${[q.draft.choice, q.draft.text].filter(Boolean).join(" · ")}` : "not saved yet"}
              {!phone && left > 0 ? ` · sent when ${left === 1 ? "1 more question is" : `${left} more questions are`} saved` : ""}
            </span>
          </div>
          {q.via !== "hook" && (
            <div className="actions">
              {/* one box for both (the owner's words, 2026-11-08: "check the ask back button, now it is disabled and I
                  cannot click it to ask"): the question typed in the box above goes back to the session */}
              <button disabled={busy} onClick={() => (!text.trim() ? setError("Write your question in the box first.")
                : run(async () => (await askBack(q, text.trim()), setText(""))))}>Ask back</button>
              <span className="small muted">sends the text in the box as a question; the session replies in the thread</span>
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
                <span className="small muted">{t.who === "owner" ? (t.kind === "ask" ? "you asked" : "you saved") : t.kind === "redraw" ? "session redrew" : "session"} · {ago(t.at)}</span>{" "}
                {t.kind === "answer" ? (
                  <b>{[t.choice, t.text].filter(Boolean).join(" · ")}</b>
                ) : t.who === "session" && t.text == null && q.sessionId ? (
                  <PcText reply={{ session: q.sessionId, item: q.id, k: (q.thread ?? []).slice(0, n).filter((x) => x.who === "session" && x.kind !== "redraw").length }} cwd={q.cwd} />
                ) : (
                  <Md text={t.text ?? ""} cwd={q.cwd} />
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

// Phone (step i7, "One card per screen, swipe + dots"): one question per screen; swipe left or right, or Prev / Next;
// a dot per question (green saved, blue shown, grey to answer); Send appears once every question is saved.
function PhoneBatch({ batch }: { batch: InboxItem[] }) {
  const first = batch.findIndex((q) => !isSaved(q));
  const [k, setK] = useState(first < 0 ? 0 : first);
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const open = batch.filter((q) => q.status === "open");
  const ready = open.length > 0 && open.every((q) => q.draft);
  const go = (by: number) => (setK((x) => step(x, batch.length, by)), window.scrollTo(0, 0));
  function onSaved(id: string) {
    const s = new Set(saved).add(id);
    setSaved(s);
    const j = nextTodo(batch, k, s);
    if (j >= 0) (setK(j), window.scrollTo(0, 0));
  }
  async function send() {
    setBusy(true);
    try {
      await sendBatch(batch);
    } catch (e) {
      setError(String((e as { code?: string; message?: string }).message ?? e));
    }
    setBusy(false);
  }
  const dots = dotState(batch, k);
  return (
    <div className="pbatch"
      onTouchStart={(e) => setStart({ x: e.touches[0].clientX, y: e.touches[0].clientY })}
      onTouchEnd={(e) => {
        if (!start) return;
        const d = swipeDir(e.changedTouches[0].clientX - start.x, e.changedTouches[0].clientY - start.y);
        setStart(null);
        if (d) go(-d);
      }}>
      <QuestionCard key={batch[k].id} q={batch[k]} batch={batch} k={k} onSaved={onSaved} />
      <div className="pbar">
        <button disabled={k === 0} onClick={() => go(-1)} aria-label="Previous question">‹</button>
        <span className="pdots" aria-label={`question ${k + 1} of ${batch.length}`}>
          {dots.map((d, n) => <i key={n} className={`pdot ${d}`} onClick={() => go(n - k)} />)}
        </span>
        {ready ? (
          <button className="primary" disabled={busy} onClick={send}>
            {open.length === 1 ? "Send answer" : `Send ${open.length} answers`}
          </button>
        ) : (
          <button disabled={k === batch.length - 1} onClick={() => go(1)} aria-label="Next question">›</button>
        )}
      </div>
      {error && <p className="bad small">{error}</p>}
    </div>
  );
}

export function InboxView({ item, session, plan, onOpenPlan, items = [], phone = false, onBack }: {
  item: InboxItem; session?: Session; plan?: Plan; onOpenPlan?: (id: string) => void; items?: InboxItem[];
  phone?: boolean; onBack?: () => void;
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
      const gen = approvesNote(c, text.trim()) ? generatedApproval(item, plan) : null;
      if (gen && plan) await sendApproveGenerated(plan, gen);
    } catch (e) {
      setError(String((e as { code?: string }).code ?? e));
    }
    setBusy(false);
  }

  const open = item.status === "open";
  const questions = item.kind === "question" && (() => {
    const batch = batchOf(item, items.length ? items : [item]);
    return (
      <Section id="inbox.batch" title={batch.length > 1 ? `${batch.length} questions, answered together` : "The question"}>
        {phone ? <PhoneBatch batch={batch} /> : batch.map((q, k) => <QuestionCard key={q.id} q={q} batch={batch} k={k} />)}
      </Section>
    );
  })();
  const body = item.kind === "approval" ? "```json\n" + item.text + "\n```" : item.text;
  return (
    <article {...(item.planId ? { "data-quote-plan": item.planId } : item.sessionId && item.sessionId !== "unknown" ? { "data-quote-session": item.sessionId } : {})}>
      {onBack && (
        <div className="pback">
          <button className="link" onClick={onBack}>‹ Inbox</button>
        </div>
      )}
      <h1><Topic item={item} />{item.title}</h1>
      {/* phone: the questions come first, right under the title (the owner's pick "Full screen, Back to list") */}
      {phone && questions}
      <p className="meta">
        {KIND[item.kind]} · {item.workType} · {item.machine} · {ago(item.createdAt)} · {item.withdrawn ? "withdrawn by the session" : STATUS[item.status]}
        {(item.version ?? 1) > 1 && item.editedAt && <> · edited v{item.version} {ago(item.editedAt)}</>}
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
            from the session's question box: answer within 10 minutes of {tm(item.createdAt)}, or the
            session asks there instead
          </>
        )}
      </p>

      {item.withdrawn && (
        <p className="small" data-withdrawn>
          <b>Withdrawn</b> by the session {ago(item.withdrawn.at)}: {item.withdrawn.reason}
        </p>
      )}
      {/* a question's text is shown in its card, so no Details section repeats it (the owner, 2026-11-26: "phần the
          question và details ở inbox y chang nhau thì không để 2 phần tốn chỗ") */}
      {item.kind !== "question" && (
        <Section id="inbox.text" title={item.kind === "approval" ? "The call" : "Details"}>
          <Md text={body} cwd={item.cwd} />
        </Section>
      )}

      {item.files.length > 0 && (
        <Section id="inbox.files" title="Files" extra={item.files.length}>
          <ul className="small">
            {item.files.map((f) => (
              <li key={f}>
                <code className="file-link" role="button" title={f} onClick={() => openFile(f, item.cwd)}>{fileName(f)}</code>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {(item.versions?.length ?? 0) > 0 && (
        <Section id="inbox.versions" title="Earlier versions" extra={item.versions!.length}>
          <ol className="small" data-result-versions>
            {[...item.versions!].reverse().map((v) => (
              <li key={v.n}>
                <details>
                  <summary>
                    v{v.n} · {tm(v.at)} · {v.title}
                    {v.answer && <> · your review: <b>{v.answer.choice || "Reviewed"}</b>{v.answer.text ? `, "${v.answer.text}"` : ""}</>}
                  </summary>
                  <Md text={v.text} cwd={item.cwd} />
                </details>
              </li>
            ))}
          </ol>
        </Section>
      )}

      {!phone && questions}

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
                  {o.detail && <Md line className="muted small" text={o.detail} />}
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
            {item.kind === "result" && generatedApproval(item, plan) && (
              <button className="primary" disabled={busy} onClick={() => send("Approve")}>
                Approve this file
              </button>
            )}
            {item.kind === "result" && (
              <button className={generatedApproval(item, plan) ? "" : "primary"} disabled={busy} onClick={() => send(text.trim() ? "Reviewed, see note" : "")}>
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
      {item.deliveredVia === "resume" && item.commandId && (
        <Section id="inbox.followup" title="The session's reply">
          <PcText run={item.commandId} cwd={item.cwd} />
        </Section>
      )}
      {(item.status === "answered" || item.status === "delivering") && item.waitReason && (
        <div className="actions">
          <p className="small">
            {item.waitReason === "turn"
              ? "The session is in a turn: your answer goes when it ends."
              : item.waitReason === "resources"
              ? "This PC is low on free disk, RAM or GPU: your answer goes when there is room again (numbers on the Runs tab)."
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
