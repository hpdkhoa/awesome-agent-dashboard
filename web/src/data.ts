import { useEffect, useState } from "react";
import { collection, limit, onSnapshot, orderBy, query, type QueryConstraint } from "firebase/firestore";
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
  models: Record<string, number>;
  tokens: Tokens;
  days: Record<string, Tokens>;
  syncedAt: string;
};

export type Usage = Tokens & { day: string; byWorkType: Record<string, Tokens>; byModel: Record<string, Tokens>; sessionCount: number };
export type WorkType = Tokens & { id: string; sessions: number; lastAt: string };
export type Machine = { name: string; windowDays: number; sessions: number; syncedAt: string };

function useCollection<T>(name: string, ...constraints: QueryConstraint[]): T[] | null {
  const [rows, setRows] = useState<T[] | null>(null);
  useEffect(
    () => onSnapshot(query(collection(db, name), ...constraints), (s) => setRows(s.docs.map((d) => d.data() as T))),
    [name],
  );
  return rows;
}

export const useSessions = () => useCollection<Session>("sessions", orderBy("lastAt", "desc"), limit(300));
export const useUsage = () => useCollection<Usage>("usage", orderBy("day", "desc"), limit(30));
export const useWorkTypes = () => useCollection<WorkType>("workTypes");
export const useMachines = () => useCollection<Machine>("machines");
