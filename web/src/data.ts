import type { Phase } from "./phases";
import { itemHash, type HarnessItem, type HarnessTicks } from "./harness";
import type { Kind } from "./planCheck";
import { useEffect, useState } from "react";
import { collection, doc, limit, onSnapshot, orderBy, query, setDoc, updateDoc, where, type QueryConstraint } from "firebase/firestore";
import { db } from "./firebase";

// The shapes the bridge writes (bridge/agent_bridge/aggregate.py).
export type Tokens = {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  total: number;
  costUsd: number;
  unpricedTokens: number;
};

export type Session = {
  id: string;
  machine: string;
  workType: string;
  cwd: string;
  title: string;
  firstPrompt: string;
  lastPrompt: string;
  lastReply: string;
  startedAt: string;
  lastAt: string;
  prompts: number;
  subagents: number;
  messages: number;
  remoteId?: string; // the Remote Control session id ("cse_..."), when the session was ever linked
  models: Record<string, number>;
  tokens: Tokens;
  days: Record<string, Tokens>;
  syncedAt: string;
};

export type Usage = Tokens & { day: string; byWorkType: Record<string, Tokens>; byModel: Record<string, Tokens>; sessionCount: number };
export type WorkType = Tokens & { id: string; sessions: number; lastAt: string };
export type InboxItem = {
  id: string;
  kind: "question" | "suggestion" | "result" | "approval";
  sessionId: string;
  machine: string;
  cwd: string;
  workType: string;
  title: string;
  text: string;
  options: { label: string; detail: string; differs?: string; example?: Example }[]; // differs: what is different
  recommended: number | null;
  files: string[];
  status: "open" | "answered" | "delivering" | "delivered" | "closed";
  createdAt: string;
  answer: { choice: string; text: string; at: string } | null;
  deliveredAt?: string;
  deliveredVia?: "live" | "resume";
  waitReason?: "turn" | "app" | "upgrade" | null; // why an answer has not reached the session yet (bridge runs.py)
  commandId?: string; // the message run that carries the answer to the session
  force?: boolean;
  error?: string | null;
  via?: "hook"; // posted by the question hook from Claude Code's own question box
  multi?: boolean; // more than one option may be picked
  planId?: string; // the plan this question belongs to
  round?: number; // asked on this version of the plan (0: before v1)
  reopened?: boolean; // the owner changed an earlier answer: the session branches the plan
  history?: { choice: string; text: string; at: string }[]; // earlier answers, oldest first
  stepId?: string; // asked while this step of the plan was running
  // one batch: questions asked together show as one entry and are answered together (2026-11-07)
  batchId?: string; batchIndex?: number; batchSize?: number;
  draft?: { choice: string; text: string; at: string }; // your latest saved answer, used when the batch is sent
  thread?: ThreadEntry[]; // your saved answers, your questions back and the session's replies, in order
  switch?: { to: PlanKind; commandId: string }; // a Q&A message asks to change the plan (bridge inbox.py ask_switch)
};

// Every option of a plan question carries one (the owner's words, 2026-11-03: "every choose will have an example").
export type Bench = { name: string; before: string; after: string; measured: boolean; source?: string };
// a session reply made after 2026-11-08 keeps only chars: its words are read from the session log on the PC (PcText)
export type ThreadEntry = { who: "owner" | "session"; kind: "answer" | "ask" | "reply"; choice?: string; text?: string; chars?: number; at: string };
export type Example =
  | { type: "visual"; svg: string; note?: string } // a drawing of the option
  | { type: "image"; before: string; after: string; note?: string }
  | { type: "code"; diff: string; bench: Bench[]; note?: string }
  | { type: "text"; draft: string; note?: string };

