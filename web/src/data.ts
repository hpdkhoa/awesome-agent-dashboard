import type { Phase } from "./phases";
import { checkHash, itemHash, type HarnessItem, type HarnessTicks } from "./harness";
import type { Base, Format, Kind } from "./planCheck";
import { useEffect, useRef, useState } from "react";
import { collection, doc, getDocs, limit, onSnapshot, orderBy, query, setDoc, startAfter, updateDoc, where, type QueryConstraint, type QueryDocumentSnapshot } from "./fs";
import { db } from "./firebase";
import { countReads, useActive } from "./pageReads";
export { pageReads, countReads } from "./pageReads";

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
  // F7, question routing (plan bf73af63; the owner, 2026-11-19: "Plan session answers"): every inbox item is the
  // owner's; topic: a question's owner topic (scope, policy, approval, spend), "hook" for the question box, else the
  // item's kind. Items from before F7 have none. Coordinator questions live in coordinator/, never here.
  route?: "owner";
  topic?: string;
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
  waitReason?: "turn" | "app" | "upgrade" | "resources" | "round" | null; // why an answer has not reached the session yet (bridge runs.py)
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
  // the decision's pictures copied into the plan folder at the answer (bridge snapshot.py): option label -> copies;
  // changed: source files written after the answer; missing: source files not found
  snapshot?: { at: string; takenAt: string; files: Record<string, { before?: string; after?: string }>; changed: string[]; missing: string[];
    pointed?: { to: string; at: string; by: string } }; // the owner pointed the decision to another file
  // one batch: questions asked together show as one entry and are answered together (2026-11-07)
  batchId?: string; batchIndex?: number; batchSize?: number;
  draft?: { choice: string; text: string; at: string }; // your latest saved answer, used when the batch is sent
  // the session changed this one question in place after an ask back (bridge inbox.py redraw, 2026-11-13); old forms kept
  redrawn?: string; revisions?: { text: string; options: unknown[]; recommended: number | null; at: string }[];
  thread?: ThreadEntry[]; // your saved answers, your questions back and the session's replies, in order
  switch?: { to: PlanKind; commandId: string }; // a Q&A message asks to change the plan (bridge inbox.py ask_switch)
  // F12 (bridge inbox.py result / withdraw): one result per plan step, later ones edit it (earlier ones kept here, oldest
  // first); a session withdrew its moot question, with the reason
  version?: number; editedAt?: string;
  versions?: { n: number; title: string; text: string; files: string[]; status: string; at: string;
    answer: { choice: string; text: string; at: string } | null }[];
  withdrawn?: { at: string; reason: string; by: string };
};

// Every option of a plan question carries one (the owner's words, 2026-11-03: "every choose will have an example").
export type Bench = { name: string; before: string; after: string; measured: boolean; source?: string };
// a session reply made after 2026-11-08 keeps only chars: its words are read from the session log on the PC (PcText)
export type ThreadEntry = { who: "owner" | "session"; kind: "answer" | "ask" | "reply" | "redraw"; choice?: string; text?: string; chars?: number; at: string };
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
  reviseDue?: Record<string, { round: number; stepV: number; at: string }>; // B: steps whose revise is not posted yet
};
// The six parts, in the owner's order (2026-11-03): goal, summary, rules, lessons and how each was applied, leftover, steps.
export type Parts = {
  goal: string; summary: string;
  rules: { rule: string; source: string }[];
  lessons: { lesson: string; taughtBy: string; appliedIn: string }[];
  leftover: string[];
  // new: work the record does not hold. v, vSince (A, the owner 2026-11-25: "each step has a version and when any work
  // not change the step then the version is kept"): the bridge counts the changes of the step's text; vSince is the plan
  // version where this text began. None on versions made before A: v1.
  steps: { id: string; title: string; does: string; check: string; new?: boolean; v?: number; vSince?: number }[];
  cite?: string; // the owner's words the plan reads, in log order (2026-11-05); part 1 says what the plan is for
  board?: Board; // the plan's main look (bridge inbox.py clean_board; the owner's pick, 2026-11-16, "Product board, new fields")
};
// materials (the owner's words, 2026-11-17: "Add material section in report board, in this section only keep the latest
// version of each file/material and stories"; pick: the session writes the list; the bridge keeps the newest vN).
export type Material = { name: string; kind: "story" | "material" | "file"; path?: string; note?: string };
// src (plan 44fc4979 s3, the owner's pick "Source field per line"): the source ids of What for and of each Idea line
export type Board = { whatFor: string; idea: string[]; product: { feature: string; steps: string[] }[]; materials?: Material[];
  src?: { whatFor?: string[]; idea?: string[][] };
  // s7 (plan 44fc4979), the owner's pick "By meaning" (rule B2): Idea over 4 lines in named sub-groups, in order
  ideaGroups?: { head: string; count: number }[];
  // s8 (plan 44fc4979), the owner's pick "A: step cards For / How / Result": per step what it is for and how it works,
  // written by the session with sources; the Result is read from the step's newest report on the page
  stepCards?: { step: string; for: string; how: string; done?: string; missed?: string; src?: string[] }[];
  // s8 glossary (the owner's pick "C: Both (section + hover)"): every term the plan uses or makes, in its meaning here
  glossary?: { group?: string; term: string; means: string }[] };
// The message kinds on a plan: four change it (a new plan version), Q&A never does; Action does the work asked and makes
// no version (step i11, the owner's words, 2026-11-16: "need action type to cover this case when I ask you to perform an action").
export type PlanKind = "qa" | "goal" | "step" | "rule" | "lesson" | "action";
export const PLAN_KINDS: [PlanKind, string][] = [
  ["qa", "Q&A"], ["goal", "Shift goal"], ["step", "Add step"], ["rule", "Change rule"], ["lesson", "Audit lesson"], ["action", "Action"],
];
// A step version: each report on a step, its state and the session's reply (no plan version).
export type PlanStep = {
  id: string; planId: string; stepId: string; state: "next" | "now" | "checking" | "done" | "failed"; updatedAt: string;
  versions: { n: number; state: string; reply: string; at: string; planVersion: number; report?: StepReport;
    by?: string; receiptBy?: "check" | "pictures" | "owner"; receipt?: Receipt; stepV?: number }[]; // stepV: the step's v this round ran on
};
// F4, done needs a receipt (bridge stepcheck.py settle; the owner's picks 2026-11-13 "Check or checked pictures",
// 2026-11-19 "Done waits for its receipt"): what made a step done.
export type Receipt = { kind: "check" | "pictures" | "owner"; commit: string; at: string; runId: string;
  exit?: number; seconds?: number; command?: string; output?: string;
  overall?: string; set?: string; pictures?: string[]; marks?: { path: string; verdict: string; why: string }[]; note?: string;
  findings?: EvidenceFinding[] };
