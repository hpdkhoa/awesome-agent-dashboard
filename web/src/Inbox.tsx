import { useState, type ReactNode } from "react";
import { PcText } from "./FileView";
import { answerItem, askBack, batchOf, cancelAnswer, forceAnswer, saveDraft, sendApproveGenerated, sendBatch, type InboxItem, type Plan, type Session } from "./data";
import { relPath, tmpFolderOf, versionFolderOf } from "./planCheck";
import { dotState, isSaved, nextTodo, step, swipeDir } from "./phone";
import { Example } from "./Example";
import { Md } from "./Markdown";
import { MoreMenu } from "./MoreMenu";
import { fileName, openFile } from "./FileView";
import { Section } from "./Section";
import { colourCode } from "./codeColour";
import { tm, ago } from "./fmt";

const KIND = { question: "Question", suggestion: "Suggestion", result: "Result to review", approval: "Approval" };
// The type tag (the owner, 2026-11-27: "make the tag and different the inbox message type so no work on 1 type replace
// work on another type"; pick "B: tag + left bar"): one colour per type on the tag, the row's and the card's left bar.
const TAG = { question: "Question", result: "Review", suggestion: "Suggestion", approval: "Approval" };
function KindTag({ item }: { item: InboxItem }) {
  return <span className="kind-chip" data-kind={item.kind}>{TAG[item.kind]}</span>;
}
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

// A question asked on a review (inbox_ask review=<result id>) is listed inside that review card, not as its own inbox
// message (the owner, 2026-11-28: "the question will listed inside the review/report if it is belong to this review,
// not like current 2 messages and send two times when I answered each").
export const reviewQuestions = (r: InboxItem, items: InboxItem[]) =>
  r.kind === "result" ? items.filter((q) => q.kind === "question" && q.reviewId === r.id) : [];
export const inReview = (q: InboxItem, items: InboxItem[]) =>
  q.kind === "question" && !!q.reviewId && items.some((r) => r.id === q.reviewId && r.kind === "result");