// A plan with rounds of questions (the owner's choice, 2026-11-01, "do 2"): versions in planVersions, questions in the
// inbox with planId and round.
export type Plan = {
  id: string; title: string; sessionId: string; machine: string; cwd: string; workType: string;
  status: "open" | "done" | "closed"; current: number; createdAt: string; updatedAt: string; closeNote?: string; // "done": the old word for closed
  format?: number; // plan format number (bridge inbox.py PLAN_FORMAT); none: 1 with parts, else 0
  upgradedTo?: string; // the plan in the latest format this older plan moved to (bridge runs.py _upgrade_first)
  chosen?: number; // the version on the chosen line (default: the newest)
  kind?: "parts"; // a plan with six parts (plan from a session, 2026-11-03)
  source?: { sessionId: string; commandId: string; pagesDir: string; pages: { file: string; first: number; last: number }[] };
  activeStep?: string | null;
  phase?: Phase; // where the plan is (phases.ts); none = Explore
};
// The six parts, in the owner's order (2026-11-03): goal, summary, rules, lessons and how each was applied, leftover, steps.
export type Parts = {
  goal: string; summary: string;
  rules: { rule: string; source: string }[];
  lessons: { lesson: string; taughtBy: string; appliedIn: string }[];
  leftover: string[];
  steps: { id: string; title: string; does: string; check: string; new?: boolean }[]; // new: work the record does not hold
  cite?: string; // the owner's words the plan reads, in log order (2026-11-05); part 1 says what the plan is for
};
// The message kinds on a plan: four change it (a new plan version), Q&A never does.
export type PlanKind = "qa" | "goal" | "step" | "rule" | "lesson";
export const PLAN_KINDS: [PlanKind, string][] = [
  ["qa", "Q&A"], ["goal", "Shift goal"], ["step", "Add step"], ["rule", "Change rule"], ["lesson", "Audit lesson"],
];
// A step version: each report on a step, its state and the session's reply (no plan version).
export type PlanStep = {
  id: string; planId: string; stepId: string; state: "next" | "now" | "done" | "failed"; updatedAt: string;
  versions: { n: number; state: string; reply: string; at: string; planVersion: number }[];
};
// madeBy: the answers that made this version, as they were then; parent: the version it grew from (a branch when older).
export type Decision = { id: string; title: string; choice: string; text: string };
export type PlanVersion = {
  id: string; planId: string; n: number; text: string; note: string; createdAt: string; parent?: number; madeBy?: Decision[];
  parts?: Parts; change?: { kind: PlanKind; message: string };
  phase?: Phase; phaseMove?: { from: Phase; to: Phase; order: string }; // phases.ts
  harness?: HarnessItem[]; // harness.ts: the list as it is in this version
};

export type Machine = {
  name: string;
  windowDays: number;
  sessions: number;
  syncedAt: string;
  folders?: { workType: string; path: string }[];
};

export type Run = {
  id: string;
  machine: string;
  folder?: string;
  prompt?: string;
  target?: string;
  cwd?: string;
  status: "new" | "waiting" | "running" | "stopping" | "done" | "stopped" | "failed" | "lost" | "cancelled" | "paused";
  action: "start" | "stop" | "message" | "check" | "plan" | "approve_generated" | "continue" | "auto_continue";
  pausedUntilAt?: string | null; // a run paused by the usage limit: the reset time the bridge read from claude's message
  autoContinue?: boolean; // continues by itself at the reset (bridge runs.py _pause, _auto_continue)
  autoBy?: "last" | "owner" | null; // the run that paused last, or the owner's pick
  continuedBy?: string; // the run that does this one's leftover work
  continueOf?: string; // the paused run this one continues
  moved?: { from: string; to: string }[]; // approve_generated: the approved files, where they went
  kind?: PlanKind; // a message on a plan
  planId?: string;
  sourceSessionId?: string; // plan from a session: the session it reads
  stage?: string; // plan from a session: where the reading is
  pausedUntil?: string | null; // plan from a session stopped by the usage limit: when it resets
  reused?: number; // plan from a session: pages whose notes came from an earlier run
  ownerText?: string;
  stepId?: string; // a Run step message, or a message asked on one step (Ask, Change, Quote on the step)
  part?: string; // a message asked on one part of the plan (Ask or Quote on its header, or selected words in it)
  planCheck?: boolean; // sent by the plan's Check button (planCheck.ts)
  generate?: { kinds: Kind[]; note?: string }; // the owner's Generate order (planCheck.ts)
  phaseOrder?: boolean; // the owner's order to move the plan's phase (phases.ts)
  quotes?: { checked: number; marked: number }; // plan from a session: quotes in the notes not found on their page
  waitReason?: "turn" | "app" | "upgrade";
  upgradeId?: string; upgradedFrom?: string; // a message on an older plan waits while the plan moves to the latest format
  // the archiver (bridge archiver.py, 2026-11-06): asked, archived, unarchiving, done, refused, unarchive failed
  archive?: string; archiveNote?: string | null;
  force?: boolean;
  permissionMode?: RunMode; // the setting the bridge read when this run went
  // "Check now": what the bridge's wait rule saw for the session (bridge runs.py session_status)
  check?: { turn: boolean; lastFrom: string; open: boolean | null; openSince: string | null; openIn: "app" | "terminal" | null };
  createdAt: string;
  sessionId?: string;
  workType?: string;
  startedAt?: string;
  endedAt?: string;
  result?: string;
  costUsd?: number;
  error?: string;
};

