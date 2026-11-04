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
  options: { label: string; detail: string; example?: Example }[];
  recommended: number | null;
  files: string[];
  status: "open" | "answered" | "delivering" | "delivered" | "closed";
  createdAt: string;
  answer: { choice: string; text: string; at: string } | null;
  deliveredAt?: string;
  deliveredVia?: "live" | "resume";
  waitReason?: "turn" | "app" | null; // why an answer has not reached the session yet (bridge runs.py)
  commandId?: string; // the message run that carries the answer to the session
  force?: boolean;
  followUp?: string;
  error?: string | null;
  via?: "hook"; // posted by the question hook from Claude Code's own question box
  multi?: boolean; // more than one option may be picked
  planId?: string; // the plan this question belongs to
  round?: number; // asked on this version of the plan (0: before v1)
  reopened?: boolean; // the owner changed an earlier answer: the session branches the plan
  history?: { choice: string; text: string; at: string }[]; // earlier answers, oldest first
  stepId?: string; // asked while this step of the plan was running
  switch?: { to: PlanKind; commandId: string }; // a Q&A message asks to change the plan (bridge inbox.py ask_switch)
};

// Every option of a plan question carries one (the owner's words, 2026-11-03: "every choose will have an example").
export type Bench = { name: string; before: string; after: string; measured: boolean; source?: string };
export type Example =
  | { type: "image"; before: string; after: string; note?: string }
  | { type: "code"; diff: string; bench: Bench[]; note?: string }
  | { type: "text"; draft: string; note?: string };

// A plan with rounds of questions (the owner's choice, 2026-11-01, "do 2"): versions in planVersions, questions in the
// inbox with planId and round.
export type Plan = {
  id: string; title: string; sessionId: string; machine: string; cwd: string; workType: string;
  status: "open" | "done"; current: number; createdAt: string; updatedAt: string; closeNote?: string;
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
  status: "new" | "waiting" | "running" | "stopping" | "done" | "stopped" | "failed" | "lost" | "cancelled";
  action: "start" | "stop" | "message" | "check" | "plan" | "approve_generated";
  moved?: { from: string; to: string }[]; // approve_generated: the approved files, where they went
  kind?: PlanKind; // a message on a plan
  planId?: string;
  sourceSessionId?: string; // plan from a session: the session it reads
  stage?: string; // plan from a session: where the reading is
  ownerText?: string;
  stepId?: string; // a Run step message
  planCheck?: boolean; // sent by the plan's Check button (planCheck.ts)
  generate?: { kinds: Kind[]; note?: string }; // the owner's Generate order (planCheck.ts)
  phaseOrder?: boolean; // the owner's order to move the plan's phase (phases.ts)
  quotes?: { checked: number; marked: number }; // plan from a session: quotes in the notes not found on their page
  waitReason?: "turn" | "app";
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
export const useUsage = () => useCollection<Usage>("usage", orderBy("day", "desc"), limit(30));
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
// Reopen an answer in a plan: the old answer goes to history, and the session gets the new one with the round to
// branch from (live, or by resume).
export const reopenItem = (item: InboxItem, choice: string, text: string) =>
  updateDoc(doc(db, "inbox", item.id), {
    status: "answered", reopened: true, error: null,
    history: [...(item.history ?? []), ...(item.answer ? [item.answer] : [])],
    answer: { choice, text, at: new Date().toISOString() },
  });
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
export const sendPlanMessage = (plan: Plan, kind: PlanKind, text: string) => {
  const id = newId();
  return setDoc(doc(db, "commands", id), {
    id, action: "message", machine: plan.machine, sessionId: plan.sessionId, cwd: plan.cwd, prompt: text, ownerText: text,
    kind, planId: plan.id, status: "new", createdAt: new Date().toISOString(),
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

export const stopRun = (machine: string, target: string) => {
  const id = newId();
  return setDoc(doc(db, "commands", id), { id, action: "stop", machine, target, status: "new", createdAt: new Date().toISOString() });
};