// the card to show for a picked item: a review's question opens its review
export const shownItem = (i: InboxItem | undefined, items: InboxItem[]) =>
  i && inReview(i, items) ? items.find((r) => r.id === i.reviewId) ?? i : i;

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
  const head = (i: InboxItem) => !inReview(i, items) &&
    (!i.batchId || !items.some((x) => x.batchId === i.batchId && (x.batchIndex ?? 0) < (i.batchIndex ?? 0)));
  const sorted = [...items].filter(head)
    .sort((a, b) => Number(rowWaits(b)) - Number(rowWaits(a)));
  const size = (i: InboxItem) => (i.batchId ? items.filter((x) => x.batchId === i.batchId) : [i]);
  // a review's row waits while its card waits or one of its questions does (the owner, 2026-11-28)
  function rowWaits(i: InboxItem) {
    return size(i).some(isWaiting) || reviewQuestions(i, items).some(isWaiting);
  }
  return (
    <ul className="list">
      {sorted.map((i) => (
        <li key={i.id} className={i.id === picked ? "row on" : "row"} data-kind={i.kind} onClick={() => onPick(i.id)}>
          <span className={rowWaits(i) ? "dot wait" : "dot"} />
          <div className="grow">
            <div className="title"><KindTag item={i} /><Topic item={i} />{size(i).length > 1 ? `${size(i).length} questions: ` : ""}{i.title}
              {reviewQuestions(i, items).length > 0 && (
                <span className="muted small"> · {reviewQuestions(i, items).filter(isWaiting).length} of {reviewQuestions(i, items).length} questions waiting</span>
              )}</div>
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

// The work of each type, one view per type (the owner's pick 2026-11-27 "A: Done + To review"): a result shows what
// was done in full, then its files with Changed + Check (to review); a suggestion its idea; an approval the call.
function KindWork({ item, items }: { item: InboxItem; items: InboxItem[] }) {
  if (item.kind === "result") return <><ResultReportView item={item} items={items} /><ResultWork item={item} /></>;
  if (item.kind === "suggestion") return <SuggestionWork item={item} />;
  if (item.kind === "approval") return <ApprovalWork item={item} />;
  return null;
}
function ResultWork({ item }: { item: InboxItem }) {
  if (!item.text.trim()) return null;
  return <Section id="inbox.result.done" title="Done"><Md text={item.text} cwd={item.cwd} /></Section>;
}
// The exact work of a result, folded (the owner, 2026-11-28: "another default collapsed section is "quote" which show
// me exactly the part of the work ... quote what changed inside what file, sort by file and is sub collapsed
// sections"; pick "Session quote, bridge checks"): one folded part per file, sorted by path, its text as the bridge
// found it in the file.
// The Result section (the owner, 2026-11-28: pick "New Result field", the "Dashboard Card / Report Layout"; "Add
// Failed"; "Item + fix"; "Layout order, orange"): the header line, then the five parts in the layout's order, each
// folding. Exceptions carry the one action colour. Needs Approval lists the questions asked on this review, answered
// here. Status shows Needs Your Input while one of them waits (a Failed report stays Failed).
export function reportStatus(r: NonNullable<InboxItem["report"]>, waiting: number) {
  return r.status !== "Failed" && waiting > 0 ? "Needs Your Input" : r.status;
}
export function runTime(seconds: number | null | undefined) {
  if (seconds == null) return "not measured";
  const m = Math.floor(seconds / 60), s = seconds % 60;
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : m > 0 ? `${m} min ${s} s` : `${s} s`;
}
function Lines({ rows }: { rows: string[] }) {
  return rows.length ? <ul>{rows.map((x, n) => <li key={n}>{x}</li>)}</ul> : <ul><li className="muted">None</li></ul>;
}
// the colours (the owner, 2026-11-29: pick "B: chips + status pill", note "use b and c together"): each part its own
// tint, bar and title colour (C), label chips, a status pill and the Bottom Line in a box (B). Orange is kept for what
// needs the owner: the Exceptions part only when it holds something, the Needs Approval and Skipped chips.
function Chip({ k, children }: { k: string; children: string }) {
  return <span className="rchip" data-chip={k}>{children}</span>;
}
function Part({ k, children }: { k: string; children: ReactNode }) {
  return <div className="rpart" data-part={k}>{children}</div>;
}
export function ResultReportView({ item, items }: { item: InboxItem; items: InboxItem[] }) {
  const r = item.report;
  if (!r) return null;
  const qs = reviewQuestions(item, items);
  const waiting = qs.filter(isWaiting).length;
  const status = reportStatus(r, waiting);
  // one entry per batch, in the order asked
  const batches: InboxItem[][] = [];
  for (const q of [...qs].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.batchIndex ?? 0) - (b.batchIndex ?? 0))) {
    const b = batches.find((x) => q.batchId && x[0].batchId === q.batchId);
    if (b) b.push(q); else batches.push([q]);
  }
  const exceptions = qs.length + r.skipped.length;
  return (
    <Section id="inbox.result.report" title="Result" main>
      <div className="result-report" data-report-status={status}>
        <p className="report-head">
          Status: <b className="rpill" data-status={status}>{status}</b> • Run: {r.runId ? `#${r.runId}` : "none"} • Time: {runTime(r.seconds)} • {tm(r.at)}
        </p>
        <Part k="bottom">
          <Section id="inbox.result.bottom" title="1. Bottom Line">
            <p className="rbottom">{r.bottom_line}</p>
          </Section>
        </Part>
        <Part k="deliver">
          <Section id="inbox.result.deliverables" title="2. Deliverables & Changes Made" extra={r.created.length + r.updated.length + r.sent.length}>
            <ul>
              <li><Chip k="created">Created</Chip><Lines rows={r.created} /></li>
              <li><Chip k="updated">Updated</Chip><Lines rows={r.updated} /></li>
              <li><Chip k="sent">Sent / Executed</Chip><Lines rows={r.sent} /></li>
            </ul>
          </Section>
        </Part>
        <Part k="decide">
          <Section id="inbox.result.decisions" title="3. Decisions & Assumptions Made by Agent" extra={r.decisions.length}>
            <Lines rows={r.decisions} />
          </Section>
        </Part>
        <div className={exceptions ? "report-exceptions rpart need" : "report-exceptions rpart"} data-part={exceptions ? "need" : "clear"}>
          <Section id="inbox.result.exceptions" title="4. Exceptions & Items for Your Review" extra={exceptions}>
            <ul>
              <li>
                <Chip k={qs.length ? "need" : "none"}>Needs Approval</Chip>
                {qs.length > 0 && <span className="muted small"> · {waiting} of {qs.length} waiting</span>}
                {qs.length === 0 ? <ul><li className="muted">None</li></ul> : (
                  <div className="report-questions">
                    {batches.map((b) => b.map((q, k) => <QuestionCard key={q.id} q={q} batch={b} k={k} titled />))}
                  </div>
                )}
              </li>
              <li>
                <Chip k={r.skipped.length ? "need" : "none"}>Skipped / Flagged</Chip>
                {r.skipped.length === 0 ? <ul><li className="muted">None</li></ul> : (
                  <ul>{r.skipped.map((s, n) => <li key={n}>{s.item}<ul><li><Chip k="fix">Fix</Chip> {s.fix}</li></ul></li>)}</ul>
                )}
              </li>
            </ul>
          </Section>
        </div>
        <Part k="next">
          <Section id="inbox.result.next" title="5. Next Scheduled Action">
            <ul><li>{r.next}</li></ul>
          </Section>
        </Part>
      </div>
    </Section>
  );
}

export function quoteRows(item: Pick<InboxItem, "changes">) {
  return (item.changes ?? []).filter((c) => c.quote?.trim()).sort((a, b) => a.file.localeCompare(b.file));
}
export function QuoteWork({ item }: { item: InboxItem }) {
  const rows = quoteRows(item);
  if (rows.length === 0) return null;
  return (
    <div className="quote-part"><Section id="inbox.quote" title="Quote" extra={rows.length} open={false}>
      <div data-quote>
        {rows.map((c) => (
          <Section key={c.file} id={`inbox.quote.${item.id}.${c.file}`} title={<span className="qfile" title={c.file}>{fileName(c.file)}</span>} open={false}>
            <pre className="quote-text"><code>{colourCode(c.quote ?? "", c.file).map((t, n) => (t.k ? <span key={n} className={`ck-${t.k}`}>{t.t}</span> : t.t))}</code></pre>
          </Section>
        ))}
      </div>
    </Section></div>
  );
}
function SuggestionWork({ item }: { item: InboxItem }) {
  if (!item.text.trim()) return null;
  return <Section id="inbox.suggestion.idea" title="Suggestion"><Md text={item.text} cwd={item.cwd} /></Section>;
}
function ApprovalWork({ item }: { item: InboxItem }) {
  const call = ["```json", item.text, "```"].join("\n");
  return <Section id="inbox.approval.call" title="The call"><Md text={call} cwd={item.cwd} /></Section>;
}

// One question of a batch (the owner's words, 2026-11-07): options drawn or with their difference, a text box for your
// own answer or a question instead of a pick (like "Other"), your saved answers kept as a thread, and ask back.
// phone (step i7): a tap on an option saves it at once and onSaved moves to the next question; the batch is sent only
// by the Send button (the owner's pick "Tap = save, go to next; Send at the end").
// titled: inside a review card the question has no title of its own above it, so it shows its title (2026-11-28)
function QuestionCard({ q, batch, k, onSaved, titled }: { q: InboxItem; batch: InboxItem[]; k: number; onSaved?: (id: string) => void; titled?: boolean }) {
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
      {(batch.length > 1 || titled) && <b>{batch.length > 1 ? `${k + 1}. ` : ""}{q.title}</b>}{q.redrawn && <span className="tag">Redrawn {ago(q.redrawn)}{(q.revisions?.length ?? 0) > 1 ? ` · ${q.revisions!.length}x` : ""}</span>}
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
  return (
    <article className="inbox-card" data-kind={item.kind} {...(item.planId ? { "data-quote-plan": item.planId } : item.sessionId && item.sessionId !== "unknown" ? { "data-quote-session": item.sessionId } : {})}>
      {onBack && (
        <div className="pback">
          <button className="link" onClick={onBack}>‹ Inbox</button>
        </div>
      )}
      <h1><KindTag item={item} /><Topic item={item} />{item.title}</h1>
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
      {/* each type shows its own work, so a change on one type never touches another (the owner, 2026-11-27: "the
          inbox must always show what has been done and need to review, not summaries or reword of the questions").
          A question shows its text in its card above, so it has no section here (2026-11-26). */}
      <KindWork item={item} items={items.length ? items : [item]} />

      {item.files.length > 0 && (
        <Section id="inbox.files" title={item.kind === "result" ? "Files to review" : "Files"} extra={item.files.length}>
          <ul className="small">
            {item.files.map((f) => {
              // under each file link: what changed there and what to check (the owner, 2026-11-27: "show me a short
              // summarize what is changed in the files and what need to review so I can check via the file link")
              const c = (item.changes ?? []).find((x) => x.file === f);
              return (
                <li key={f}>
                  <code className="file-link" role="button" title={f} onClick={() => openFile(f, item.cwd)}>{fileName(f)}</code>
                  {c && (
                    <div className="file-change">
                      <div><b>Changed:</b> {c.changed}</div>
                      <div className="wait-fg"><b>Check:</b> {c.check}</div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      {item.kind === "result" && <QuoteWork item={item} />}

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