function useCollection<T>(name: string, ...constraints: QueryConstraint[]): T[] | null {
  const [rows, setRows] = useState<T[] | null>(null);
  useEffect(
    () => onSnapshot(query(collection(db, name), ...constraints), (s) => setRows(s.docs.map((d) => d.data() as T))),
    [name],
  );
  return rows;
}

// Sessions active in the last 5 days only, unless the owner asks for older ones: older threads cost no reads until then
// (the owner's words, 2026-11-01: "the thread with no active message more than 5 days need a collapse or hide state so
// no read consume in there").
export const RECENT_DAYS = 5;
export function useSessions(older: boolean): Session[] | null {
  const [rows, setRows] = useState<Session[] | null>(null);
  useEffect(() => {
    const since = new Date(Date.now() - RECENT_DAYS * 86400000).toISOString();
    const q = older
      ? query(collection(db, "sessions"), orderBy("lastAt", "desc"), limit(300))
      : query(collection(db, "sessions"), where("lastAt", ">=", since), orderBy("lastAt", "desc"));
    return onSnapshot(q, (s) => setRows(s.docs.map((d) => d.data() as Session)));
  }, [older]);
  return rows;
}
// every synced day, oldest to newest on the chart (the owner's words, 2026-11-08: "all spend type with full history")
export const useUsage = () => useCollection<Usage>("usage", orderBy("day", "desc"));
export const useWorkTypes = () => useCollection<WorkType>("workTypes");
export const useMachines = () => useCollection<Machine>("machines");
export const usePlans = () => useCollection<Plan>("plans", orderBy("updatedAt", "desc"), limit(100));

// One plan's versions, read only while its page is open. Sorted here, so the query needs no composite index.
export function usePlanVersions(planId: string | undefined): PlanVersion[] | null {
  const [rows, setRows] = useState<PlanVersion[] | null>(null);
  useEffect(() => {
    setRows(null);
    if (!planId) return;
    return onSnapshot(query(collection(db, "planVersions"), where("planId", "==", planId)), (s) =>
      setRows(s.docs.map((d) => d.data() as PlanVersion).sort((a, b) => a.n - b.n)),
    );
  }, [planId]);
  return rows;
}
export const useInbox = () => useCollection<InboxItem>("inbox", orderBy("createdAt", "desc"), limit(200));

// The owner's answer. The session picks it up live, or the bridge resumes the session if it has closed.
export const answerItem = (id: string, choice: string, text: string) =>
  updateDoc(doc(db, "inbox", id), { status: "answered", answer: { choice, text, at: new Date().toISOString() }, error: null });