// The run report's fields (bridge inbox.py clean_report; the owner's pick, 2026-11-15: "A + exact report fields").
export type StepReport = {
  built?: string[];
  numbers?: { metric: string; before: string; after: string; how: string }[];
  tests?: { method: string; result: string }[];
  not_done?: { item: string; fix: string }[];
};
// madeBy: the answers that made this version, as they were then; parent: the version it grew from (a branch when older).
export type Decision = { id: string; title: string; choice: string; text: string };
export type PlanVersion = {
  id: string; planId: string; n: number; text: string; note: string; createdAt: string; parent?: number; madeBy?: Decision[];
  parts?: Parts; change?: { kind: PlanKind | "board"; message: string };
  phase?: Phase; phaseMove?: { from: Phase; to: Phase; order: string }; // phases.ts
  harness?: HarnessItem[]; // harness.ts: the list as it is in this version
  boardCheck?: BoardCheck; // s5: the auto rule check B1 to B10 the bridge ran on this version (boardrules.py)
  revise?: { after: string; round: number; stepV: number; why: string; result: string; changed: { id: string; from: number | null; to: number }[] };
};
// B, the revise after each step's result (the owner, 2026-11-25: "any work will change the plan and show it out, so the
// step in future will have the flexible the adjust due to previous step result"): one record per step round
// (planRevises/<plan>_<step>_r<round>, bridge inbox.py plan_revise); change "none" keeps every step's version.
export type PlanRevise = { id: string; planId: string; after: string; round: number; stepV: number; why: string; result: string;
  at: string; change: "none" | "steps"; planVersion: number; changed: { id: string; from: number | null; to: number }[] };
export function usePlanRevises(planId: string | undefined): PlanRevise[] {
  const [r, setR] = useState<PlanRevise[]>([]);
  const active = useActive();
  useEffect(() => {
    if (!planId || !active) return;
    return onSnapshot(query(collection(db, "planRevises"), where("planId", "==", planId)), (s) =>
      (countReads(s.docChanges().length, "planRevises"), setR(s.docs.map((d) => d.data() as PlanRevise).sort((a, b) => a.at.localeCompare(b.at)))));
  }, [planId, active]);
  return r;
}
// s5 (plan 44fc4979): the owner's picks "Check all 10, B2/B4/B7 'waits s7'", "Save + red flag"
export type BoardRule = { id: string; name: string; kb: string; state: "pass" | "fail" | "waits for s7"; n: number; lines: string[]; note: string };
export type BoardCheck = { at: string; rules: BoardRule[]; pass: number; fail: number; wait: number };

// s7 (plan 44fc4979), rule B7 "Changes are marked", the owner's pick "Bridge, all devices": the board lines the owner
// saw at the last look, one record per plan (boardSeen/<plan id>), so phone and PC share it. A line is a key
// "part|text|state"; a line whose key the last look did not hold carries "changed".
export type BoardSeen = { id: string; planId: string; lines: string[]; version: number; at: string };
export function useBoardSeen(planId: string): { loaded: boolean; prev: BoardSeen | null } {
  const [got, setGot] = useState<{ id: string; prev: BoardSeen | null } | null>(null);
  useEffect(() => {
    let live = true;
    getDocs(query(collection(db, "boardSeen"), where("planId", "==", planId))).then((s) => {
      countReads(s.docs.length, "boardSeen");
      if (live) setGot({ id: planId, prev: (s.docs[0]?.data() as BoardSeen) ?? null });
    }, () => live && setGot({ id: planId, prev: null }));
    return () => { live = false; };
  }, [planId]);
  return got?.id === planId ? { loaded: true, prev: got.prev } : { loaded: false, prev: null };
}
export const saveBoardSeen = (planId: string, version: number, lines: string[]) =>
  setDoc(doc(db, "boardSeen", planId), { id: planId, planId, lines, version, at: new Date().toISOString() });

export type Machine = {
  name: string;
  windowDays: number;
  sessions: number;
  syncedAt: string;
  folders?: { workType: string; path: string }[];
  // what the machine's bridge publishes (status.py publish_state); localModels: its Ollama models (plan 1c08f4c2 s3);
  // a model's score comes from the gate task set (s6) when it has one
  avatar?: { localModels?: { server: string; error: string | null; models: LocalModel[] } };
};
export type LocalModel = { name: string; sizeBytes?: number; params?: string; quant?: string; score?: { pass: number; runs: number; tokensPerSec?: number; at?: string } };

