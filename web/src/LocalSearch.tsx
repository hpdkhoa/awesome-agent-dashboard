import { useState } from "react";
import { bridgePost } from "./FileView";
import { Md } from "./Markdown";
import { Section } from "./Section";

// Step i6 (the plan: "Ollama index of session logs; search box; daily digest"; the owner's choice, 2026-11-12: "Ollama
// on this PC"): the bridge searches every prompt of every session log with a local embedding model and keeps a digest
// per day written by a local model (bridge/agent_bridge/localsearch.py). Asked through the tunnel; nothing is stored.
type Hit = { session: string; score: number; meaning: number; words: number; exact: boolean; turn: number; at: string; prompt: string; project: string; turns: number };
type Digest = { day: string; text: string; days: string[]; missing?: boolean };

const yesterday = () => {
  const d = new Date(Date.now() - 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function LocalSearch({ onPick, known }: { onPick: (id: string) => void; known: Set<string> }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | string | null>(null);
  const [busy, setBusy] = useState(false);
  async function go() {
    if (!q.trim()) return;
    setBusy(true);
    try {
      setHits((await bridgePost<{ results: Hit[] }>("/text", { search: q })).results);
    } catch (e) {
      setHits(String((e as Error).message ?? e));
    }
    setBusy(false);
  }
  return (
    <div className="local-search">
      <input value={q} placeholder="Search all sessions (on the PC)" onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && go()} />
      <button disabled={busy} onClick={go}>{busy ? "Searching" : "Search"}</button>
      {typeof hits === "string" && <p className="bad small">{hits}</p>}
      {Array.isArray(hits) && (
        <ul className="list hits">
          {hits.length === 0 && <li className="muted small">No match.</li>}
          {hits.map((h) => (
            <li key={h.session} className="row" onClick={() => known.has(h.session) && onPick(h.session)}
              title={known.has(h.session) ? "Open this session" : "Not in the session list (older than the list keeps)"}>
              <div className="grow">
                <div className="title">{h.prompt.split("\n")[0].slice(0, 120)}</div>
                <div className="muted small">
                  {h.project} · turn {h.turn} of {h.turns} · {h.at ? new Date(h.at).toLocaleDateString() : ""} · {h.exact ? "word for word" : `meaning ${h.meaning.toFixed(2)}`}
                  {!known.has(h.session) && <> · {h.session.slice(0, 8)}</>}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function DigestView() {
  const [day, setDay] = useState(yesterday());
  const [got, setGot] = useState<Digest | string | null>(null);
  const load = (d: string) =>
    bridgePost<Digest>("/text", { digest: d }).then(setGot, (e) => setGot(String((e as Error).message ?? e)));
  return (
    <Section id="sessions.digest" title="Daily digest" extra="written on the PC by a local model" open={false}>
      <input type="date" value={day} onChange={(e) => setDay(e.target.value)} />{" "}
      <button onClick={() => load(day)}>Show</button>
      {typeof got === "string" && <p className="bad small">{got}</p>}
      {got && typeof got !== "string" && (
        got.missing ? (
          <p className="muted small">No digest for {got.day} yet. Days with one: {got.days.join(", ") || "none yet"}.</p>
        ) : (
          <Md text={got.text} cwd="" />
        )
      )}
    </Section>
  );
}