// A batch (the owner's words, 2026-11-07: "I want to see the stored answers that I answered and can change them before
// the last question is answered and the choices will only use my latest choice without drift and I can review them
// back as the thread in inbox"). Saving keeps your latest answer as the draft and adds it to the thread; when every
// question of the batch has a draft, all are sent at once, each with its latest draft.
export async function saveDraft(item: InboxItem, batch: InboxItem[], choice: string, text: string) {
  const at = new Date().toISOString();
  const draft = { choice, text, at };
  await updateDoc(doc(db, "inbox", item.id), {
    draft, thread: [...(item.thread ?? []), { who: "owner", kind: "answer", choice, text, at }],
  });
  const drafts = new Map(batch.map((q) => [q.id, q.id === item.id ? draft : q.draft]));
  if (batch.every((q) => q.status !== "open" || drafts.get(q.id)))
    for (const q of batch.filter((x) => x.status === "open"))
      await answerItem(q.id, drafts.get(q.id)!.choice, drafts.get(q.id)!.text);
}
// Ask back before answering: the session replies in the thread; it never answers for you.
export const askBack = (item: InboxItem, text: string) =>
  updateDoc(doc(db, "inbox", item.id), {
    thread: [...(item.thread ?? []), { who: "owner", kind: "ask", text, at: new Date().toISOString() }],
  });
// The questions of a batch, in the order asked (a single question is a batch of one).
export const batchOf = (item: InboxItem, items: InboxItem[]) =>
  item.batchId ? items.filter((i) => i.batchId === item.batchId).sort((a, b) => (a.batchIndex ?? 0) - (b.batchIndex ?? 0)) : [item];
// Reopen an answer in a plan: the old answer goes to history, and the session gets the new one with the round to
// branch from (live, or by resume).
export const reopenItem = (item: InboxItem, choice: string, text: string) =>
  updateDoc(doc(db, "inbox", item.id), {
    status: "answered", reopened: true, error: null,
    history: [...(item.history ?? []), ...(item.answer ? [item.answer] : [])],
    answer: { choice, text, at: new Date().toISOString() },
  });
// Close or reopen a plan: only the owner, on the page (2026-11-09, choice "Only you"). Closed is a label; nothing on
// the plan stops ("make the close plan is just a status ... no blocking my action").
export const setPlanStatus = (planId: string, status: "open" | "closed") =>
  updateDoc(doc(db, "plans", planId), { status, updatedAt: new Date().toISOString() });
export const isClosed = (p: Pick<Plan, "status">) => p.status !== "open";
export const chooseVersion = (planId: string, n: number) => updateDoc(doc(db, "plans", planId), { chosen: n });
export const useRuns = () => useCollection<Run>("commands", orderBy("createdAt", "desc"), limit(100));

const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 20);

// Commands the bridge on that machine carries out: start claude in a registered folder, or stop a run it started.
export const startRun = (machine: string, folder: string, prompt: string) => {
  const id = newId();
  return setDoc(doc(db, "commands", id), { id, action: "start", machine, folder, prompt, status: "new", createdAt: new Date().toISOString() });
};
// A message to an existing session: the bridge resumes it with the message once it is closed.
export const sendMessage = (machine: string, sessionId: string, cwd: string, prompt: string) => {
  const id = newId();
  return setDoc(doc(db, "commands", id), {
    id, action: "message", machine, sessionId, cwd, prompt, status: "new", createdAt: new Date().toISOString(),
  });
};
// A message or an answer that waits on a session last used in the app or a terminal: cancel it, or send it anyway
// (the bridge resumes the session in a second process; the conversation splits). A running turn always waits.
export const cancelMessage = (id: string) => updateDoc(doc(db, "commands", id), { status: "cancelled", endedAt: new Date().toISOString() });
export const forceMessage = (id: string) => updateDoc(doc(db, "commands", id), { force: true });
// An answer the session did not take live travels as a message command (bridge deliver.py): act on both.
export const cancelAnswer = async (item: InboxItem) => {
  if (item.commandId) await cancelMessage(item.commandId);
  await updateDoc(doc(db, "inbox", item.id), { status: "closed", waitReason: null, cancelledAt: new Date().toISOString() });
};
export const forceAnswer = async (item: InboxItem) => {
  if (item.commandId) await forceMessage(item.commandId);
  await updateDoc(doc(db, "inbox", item.id), { force: true });
};

