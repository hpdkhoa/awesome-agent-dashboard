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
  options: { label: string; detail: string }[];
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
};

// A plan with rounds of questions (the owner's choice, 2026-11-01, "do 2"): versions in planVersions, questions in the
// inbox with planId and round.
export type Plan = {
  id: string; title: string; sessionId: string; machine: string; cwd: string; workType: string;
  status: "open" | "done"; current: number; createdAt: string; updatedAt: string; closeNote?: string;
  chosen?: number; // the version on the chosen line (default: the newest)
};
// madeBy: the answers that made this version, as they were then; parent: the version it grew from (a branch when older).
export type Decision = { id: string; title: string; choice: string; text: string };
export type PlanVersion = {
  id: string; planId: string; n: number; text: string; note: string; createdAt: string; parent?: number; madeBy?: Decision[];
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
  action: "start" | "stop" | "message" | "check";
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

export const stopRun = (machine: string, target: string) => {
  const id = newId();
  return setDoc(doc(db, "commands", id), { id, action: "stop", machine, target, status: "new", createdAt: new Date().toISOString() });
};