export type Run = {
  id: string;
  machine: string;
  folder?: string;
  prompt?: string;
  target?: string;
  cwd?: string;
  status: "new" | "waiting" | "running" | "stopping" | "done" | "stopped" | "failed" | "lost" | "cancelled" | "paused";
  action: "start" | "stop" | "message" | "check" | "plan" | "approve_generated" | "continue" | "auto_continue" | "add_root" | "search" | "local" | "phase";
  // plan 1c08f4c2 s3/s4 local run (bridge localrun.py): this machine's Ollama; tokens, never dollars (s5: "$0")
  files?: string[]; promptTokens?: number | null; outputTokens?: number | null; tokensPerSec?: number | null; loadMs?: number | null;
  numCtx?: number | null; stoppedOnRepeat?: boolean; context?: { name: string; chars: number; sent: number; chunks: string | null }[];
  // s9 search (bridge search.py): Gemini Flash + Google Search; the time to the first streamed text, the source links
  engine?: string; firstTokenMs?: number | null; totalMs?: number | null; sources?: { title: string; url: string }[];
  pausedUntilAt?: string | null; // a run paused by the usage limit: the reset time the bridge read from claude's message
  autoContinue?: boolean; // continues by itself at the reset (bridge runs.py _pause, _auto_continue)
  autoBy?: "last" | "owner" | null; // the run that paused last, or the owner's pick
  continuedBy?: string; // the run that does this one's leftover work
  continueOf?: string; // the paused run this one continues
  moved?: { from: string; to: string }[]; // approve_generated: the approved files, where they went
  kind?: PlanKind; // a message on a plan
  planId?: string;
  inboxId?: string; // an answer delivered as a message (bridge deliver.py)
  answerStep?: string; // that answer's question was on this step (2026-11-15: "v7 data + code fix")
  sourceSessionId?: string; // plan from a session: the session it reads
  stage?: string; // plan from a session: where the reading is
  pausedUntil?: string | null; // plan from a session stopped by the usage limit: when it resets
  reused?: number; // plan from a session: pages whose notes came from an earlier run
  ownerText?: string;
  stepId?: string; // a Run step message, or a message asked on one step (Ask, Change, Quote on the step)
  part?: string; // a message asked on one part of the plan (Ask or Quote on its header, or selected words in it)
  planCheck?: boolean; // sent by the plan's Check button (planCheck.ts)
  generate?: { kinds: Kind[]; formats?: Format[]; base?: Base; note?: string }; // the owner's Generate order (planCheck.ts)
  phaseOrder?: boolean; // the owner's order to move the plan's phase (phases.ts)
  quotes?: { checked: number; marked: number }; // plan from a session: quotes in the notes not found on their page
  waitReason?: "turn" | "app" | "upgrade" | "resources" | "round";
  // F10: the readings under their limits when the run waits (bridge runs.py _resources_wait), each with its number
  resources?: { low?: string[]; at?: string; startedAfter?: string; error?: string };
  upgradeId?: string; upgradedFrom?: string; // a message on an older plan waits while the plan moves to the latest format
  // the archiver (bridge archiver.py, 2026-11-06): asked, archived, unarchiving, done, refused, unarchive failed
  archive?: string; archiveNote?: string | null;
  force?: boolean;
  permissionMode?: RunMode; // the setting the bridge read when this run went
  model?: string; effort?: string; // what the run went with: its own choice, else the setting in meta/runs (RunWith)
  noSession?: boolean; // a one-off start: its session is never saved, so no messages can follow
  freshFrom?: string; contextTokens?: number; // the message went to a fresh session with a handoff from this one (handoff.py)
  // KB first (plan bf73af63 F1, bridge records.py gate_for_run): the records the run was given and the ones its report cited
  kb?: { given: string[]; cited?: string[]; how?: string; error?: string };
  // F2: the session's headline (inbox tool headline): now, next; done/total and pct, eta for heavy work; at = when set
  headline?: { now: string; next?: string; done?: number; total?: number; pct?: number; eta?: string; at: string };
  // F11 run end guard (bridge endguard.py): the last reply's promise lines ("I will ..."), or a Run step with no step
  // report this run (the owner's pick 2026-11-19 "No report this run")
  endGuard?: { promise?: string[]; openStep?: string; error?: string; at: string };
  rulesAt?: Record<string, number>; rulesChanged?: string[]; // F3: each rule record's version this run ran under
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

// Every listener counts the documents it receives by name (pageReads.ts sends them to the bridge's counter) and runs
// only while the tab is active (the owner's words, 2026-11-12: "Page listeners only while their tab is open").
function useCollection<T>(key: string, ...constraints: QueryConstraint[]): T[] | null {
  const [rows, setRows] = useState<T[] | null>(null);
  const active = useActive();
  const name = key.split("@")[0]; // "usage@14": the collection, then a tag that makes the query re-open when it changes
  useEffect(() => {
    if (!active) return;
    return onSnapshot(query(collection(db, name), ...constraints), (s) => (countReads(s.docChanges().length, name), setRows(s.docs.map((d) => d.data() as T))));
  }, [key, active]);
  return rows;
}

// Sessions active in the last 5 days only, unless the owner asks for older ones: older threads cost no reads until then
// (the owner's words, 2026-11-01: "the thread with no active message more than 5 days need a collapse or hide state so
// no read consume in there").
export const RECENT_DAYS = 1; // the owner's words, 2026-11-13: "session is 1 day display and the rest is hidden inside show more"
export const PAGE = 10; // the first display and every Show more: 10 documents at most

// Every list shows the newest first (the owner's words, 2026-11-14: "I want ordering from latest to older from every
// where listing session or messages"). By time, not by text, so "...Z" and "...+00:00" dates compare right.
const timeOf = (v: unknown) => (typeof v === "string" ? Date.parse(v) || 0 : typeof v === "number" ? v : 0);
export const newestFirst = <T extends { id: string }>(rows: T[], field: keyof T & string): T[] =>
  [...rows].sort((a, b) => timeOf(b[field]) - timeOf(a[field]) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
const rowSnap = (name: string, row: { id: string }): QueryDocumentSnapshot =>
  ({ id: row.id, data: () => row as unknown as Record<string, unknown>, exists: () => true, ref: doc(null, name, row.id) });

// Older rows behind Show more: one-shot reads, PAGE at a time, never a listener (the owner's words, 2026-11-13).
export type Pager<T> = { rows: T[]; more: () => void; loading: boolean; done: boolean; pages: number };
// seed: the rows the live list shows now, when it has the same order (sessions by lastAt, plans by updatedAt). The first
// Show more keeps them and reads after the last one, so it never repeats the newest rows and a row that later drops out
// of the live list stays shown (the owner's pick, 2026-11-14: "All lists newest first").
export function usePager<T extends { id: string }>(name: string, orderField: string, seed?: T[] | null, on = true, ...constraints: QueryConstraint[]): Pager<T> {
  const seedNow = useRef(seed);
  seedNow.current = seed;
  const [rows, setRows] = useState<T[]>([]);
  const [last, setLast] = useState<QueryDocumentSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [pages, setPages] = useState(0);
  const more = () => {
    if (loading || done || !on) return;
    setLoading(true);
    const seeded = !last && pages === 0 ? newestFirst(seedNow.current ?? [], orderField as keyof T & string) : [];
    const from = last ?? (seeded.length ? rowSnap(name, seeded[seeded.length - 1]) : null);
    const q = query(collection(db, name), ...constraints, orderBy(orderField, "desc"), ...(from ? [startAfter(from)] : []), limit(PAGE));
    getDocs(q).then((s) => {
      countReads(s.docs.length, `${name} (older)`);
      setRows((r) => [...r, ...seeded, ...s.docs.map((d) => d.data() as T)]);
      setLast(s.docs[s.docs.length - 1] ?? from);
      setDone(s.docs.length < PAGE);
      setPages((p) => p + 1);
      setLoading(false);
    }, () => setLoading(false));
  };
  return { rows, more, loading, done, pages };
}
export function useSessions(older: boolean): Session[] | null {
  const [rows, setRows] = useState<Session[] | null>(null);
  const active = useActive();
  useEffect(() => {
    if (!active) return;
    const since = new Date(Date.now() - RECENT_DAYS * 86400000).toISOString();
    const q = older
      ? query(collection(db, "sessions"), orderBy("lastAt", "desc"), limit(PAGE))
      : query(collection(db, "sessions"), where("lastAt", ">=", since), orderBy("lastAt", "desc"), limit(PAGE));
    return onSnapshot(q, (s) => (countReads(s.docChanges().length, "sessions"), setRows(s.docs.map((d) => d.data() as Session))));
  }, [older, active]);
  return rows;
}
// every synced day, oldest to newest on the chart (the owner's words, 2026-11-08: "all spend type with full history")
// days: 1 = today only (one read), N = the last N days, 0 = every synced day (the owner's words, 2026-11-13:
// "spend default is today"; 2026-11-08: "all spend type with full history" stays as the "all" choice)
export const useUsage = (days = 1) => {
  const since = days > 0 ? new Date(Date.now() - (days - 1) * 86400000).toLocaleDateString("en-CA") : "";
  return useCollection<Usage>(`usage@${days}`, ...(since ? [where("day", ">=", since)] : []), orderBy("day", "desc"));
};
export const useWorkTypes = () => useCollection<WorkType>("workTypes");
export const useMachines = () => useCollection<Machine>("machines");
export const usePlans = () => useCollection<Plan>("plans", orderBy("updatedAt", "desc"), limit(PAGE));
// the plan page's own questions and runs, scoped to that plan (bounded by the plan, read only while it is open)
export const usePlanInbox = (planId: string | undefined) => useScoped<InboxItem>("inbox", "planId", planId);
export const usePlanRuns = (planId: string | undefined) => useScoped<Run>("commands", "planId", planId);
function useScoped<T>(name: string, field: string, value: string | undefined): T[] {
  const [rows, setRows] = useState<T[]>([]);
  const active = useActive();
  useEffect(() => {
    if (!value) return setRows([]);
    if (!active) return;
    return onSnapshot(query(collection(db, name), where(field, "==", value)), (s) => (countReads(s.docChanges().length, `${name} (plan)`), setRows(s.docs.map((d) => d.data() as T))));
  }, [name, field, value, active]);
  return rows;
}

// One plan's versions, read only while its page is open. Sorted here, so the query needs no composite index.
export function usePlanVersions(planId: string | undefined): PlanVersion[] | null {
  const [rows, setRows] = useState<PlanVersion[] | null>(null);
  const active = useActive();
  useEffect(() => {
    if (!planId) return setRows(null);
    if (!active) return;
    return onSnapshot(query(collection(db, "planVersions"), where("planId", "==", planId)), (s) =>
      (countReads(s.docChanges().length, "planVersions"), setRows(s.docs.map((d) => d.data() as PlanVersion).sort((a, b) => a.n - b.n))),
    );
  }, [planId, active]);
  return rows;
}
// only the items still open, answered or being delivered; the rest behind Show more (usePager)
export const INBOX_LIVE = ["open", "answered", "delivering"];
export const useInbox = () => useCollection<InboxItem>("inbox", where("status", "in", INBOX_LIVE), orderBy("createdAt", "desc"), limit(PAGE));

// The owner's answer. The session picks it up live, or the bridge resumes the session if it has closed.
export const answerItem = (id: string, choice: string, text: string) =>
  updateDoc(doc(db, "inbox", id), { status: "answered", answer: { choice, text, at: new Date().toISOString() }, error: null });
// A batch (the owner's words, 2026-11-07: "I want to see the stored answers that I answered and can change them before
// the last question is answered and the choices will only use my latest choice without drift and I can review them
// back as the thread in inbox"). Saving keeps your latest answer as the draft and adds it to the thread; when every
// question of the batch has a draft, all are sent at once, each with its latest draft.
// send = false (the phone, step i7, the owner's pick "Send at the end"): the answer is saved and the batch waits for
// sendBatch, so a wrong last tap never sends.
export async function saveDraft(item: InboxItem, batch: InboxItem[], choice: string, text: string, send = true) {
  const at = new Date().toISOString();
  const draft = { choice, text, at };
  await updateDoc(doc(db, "inbox", item.id), {
    draft, thread: [...(item.thread ?? []), { who: "owner", kind: "answer", choice, text, at }],
  });
  if (!send) return;
  const drafts = new Map(batch.map((q) => [q.id, q.id === item.id ? draft : q.draft]));
  if (batch.every((q) => q.status !== "open" || drafts.get(q.id)))
    for (const q of batch.filter((x) => x.status === "open"))
      await answerItem(q.id, drafts.get(q.id)!.choice, drafts.get(q.id)!.text);
}
// The phone's Send: every open question of the batch goes with its latest saved answer; refused while one has none.
export async function sendBatch(batch: InboxItem[]) {
  const open = batch.filter((q) => q.status === "open");
  if (open.some((q) => !q.draft)) throw new Error("Save an answer for every question first.");
  for (const q of open) await answerItem(q.id, q.draft!.choice, q.draft!.text);
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
// only the runs going now; the rest behind Show more (usePager)
export const RUN_LIVE = ["new", "waiting", "running", "stopping", "paused"];
// newest first, so the 10 kept are the newest (before: no order, the oldest 10 came back)
export const useRuns = () => useCollection<Run>("commands", where("status", "in", RUN_LIVE), orderBy("createdAt", "desc"), limit(PAGE));
// F9 detached long jobs (bridge jobs.py): started by a session with job_start, they run outside it; the bridge keeps
// jobs/<id> from each job's folder (progress.json beat, done.json marker). Newest first.
export type Job = {
  id: string; name: string; command: string; cwd: string; startedAt: string; expectMinutes?: number;
  state: "starting" | "running" | "done" | "failed" | "lost"; beatAt?: string; seenAt?: string; endedAt?: string;
  exit?: number | null; seconds?: number; lines?: number; lastLine?: string;
  report?: { done?: number; total?: number; pct?: number; note?: string } | null;
  out?: string; progress?: string; doneMarker?: string; sessionId?: string; runId?: string | null;
  planId?: string | null; stepId?: string | null; machine?: string; runnerPid?: number;
};
export const useJobs = () => useCollection<Job>("jobs", orderBy("startedAt", "desc"), limit(PAGE));

const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 20);

// Commands the bridge on that machine carries out: start claude in a registered folder, or stop a run it started.
// keep=false: a one-off job, its session never saved (the owner's words, 2026-11-10: "A "don't keep the session" tick").
export const startRun = (machine: string, folder: string, prompt: string, w?: RunWith, keep = true) => {
  const id = newId();
  return setDoc(doc(db, "commands", id), {
    id, action: "start", machine, folder, prompt, status: "new", createdAt: new Date().toISOString(), ...withRun(w), ...(keep ? {} : { noSession: true }),
  });
};
// s9 (plan c5cb9485; the owner's words, 2026-11-14: "Search box go to both send box and dashboard and count as a run"):
// a question to Gemini Flash with Google Search, run by that machine's bridge with the key in its .env; a run like the
// others. Returns the run's id so the box can show it.
export const searchRun = async (machine: string, prompt: string) => {
  const id = newId();
  await setDoc(doc(db, "commands", id), { id, action: "search", machine, prompt, status: "new", createdAt: new Date().toISOString() });
  return id;
};
// plan 1c08f4c2 s5 (step: "Runs tab picker (Claude or machine / local model with its score); file picker"): a prompt to
// a local model on that machine's Ollama, with the picked files as context (bridge localrun.py; files only from its
// WORK_ROOTS). Not Claude Code. Returns the run's id.
export const localRun = async (machine: string, model: string, prompt: string, files: string[]) => {
  const id = newId();
  await setDoc(doc(db, "commands", id), { id, action: "local", machine, model, prompt, files, status: "new", createdAt: new Date().toISOString() });
  return id;
};
// A work folder added on the page (step i4, the owner's choice, 2026-11-12: "Bridge checks"): the bridge on that
// machine checks it (exists; not a drive root, the user folder, AppData or .ssh), then adds it with no restart.
// onEnd gets the bridge's answer: done, or failed with why.
export const addRoot = (machine: string, name: string, folder: string, onEnd: (ok: boolean, why: string) => void) => {
  const id = newId();
  const ref = doc(db, "commands", id);
  return setDoc(ref, { id, action: "add_root", machine, name, folder, status: "new", createdAt: new Date().toISOString() }).then(() => {
    const stop = onSnapshot(ref, (s) => {
      const c = s.data() as { status?: string; error?: string; folder?: string } | undefined;
      if (c?.status === "done" || c?.status === "failed") {
        stop();
        onEnd(c.status === "done", c.status === "done" ? c.folder ?? folder : c.error ?? "refused");
      }
    });
  });
};
// A message to an existing session: the bridge resumes it with the message once it is closed.
export const sendMessage = (machine: string, sessionId: string, cwd: string, prompt: string, w?: RunWith) => {
  const id = newId();
  return setDoc(doc(db, "commands", id), {
    id, action: "message", machine, sessionId, cwd, prompt, status: "new", createdAt: new Date().toISOString(), ...withRun(w),
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
// Model and effort for a run (the owner's words, 2026-11-10: "select model and effort"; the pick: "Setting plus a
// choice on each message"): "" means the setting on the Runs tab, which itself may be "" for the CLI's own default.
export type Fresh = "auto" | "always" | "never";
export type RunWith = { model?: string; effort?: string; fresh?: Fresh }; // fresh: a fresh session with a handoff (handoff.py)
export const FRESH_OVER: [number, string][] = [[0, "off"], [100000, "100k tokens"], [200000, "200k tokens"], [300000, "300k tokens"], [500000, "500k tokens"], [800000, "800k tokens"]];
// Exact models and efforts, no "default" (the owner's words, 2026-11-10: "I don't want default option I want exact
// option"; picks claude-opus-5-5 and medium). The bridge uses the same list and the same picks (runs.py run_with).
export const MODELS: [string, string][] = [["claude-fable-5-1", "claude-fable-5-1"], ["claude-opus-5-5", "claude-opus-5-5"],
  ["claude-sonnet-5-5", "claude-sonnet-5-5"], ["claude-haiku-5-5", "claude-haiku-5-5"]];
export const EFFORTS: [string, string][] = [["low", "low"], ["medium", "medium"], ["high", "high"], ["xhigh", "xhigh"], ["max", "max"]];
export const DEFAULT_MODEL = "claude-opus-5-5";
export const DEFAULT_EFFORT = "medium";
const ALIAS: Record<string, string> = { fable: "claude-fable-5-1", opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5" };
// the exact model and effort the setting stands for (an older alias made exact, nothing set: the owner's picks)
export const exactModel = (m?: string) => { const x = ALIAS[m ?? ""] ?? m ?? ""; return MODELS.some(([k]) => k === x) ? x : DEFAULT_MODEL; };
export const exactEffort = (e?: string) => (EFFORTS.some(([k]) => k === e) ? e! : DEFAULT_EFFORT);
export type RunPrefs = { mode: RunMode; model: string; effort: string; freshOver: number };
export function useRunPrefs(): RunPrefs | null {
  const [p, setP] = useState<RunPrefs | null>(null);
  useEffect(() => onSnapshot(doc(db, "meta", "runs"), (d) => {
    const x = d.data() ?? {};
    setP({ mode: x.permissionMode === "auto" ? "auto" : "manual", model: String(x.model ?? ""), effort: String(x.effort ?? ""), freshOver: x.freshOver == null ? 300000 : Number(x.freshOver) });
  }), []);
  return p;
}
export const setRunPrefs = (p: Partial<{ model: string; effort: string; freshOver: number }>) =>
  setDoc(doc(db, "meta", "runs"), { ...p, changedAt: new Date().toISOString() }, { merge: true });
const withRun = (w?: RunWith) => ({ ...(w?.model ? { model: w.model } : {}), ...(w?.effort ? { effort: w.effort } : {}), ...(w?.fresh && w.fresh !== "auto" ? { fresh: w.fresh } : {}) });
export function useRunMode(): RunMode | null {
  const [mode, setMode] = useState<RunMode | null>(null);
  useEffect(() => onSnapshot(doc(db, "meta", "runs"), (d) => setMode(d.data()?.permissionMode === "auto" ? "auto" : "manual")), []);
  return mode;
}
export const setRunMode = (mode: RunMode) =>
  setDoc(doc(db, "meta", "runs"), { permissionMode: mode, changedAt: new Date().toISOString() }, { merge: true });

export function usePlanSteps(planId: string | undefined): PlanStep[] | null {
  const [rows, setRows] = useState<PlanStep[] | null>(null);
  const active = useActive();
  useEffect(() => {
    if (!planId || !active) return;
    return onSnapshot(query(collection(db, "planSteps"), where("planId", "==", planId)), (s) =>
      (countReads(s.docChanges().length, "planSteps"), setRows(s.docs.map((d) => d.data() as PlanStep))));
  }, [planId, active]);
  return rows;
}

// The plan's Generated section (GeneratedView.tsx): the approved files per version folder, written by the bridge.
export type PlanGenerated = { planId: string; versions: Record<string, { file: string; kind: string; at: string }[]> };
export function usePlanGenerated(planId: string | undefined): PlanGenerated | null {
  const [g, setG] = useState<PlanGenerated | null>(null);
  const active = useActive();
  useEffect(() => {
    if (!planId || !active) return;
    return onSnapshot(doc(db, "planGenerated", planId), (s) => (countReads(1, "planGenerated"), setG((s.data() as PlanGenerated) ?? { planId, versions: {} })));
  }, [planId, active]);
  return g;
}

// The owner's ticks on the harness (harness.ts): one small record per plan, never a plan version.
export function useHarness(planId: string | undefined): HarnessTicks | null {
  const [t, setT] = useState<HarnessTicks | null>(null);
  const active = useActive();
  useEffect(() => {
    if (!planId || !active) return;
    return onSnapshot(doc(db, "planHarness", planId), (s) => (countReads(1, "planHarness"), setT((s.data() as HarnessTicks) ?? { planId, items: {} })));
  }, [planId, active]);
  return t;
}
export const tickHarness = (planId: string, h: HarnessItem, ok: boolean, v: number) =>
  setDoc(doc(db, "planHarness", planId),
    { planId, items: { [h.id]: { ok, at: new Date().toISOString(), hash: itemHash(h), v } } }, { merge: true });

// Per-step picks (the owner's pick, 2026-11-16: "Bar + per-step picks table"; the owner's words: "choosing what runner
// and model and effort for each step when run"): one small record per plan, planPicks/<plan id>, never a plan version.
// Run step and Run all (bridge chain.py) use each step's own pick; a step with no pick takes the Runs tab setting.
// Runner: Claude only for now (the owner's pick, 2026-11-16: "Claude only now, local later"): a local run has no tools,
// so it can't send a step's done report.
// Async (the owner's picks, 2026-11-16: "Marked steps run together, max N", "Heavy tick: runs alone"): together lets the
// step run beside other ticked steps, each in its own fresh session; heavy makes it run alone. maxTogether: N (default 2).
export type StepPick = RunWith & { runner?: "claude"; together?: boolean; heavy?: boolean };
// autoTick (C, the owner's pick 2026-11-25: "for c default is off"): the bridge ticks the check a session proposes.
export type PlanPicks = { planId: string; steps: Record<string, StepPick>; maxTogether?: number; autoTick?: boolean };
export const setAutoTick = (planId: string, on: boolean) =>
  setDoc(doc(db, "planPicks", planId), { planId, autoTick: on, updatedAt: new Date().toISOString() }, { merge: true });
export const setMaxTogether = (planId: string, n: number) =>
  setDoc(doc(db, "planPicks", planId), { planId, maxTogether: n, updatedAt: new Date().toISOString() }, { merge: true });
export function usePlanPicks(planId: string | undefined): PlanPicks | null {
  const [p, setP] = useState<PlanPicks | null>(null);
  const active = useActive();
  useEffect(() => {
    if (!planId || !active) return;
    return onSnapshot(doc(db, "planPicks", planId), (s) => (countReads(1, "planPicks"), setP((s.data() as PlanPicks) ?? { planId, steps: {} })));
  }, [planId, active]);
  return p;
}
export const setStepPick = (planId: string, stepId: string, pick: StepPick) =>
  setDoc(doc(db, "planPicks", planId), { planId, steps: { [stepId]: { ...pick, runner: "claude" } }, updatedAt: new Date().toISOString() }, { merge: true });

// Step check runner (step i8; the owner's picks 2026-11-12: "Session proposes, you edit + tick", "On done + a Run check
// button", "Step turns failed, chain stops", "PowerShell, plan folder, 10 min"): one record per step (bridge stepcheck.py).
export type CheckRun = { at: string; endedAt: string; exit: number | null; seconds: number; trigger: "done" | "button";
  command: string; tail: string; timedOut: boolean; runId: string };
export type StepCheck = { id: string; planId: string; stepId: string; command: string; proposedBy?: "session" | "owner";
  tick?: { ok: boolean; hash: string; at: string; by?: "auto" | "owner-inbox" }; state?: "idle" | "queued" | "running"; last?: CheckRun; runs?: CheckRun[] };
export function useStepChecks(planId: string | undefined): StepCheck[] {
  const [c, setC] = useState<StepCheck[]>([]);
  const active = useActive();
  useEffect(() => {
    if (!planId || !active) return;
    return onSnapshot(query(collection(db, "planChecks"), where("planId", "==", planId)), (s) =>
      (countReads(s.docChanges().length, "planChecks"), setC(s.docs.map((d) => d.data() as StepCheck))));
  }, [planId, active]);
  return c;
}
// F6 round budget per plan (bridge rounds.py; the owner's picks 2026-11-23: "6 h + 30% window", "At once, resumable").
export type RoundReport = { round: number; startedAt: string; endedAt: string; why: string; hoursUsed: number; windowPct: number;
  budgetHours: number; budgetWindowPct: number; usd: number; runs: { id: string; step: string; minutes: number; status: string }[];
  paused: string[]; stepsOpen: string[] };
export type PlanRound = { planId: string; on: boolean; round: number; state: "open" | "over"; startedAt: string; hoursUsed: number;
  windowPct: number; budgetHours: number; budgetWindowPct: number; reports?: RoundReport[] };
export function usePlanRound(planId: string | undefined): PlanRound | null {
  const [r, setR] = useState<PlanRound | null>(null);
  const active = useActive();
  useEffect(() => {
    if (!planId || !active) return;
    return onSnapshot(doc(db, "planRounds", planId), (s) => (countReads(1, "planRounds"), setR((s.data() as PlanRound) ?? null)));
  }, [planId, active]);
  return r;
}
export const setPlanRound = (machine: string, planId: string, op: "on" | "off" | "next") => {
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  return setDoc(doc(db, "commands", id), { id, action: "round", op, machine, planId, status: "new", createdAt: new Date().toISOString() });
};
// F8, claims across boxes (plan bf73af63, "a session claims a step or folder; shown on the page; a second box is
// refused"): each box's copy of the claims it holds (bridge claims.py), read from the boxes, never from Firestore.
export type Claim = { key: string; kind: "step" | "folder"; planId: string; stepId: string; folder: string; machine: string;
  sessionId: string; runId: string; by: "run" | "session"; at: string };
export function useClaims(planId: string | undefined): Claim[] {
  const [c, setC] = useState<Claim[]>([]);
  const active = useActive();
  useEffect(() => {
    if (!planId || !active) return;
    return onSnapshot(query(collection(db, "boxClaims"), where("planId", "==", planId)), (s) =>
      (countReads(s.docChanges().length, "boxClaims"), setC(s.docs.map((d) => d.data() as Claim))));
  }, [planId, active]);
  return c;
}
export const checkTicked = (c?: StepCheck | null) =>
  !!c?.command?.trim() && !!c.tick?.ok && c.tick.hash === checkHash(c.command.trim());
// Your edit: a new command is unticked until you tick it (its hash no longer matches the tick).
export const saveCheckCommand = (planId: string, stepId: string, command: string) =>
  setDoc(doc(db, "planChecks", `${planId}_${stepId}`), { id: `${planId}_${stepId}`, planId, stepId, command: command.trim(),
    proposedBy: "owner", updatedAt: new Date().toISOString() }, { merge: true });
export const tickCheck = (c: StepCheck, ok: boolean) =>
  updateDoc(doc(db, "planChecks", c.id), { tick: { ok, hash: checkHash(c.command.trim()), at: new Date().toISOString() } });
// Run check: the bridge runs the ticked command now (it refuses an unticked one, or a folder outside WORK_ROOTS).
export const runCheck = async (plan: Plan, c: StepCheck) => {
  const id = newId();
  await setDoc(doc(db, "commands", id), { id, action: "step_check", machine: plan.machine, planId: plan.id, stepId: c.stepId,
    trigger: "button", status: "new", createdAt: new Date().toISOString() });
  await updateDoc(doc(db, "planChecks", c.id), { state: "queued" });
};

// 8. Evidence (the owner's words, 2026-11-12: "an evidence section after result section, which capture the evidence of
// done for each step"; "I want to have the image evidences, not text"; picks "Attach, else picture run", "Fresh one-off
// run", "Mark only"): one record per step (bridge evidence.py). sets: picture sets, newest first; check: the last LLM marks.
export type EvidenceSet = { at: string; by: "report" | "run"; trigger: "done" | "button"; runId?: string; stepVersion?: number; pictures: string[] };
export type EvidenceMark = { path: string; verdict: "pass" | "fail" | "unclear"; why: string };
// F5 (plan bf73af63, "extend the evidence LLM check: findings list, each confirmed / rejected / fixed with a reason"):
// each finding the LLM check lists, validated first (confirmed real / rejected not real); a later check marks it fixed.
export type EvidenceFinding = { id: string; text: string; picture?: string; disposition: "confirmed" | "rejected" | "fixed";
  why: string; raised: string; at: string };
export type StepEvidence = { id: string; planId: string; stepId: string; sets?: EvidenceSet[]; state?: "idle" | "queued" | "running";
  what?: "pictures" | "check" | null; error?: string | null;
  check?: { at: string; runId: string; set?: string; overall: "pass" | "fail" | "unclear"; pictures: EvidenceMark[]; note: string;
    findings?: EvidenceFinding[] } };
// s5 glance test (the owner's pick "Button on the board"): the board shows 10 s, hides, the owner answers 4 questions;
// a fresh run scores them against the plan (bridge glance.py), 0 to 4, per version.
export type GlanceMark = { q: "whatFor" | "done" | "next" | "blocked"; verdict: "right" | "partly" | "wrong"; why: string };
export type GlanceTest = { at: string; version: number; answers: Record<string, string>; score: number | null; marks: GlanceMark[]; runId: string; error?: string };
export type PlanGlance = { id: string; planId: string; tests?: GlanceTest[]; state?: "idle" | "queued" | "running" };
export function usePlanGlance(planId: string | undefined): PlanGlance | null {
  const [g, setG] = useState<PlanGlance | null>(null);
  const active = useActive();
  useEffect(() => {
    if (!planId || !active) return;
    return onSnapshot(query(collection(db, "planGlance"), where("planId", "==", planId)), (s) =>
      (countReads(s.docChanges().length, "planGlance"), setG((s.docs[0]?.data() as PlanGlance) ?? null)));
  }, [planId, active]);
  return g;
}
export const askGlance = async (plan: Plan, version: number, answers: Record<string, string>) => {
  const id = newId();
  await setDoc(doc(db, "commands", id), { id, action: "glance", machine: plan.machine, planId: plan.id, version, answers,
    folder: plan.cwd, trigger: "button", status: "new", createdAt: new Date().toISOString() });
  await setDoc(doc(db, "planGlance", plan.id), { id: plan.id, planId: plan.id, state: "queued" }, { merge: true });
};
export function useStepEvidence(planId: string | undefined): StepEvidence[] {
  const [e, setE] = useState<StepEvidence[]>([]);
  const active = useActive();
  useEffect(() => {
    if (!planId || !active) return;
    return onSnapshot(query(collection(db, "planEvidence"), where("planId", "==", planId)), (s) =>
      (countReads(s.docChanges().length, "planEvidence"), setE(s.docs.map((d) => d.data() as StepEvidence))));
  }, [planId, active]);
  return e;
}
// Generate evidence ("pictures") and LLM check ("check"): a fresh one-off run on the plan's machine.
export const askEvidence = async (plan: Plan, stepId: string, what: "pictures" | "check", w?: RunWith) => {
  const id = newId();
  await setDoc(doc(db, "commands", id), { id, action: "evidence", what, machine: plan.machine, planId: plan.id, stepId,
    folder: plan.cwd, trigger: "button", status: "new", createdAt: new Date().toISOString(), ...withRun(w) });
  await setDoc(doc(db, "planEvidence", `${plan.id}_${stepId}`), { id: `${plan.id}_${stepId}`, planId: plan.id, stepId,
    state: "queued", what, error: null }, { merge: true });
};

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
export const sendPlanMessage = (plan: Plan, kind: PlanKind, text: string, on?: { stepId?: string; part?: string }, w?: RunWith) => {
  const id = newId();
  return setDoc(doc(db, "commands", id), {
    id, action: "message", machine: plan.machine, sessionId: plan.sessionId, cwd: plan.cwd, prompt: text, ownerText: text,
    kind, planId: plan.id, status: "new", createdAt: new Date().toISOString(), ...withRun(w),
    ...(on?.stepId ? { stepId: on.stepId } : {}), ...(on?.part ? { part: on.part } : {}),
  });
};

// s6 Update board (the owner, 2026-11-21: "I want the update button so I can do manual update for the roll out"): an
// Action message to the plan's session; the bridge (boardformat.update_block) puts the board-update order in the run.
export const updateBoard = (plan: Plan) => {
  const id = newId();
  const text = "Update board: bring this plan's board up to the latest format.";
  return setDoc(doc(db, "commands", id), {
    id, action: "message", machine: plan.machine, sessionId: plan.sessionId, cwd: plan.cwd, prompt: text, ownerText: text,
    kind: "action", boardUpdate: true, planId: plan.id, status: "new", createdAt: new Date().toISOString(),
  });
};

// Run step (the owner's words, 2026-11-03: "Add Ren step button"): a plain message to the plan's session.
// G1 (the owner, 2026-11-18: "all 5 gap, fix one by one"): the step's text and its check go in the message; the same
// words as the bridge's chain.py step_text.
const sentence = (label: string, text?: string) => {
  const t = (text ?? "").split(/\s+/).filter(Boolean).join(" ");
  return t ? ` ${label}: ${t}${/[.!?]$/.test(t) ? "" : "."}` : "";
};
export const stepText = (step: Parts["steps"][number], harness = "") =>
  `Work on step ${step.id}: ${step.title}.${sentence("The step", step.does)}${sentence("Its check", step.check)} Report it with step_update.${harness}`;
export const runStep = (plan: Plan, step: Parts["steps"][number], harness = "", w?: RunWith) => {
  const id = newId();
  const text = stepText(step, harness);
  return setDoc(doc(db, "commands", id), {
    id, action: "message", machine: plan.machine, sessionId: plan.sessionId, cwd: plan.cwd, prompt: text, ownerText: text,
    planId: plan.id, stepId: step.id, status: "new", createdAt: new Date().toISOString(), ...withRun(w),
  });
};

// Run all steps (the owner's words, 2026-11-10: "an automatic job or way to start all the steps without need me to press
// every single one"; picks "Chain, stop on fail", "Button only"): the bridge runs the steps not done, one after another
// (bridge chain.py); it stops on a fail and pushes. Stop ends the chain after the run going now.
export type PlanChain = { planId: string; state: "on" | "stopped" | "done"; stepId?: string | null; runId?: string | null;
  running?: Record<string, string>; failing?: string | null;
  left?: number; reason?: string | null; startedAt?: string; endedAt?: string | null };
export function usePlanChain(planId: string | undefined): PlanChain | null {
  const [c, setC] = useState<PlanChain | null>(null);
  const active = useActive();
  useEffect(() => {
    if (!planId || !active) return;
    return onSnapshot(doc(db, "planChains", planId), (s) => (countReads(1, "planChains"), setC((s.data() as PlanChain) ?? null)));
  }, [planId, active]);
  return c;
}
// The harness note is made by the bridge as each step starts, from the ticks then (chain.py harness_note).
export const runAllSteps = (plan: Plan, w?: RunWith) => {
  const id = newId();
  return setDoc(doc(db, "commands", id), {
    id, action: "chain", machine: plan.machine, planId: plan.id, prompt: "Run all steps",
    status: "new", createdAt: new Date().toISOString(), ...withRun(w),
  });
};
export const stopChain = (planId: string) =>
  setDoc(doc(db, "planChains", planId), { state: "stopped", reason: "stopped by the owner", endedAt: new Date().toISOString() }, { merge: true });

// The owner's order to move the plan's phase (phases.ts): the bridge writes the plain version itself (runs.py _phase), no
// Claude run; the command goes when done, or stays failed with its error.
export const sendPhaseOrder = (plan: Plan, to: string, order: string) => {
  const id = newId();
  return setDoc(doc(db, "commands", id), {
    id, action: "phase", machine: plan.machine, planId: plan.id, phase: to, ownerText: order,
    phaseOrder: true, status: "new", createdAt: new Date().toISOString(),
  });
};

// The owner's "I checked it" receipt (the owner, 2026-11-22, plan 41188c93: "option C"): for a check only a person can
// run, the owner's word is the receipt; the bridge marks the step done itself (runs.py _owner_receipt), no Claude run.
export const sendOwnerReceipt = (plan: Plan, stepId: string, note: string) => {
  const id = newId();
  return setDoc(doc(db, "commands", id), {
    id, action: "owner_receipt", machine: plan.machine, planId: plan.id, stepId, note: note.trim(),
    status: "new", createdAt: new Date().toISOString(),
  });
};

// The owner's Generate order (planCheck.ts): a plain message to the plan's session, with the kinds asked.
export const sendGenerate = (plan: Plan, kinds: string[], note: string, text: string, w?: RunWith,
  formats: Format[] = [], base: Base = "last") => {
  const id = newId();
  const order = `Generate: ${kinds.join(", ")}${formats.length ? ` as ${formats.join(", ")}` : ""}${kinds.includes("compare") ? ` (compare with ${base})` : ""}${note.trim() ? `. Note: ${note.trim()}` : ""}`;
  return setDoc(doc(db, "commands", id), {
    id, action: "message", machine: plan.machine, sessionId: plan.sessionId, cwd: plan.cwd, prompt: text, ownerText: order,
    planId: plan.id, generate: { kinds, formats, base, note: note.trim() }, status: "new", createdAt: new Date().toISOString(), ...withRun(w),
  });
};

// The owner's approval of a Generate result (planCheck.ts approvals): the bridge moves the ticked files out of tmp/,
// removes tmp/ and deletes the "Generated" results that pointed into it.
export const sendApproveGenerated = (plan: Plan, a: { folder: string; keep: string[]; drop: string[]; kinds?: Record<string, string>; keepTmp?: boolean }) => {
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