// "Check now" on a session page: one command, one write back from the bridge. Nothing is written until a tap.
export const checkSession = (machine: string, sessionId: string) => {
  const id = newId();
  return setDoc(doc(db, "commands", id), { id, action: "check", machine, sessionId, status: "new", createdAt: new Date().toISOString() });
};

// The owner's one setting for every run, meta/runs (the owner's choice, 2026-11-02: "do 1 but it is one setting use for
// all kinds not set every run"). Manual: every approval comes to the inbox. Auto: Claude Code's safety check decides
// most, the inbox is the fallback. The bridge reads it when a run goes (bridge runs.py mode()).
export type RunMode = "manual" | "auto";
export function useRunMode(): RunMode | null {
  const [mode, setMode] = useState<RunMode | null>(null);
  useEffect(() => onSnapshot(doc(db, "meta", "runs"), (d) => setMode(d.data()?.permissionMode === "auto" ? "auto" : "manual")), []);
  return mode;
}
export const setRunMode = (mode: RunMode) =>
  setDoc(doc(db, "meta", "runs"), { permissionMode: mode, changedAt: new Date().toISOString() }, { merge: true });

export function usePlanSteps(planId: string | undefined): PlanStep[] | null {
  const [rows, setRows] = useState<PlanStep[] | null>(null);
  useEffect(() => {
    if (!planId) return;
    return onSnapshot(query(collection(db, "planSteps"), where("planId", "==", planId)), (s) =>
      setRows(s.docs.map((d) => d.data() as PlanStep)));
  }, [planId]);
  return rows;
}

// The plan's Generated section (GeneratedView.tsx): the approved files per version folder, written by the bridge.
export type PlanGenerated = { planId: string; versions: Record<string, { file: string; kind: string; at: string }[]> };
export function usePlanGenerated(planId: string | undefined): PlanGenerated | null {
  const [g, setG] = useState<PlanGenerated | null>(null);
  useEffect(() => {
    if (!planId) return;
    return onSnapshot(doc(db, "planGenerated", planId), (s) => setG((s.data() as PlanGenerated) ?? { planId, versions: {} }));
  }, [planId]);
  return g;
}

// The owner's ticks on the harness (harness.ts): one small record per plan, never a plan version.
export function useHarness(planId: string | undefined): HarnessTicks | null {
  const [t, setT] = useState<HarnessTicks | null>(null);
  useEffect(() => {
    if (!planId) return;
    return onSnapshot(doc(db, "planHarness", planId), (s) => setT((s.data() as HarnessTicks) ?? { planId, items: {} }));
  }, [planId]);
  return t;
}
export const tickHarness = (planId: string, h: HarnessItem, ok: boolean, v: number) =>
  setDoc(doc(db, "planHarness", planId),
    { planId, items: { [h.id]: { ok, at: new Date().toISOString(), hash: itemHash(h), v } } }, { merge: true });

// Plan from a session: the bridge reads its real record and a new session writes the plan (bridge planfrom.py).
// goal: the goal box (the owner's words, 2026-11-04: "a text box to input what is the goal for the new plan"); blank = as before.
export const planFromSession = (s: Session, goal = "") => {
  const id = newId();
  return setDoc(doc(db, "commands", id), {
    id, action: "plan", machine: s.machine, sourceSessionId: s.id, cwd: s.cwd, prompt: `Plan from session: ${s.title}`,
    ...(goal.trim() ? { goal: goal.trim() } : {}),
    status: "new", createdAt: new Date().toISOString(),
  });
};
// A message on a plan, with its kind; the owner's text is the prompt, the kind goes as a system prompt.
// on: the step or part the message was asked on (quote.ts); its reply shows there (the owner's pick, 2026-11-09: "Both").
export const sendPlanMessage = (plan: Plan, kind: PlanKind, text: string, on?: { stepId?: string; part?: string }) => {
  const id = newId();
  return setDoc(doc(db, "commands", id), {
    id, action: "message", machine: plan.machine, sessionId: plan.sessionId, cwd: plan.cwd, prompt: text, ownerText: text,
    kind, planId: plan.id, status: "new", createdAt: new Date().toISOString(),
    ...(on?.stepId ? { stepId: on.stepId } : {}), ...(on?.part ? { part: on.part } : {}),
  });
};

// Run step (the owner's words, 2026-11-03: "Add Ren step button"): a plain message to the plan's session.
export const runStep = (plan: Plan, step: Parts["steps"][number], harness = "") => {
  const id = newId();
  const text = `Work on step ${step.id}: ${step.title}. Report it with step_update.${harness}`;
  return setDoc(doc(db, "commands", id), {
    id, action: "message", machine: plan.machine, sessionId: plan.sessionId, cwd: plan.cwd, prompt: text, ownerText: text,
    planId: plan.id, stepId: step.id, status: "new", createdAt: new Date().toISOString(),
  });
};

// The owner's order to move the plan's phase (phases.ts): a plain message; the session records a plain version.
export const sendPhaseOrder = (plan: Plan, text: string, order: string) => {
  const id = newId();
  return setDoc(doc(db, "commands", id), {
    id, action: "message", machine: plan.machine, sessionId: plan.sessionId, cwd: plan.cwd, prompt: text, ownerText: order,
    planId: plan.id, phaseOrder: true, status: "new", createdAt: new Date().toISOString(),
  });
};

// The owner's Generate order (planCheck.ts): a plain message to the plan's session, with the kinds asked.
export const sendGenerate = (plan: Plan, kinds: string[], note: string, text: string) => {
  const id = newId();
  const order = `Generate: ${kinds.join(", ")}${note.trim() ? `. Note: ${note.trim()}` : ""}`;
  return setDoc(doc(db, "commands", id), {
    id, action: "message", machine: plan.machine, sessionId: plan.sessionId, cwd: plan.cwd, prompt: text, ownerText: order,
    planId: plan.id, generate: { kinds, note: note.trim() }, status: "new", createdAt: new Date().toISOString(),
  });
};

// The owner's approval of a Generate result (planCheck.ts approvals): the bridge moves the ticked files out of tmp/,
// removes tmp/ and deletes the "Generated" results that pointed into it.
export const sendApproveGenerated = (plan: Plan, a: { folder: string; keep: string[]; drop: string[] }) => {
  const id = newId();
  return setDoc(doc(db, "commands", id), {
    id, action: "approve_generated", machine: plan.machine, cwd: plan.cwd, planId: plan.id, ...a,
    status: "new", createdAt: new Date().toISOString(),
  });
};

// The plan's Resume (planCheck.ts): makes what is missing, or resumes the plan, as a plain message to its session.
export const sendPlanCheck = (plan: Plan, text: string) => {
  const id = newId();
  return setDoc(doc(db, "commands", id), {
    id, action: "message", machine: plan.machine, sessionId: plan.sessionId, cwd: plan.cwd, prompt: text, ownerText: text,
    planId: plan.id, planCheck: true, status: "new", createdAt: new Date().toISOString(),
  });
};

// A run paused by the usage limit (the owner's words, 2026-11-09: "I need the continue button inside run tab and session
// tab to do the leftover work manually"; note "auto only the last or the message I choose to auto restart when limit
// lifted"): Continue now, or pick it to continue by itself at the reset.
export const continueRun = (machine: string, target: string) => {
  const id = newId();
  return setDoc(doc(db, "commands", id), { id, action: "continue", machine, target, status: "new", createdAt: new Date().toISOString() });
};
export const setAutoContinue = (machine: string, target: string, on: boolean) => {
  const id = newId();
  return setDoc(doc(db, "commands", id), { id, action: "auto_continue", machine, target, on, status: "new", createdAt: new Date().toISOString() });
};

export const stopRun = (machine: string, target: string) => {
  const id = newId();
  return setDoc(doc(db, "commands", id), { id, action: "stop", machine, target, status: "new", createdAt: new Date().toISOString() });
};
