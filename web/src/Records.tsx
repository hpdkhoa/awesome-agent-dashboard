import { useEffect, useMemo, useState } from "react";
import { bridgePost } from "./FileView";
import { collection, getDocs, limit, onSnapshot, orderBy, query, startAfter, where, type QueryDocumentSnapshot } from "./fs";
import { db } from "./firebase";
import { Md } from "./Markdown";
import { Section } from "./Section";
import { countReads, useActive } from "./pageReads";
import { dd } from "./fmt";

// Records with ids (plan bf73af63 step F1; the owner, 2026-11-18, on the KB mockup: "good add this to plan"; "I pick
// best"). The knowledge base for the owner: type filters, search (meaning + words, Ollama on the PC), each record's
// versions with the owner's words, its links and a graph, and a human copy per area (bridge records.py).
export type Rec = {
  id: string; type: RecType; n: number; text: string; title: string; words?: string; why?: string; source?: string; area?: string;
  plan?: string; step?: string; files?: string[]; status?: string; cited?: number; createdAt: string; updatedAt: string; kind?: string;
  versions?: { v: number; text: string; words?: string; at: string; by?: string; note?: string }[];
  links?: { supersedes?: string[]; supersededBy?: string[]; duplicateOf?: string; duplicates?: string[]; retryOf?: string; newReason?: string };
};
type RecType = "dec" | "att" | "les" | "rule" | "find";
export const REC_TYPES: { id: RecType; name: string; color: string }[] = [
  { id: "dec", name: "decisions", color: "#5aa9e6" }, { id: "att", name: "attempts", color: "#f2a65a" },
  { id: "les", name: "lessons", color: "#7bd389" }, { id: "rule", name: "rules", color: "#c792ea" },
  { id: "find", name: "findings", color: "#f07178" },
];
const color = (t: string) => REC_TYPES.find((x) => x.id === t)?.color ?? "#888";

// One live listener per type, newest 500 first (a bridge read returns at most 500, dataapi.py MAX_LIMIT), and the
// older ones of a type that has more read once in pages of 500 (the import alone made 466 decisions).
const CAP = 500;
export function useRecords(on: boolean): Rec[] | null {
  const [byType, setByType] = useState<Record<string, Rec[]>>({});
  const [older, setOlder] = useState<Record<string, Rec[]>>({});
  const active = useActive();
  useEffect(() => {
    if (!active || !on) return;
    const offs = REC_TYPES.map((t) => onSnapshot(query(collection(db, "records"), where("type", "==", t.id), orderBy("n", "desc"), limit(CAP)), (s) => {
      countReads(s.docChanges().length, "records");
      setByType((m) => ({ ...m, [t.id]: s.docs.map((d) => d.data() as Rec) }));
      if (s.docs.length === CAP) void loadOlder(t.id, s.docs.at(-1)!).then((rows) => setOlder((m) => ({ ...m, [t.id]: rows })));
    }));
    return () => offs.forEach((f) => f());
  }, [active, on]);
  const got = REC_TYPES.filter((t) => byType[t.id]);
  return got.length < REC_TYPES.length ? null : got.flatMap((t) => [...byType[t.id], ...(older[t.id] ?? [])]);
}

async function loadOlder(type: string, after: QueryDocumentSnapshot): Promise<Rec[]> {
  const out: Rec[] = [];
  for (let last = after; ;) {
    const s = await getDocs(query(collection(db, "records"), where("type", "==", type), orderBy("n", "desc"), startAfter(last), limit(CAP)));
    countReads(s.docs.length, "records");
    out.push(...s.docs.map((d) => d.data() as Rec));
    if (s.docs.length < CAP) return out;
    last = s.docs.at(-1)!;
  }
}

export function RecordsSide({ rows, picked, onPick }: { rows: Rec[] | null; picked?: string; onPick: (id: string) => void }) {
  const [type, setType] = useState<RecType | "all">("all");
  const [area, setArea] = useState("all");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ ids: string[]; how: string } | string | null>(null);
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState(60);
  const areas = useMemo(() => [...new Set((rows ?? []).map((r) => r.area ?? "general"))].sort(), [rows]);
  async function go() {
    if (!q.trim()) return setHits(null);
    setBusy(true);
    try {
      const got = await bridgePost<{ how: string; results: { id: string }[] }>("/text", { records: q, type: type === "all" ? "" : type });
      setHits({ ids: got.results.map((r) => r.id), how: got.how });
    } catch (e) {
      setHits(String((e as Error).message ?? e));
    }
    setBusy(false);
  }
  const byId = new Map((rows ?? []).map((r) => [r.id, r]));
  const base = (rows ?? []).filter((r) => (type === "all" || r.type === type) && (area === "all" || (r.area ?? "general") === area));
  const shown = hits && typeof hits !== "string"
    ? hits.ids.map((id) => byId.get(id)).filter((r): r is Rec => !!r && base.includes(r))
    : [...base].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <div className="records-side" data-records-side>
      <div className="pad">
        <div className="chips">
          {[{ id: "all" as const, name: "all" }, ...REC_TYPES].map((t) => (
            <button key={t.id} className={type === t.id ? "chip on" : "chip"} onClick={() => setType(t.id)}>
              {t.id} <span className="muted">{(rows ?? []).filter((r) => t.id === "all" || r.type === t.id).length}</span>
            </button>
          ))}
        </div>
        <select value={area} onChange={(e) => setArea(e.target.value)} title="Area">
          <option value="all">every area</option>
          {areas.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <div className="local-search">
          <input value={q} placeholder="Search records (meaning and words, on the PC)" onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && go()} />
          <button disabled={busy} onClick={go}>{busy ? "Searching" : "Search"}</button>
          {hits && <button onClick={() => (setQ(""), setHits(null))}>Clear</button>}
        </div>
        {typeof hits === "string" && <p className="bad small">{hits}</p>}
        {hits && typeof hits !== "string" && <p className="muted small">{shown.length} found · {hits.how}</p>}
      </div>
      <ul className="list">
        {rows === null && <li className="muted">Loading</li>}
        {shown.slice(0, n).map((r) => (
          <li key={r.id} className={r.id === picked ? "row on" : "row"} onClick={() => onPick(r.id)} data-record={r.id}>
            <span className="rec-id" style={{ borderColor: color(r.type) }}>{r.id}</span>
            <div className="grow">
              <div className="title">{r.title.slice(0, 140)}</div>
              <div className="muted small">
                v{r.versions?.length ?? 1}{r.type === "att" ? ` · ${r.status}` : r.status && r.status !== "active" ? ` · ${r.status}` : ""} · {r.area} · {dd(r.updatedAt)}
                {r.cited ? ` · cited ${r.cited}x` : ""}
              </div>
            </div>
          </li>
        ))}
        {shown.length > n && <li className="row muted" onClick={() => setN(n + 60)}>Show more ({shown.length - n} left)</li>}
        {rows !== null && shown.length === 0 && <li className="muted">No record.</li>}
      </ul>
    </div>
  );
}

export function RecordsView({ rows, picked, onPick }: { rows: Rec[] | null; picked?: string; onPick: (id: string) => void }) {
  const r = (rows ?? []).find((x) => x.id === picked);
  return (
    <>
      {!r ? <p className="muted">Pick a record on the left. {rows ? `${rows.length} records.` : ""}</p> : <RecordCard r={r} rows={rows ?? []} onPick={onPick} />}
      <HumanCopy rows={rows ?? []} />
    </>
  );
}

function RecordCard({ r, rows, onPick }: { r: Rec; rows: Rec[]; onPick: (id: string) => void }) {
  const L = r.links ?? {};
  const link = (id: string) => <button key={id} className="linkish" onClick={() => onPick(id)}>{id}</button>;
  const list = (ids?: string[]) => (ids ?? []).length ? (ids ?? []).map((id, i) => <span key={id}>{i ? ", " : ""}{link(id)}</span>) : <span className="muted">none</span>;
  return (
    <div className="record" data-record-card={r.id}>
      <h2><span className="rec-id" style={{ borderColor: color(r.type) }}>{r.id}</span> {r.title.slice(0, 160)}</h2>
      <p className="muted small">
        {REC_TYPES.find((t) => t.id === r.type)?.name.replace(/s$/, "")} · v{r.versions?.length ?? 1} · {r.status} · area {r.area}
        {r.kind ? ` · logged as ${r.kind}` : ""} · cited {r.cited ?? 0}x · made {dd(r.createdAt)}
      </p>
      <Md text={r.text} cwd="" />
      {r.words && <p className="small"><b>The owner's words:</b> {r.words}</p>}
      {r.why && <p className="small"><b>Why:</b> <Md line text={r.why} /></p>}
      {r.source && <p className="muted small">source: {r.source}</p>}
      <Section id="records.versions" title={`Versions (${r.versions?.length ?? 1})`} extra="the owner's words per version" open>
        <ol className="rec-versions" data-rec-versions>
          {(r.versions ?? []).map((v) => (
            <li key={v.v}>
              <b>v{v.v}</b> · {dd(v.at)} · {v.note ?? ""}{v.by ? ` · by ${v.by.slice(0, 12)}` : ""}
              {v.words ? <div className="small">the owner: {v.words}</div> : <div className="muted small">no owner's words</div>}
              {v.v < (r.versions?.length ?? 1) && <div className="muted small">{v.text.split("\n")[0].slice(0, 200)}</div>}
            </li>
          ))}
        </ol>
      </Section>
      <Section id="records.links" title="Links" extra="supersedes, duplicate-of, applies to" open>
        <ul className="small">
          <li>supersedes: {list(L.supersedes)} · superseded by: {list(L.supersededBy)}</li>
          <li>duplicate of: {L.duplicateOf ? link(L.duplicateOf) : <span className="muted">none</span>} · its duplicates: {list(L.duplicates)}</li>
          {L.retryOf && <li>retry of rejected {link(L.retryOf)}: {L.newReason}</li>}
          <li>applies to: {r.plan ? `plan ${r.plan.slice(0, 8)}${r.step ? " step " + r.step : ""}` : <span className="muted">no plan</span>}
            {(r.files ?? []).length > 0 && <> · files {r.files!.join(", ")}</>}</li>
        </ul>
      </Section>
      <Section id="records.graph" title="Graph" extra="this record and what links to it" open>
        <RecordGraph r={r} rows={rows} onPick={onPick} />
      </Section>
    </div>
  );
}

type Edge = { to: string; kind: string; label: string };
const EDGE: Record<string, string> = { supersedes: "#c792ea", "superseded by": "#c792ea", "duplicate of": "#f07178", duplicate: "#f07178",
  "retry of": "#f2a65a", "retried by": "#f2a65a", "same plan step": "#5aa9e6", "same source": "#7bd389" };

// A small graph: the record in the middle, every record it links to around it, and the records of the same plan step
// or the same source line nearby (at most 12), each edge coloured by its kind (legend under it).
export function edgesOf(r: Rec, rows: Rec[]): Edge[] {
  const L = r.links ?? {};
  const out: Edge[] = [
    ...(L.supersedes ?? []).map((to) => ({ to, kind: "supersedes", label: "supersedes" })),
    ...(L.supersededBy ?? []).map((to) => ({ to, kind: "superseded by", label: "superseded by" })),
    ...(L.duplicateOf ? [{ to: L.duplicateOf, kind: "duplicate of", label: "duplicate of" }] : []),
    ...(L.duplicates ?? []).map((to) => ({ to, kind: "duplicate", label: "duplicate" })),
    ...(L.retryOf ? [{ to: L.retryOf, kind: "retry of", label: "retry of" }] : []),
  ];
  // the other way: records that point at this one (a retry of it, a duplicate or a successor not yet listed on it)
  for (const x of rows) {
    const X = x.links ?? {};
    if (X.retryOf === r.id) out.push({ to: x.id, kind: "retried by", label: `retried by (${X.newReason ?? "new reason"})` });
    if (X.duplicateOf === r.id && !(L.duplicates ?? []).includes(x.id)) out.push({ to: x.id, kind: "duplicate", label: "duplicate" });
    if ((X.supersedes ?? []).includes(r.id) && !(L.supersededBy ?? []).includes(x.id)) out.push({ to: x.id, kind: "superseded by", label: "superseded by" });
  }
  const seen = new Set([r.id, ...out.map((e) => e.to)]);
  if (r.plan) for (const x of rows) if (!seen.has(x.id) && x.plan === r.plan && (x.step ?? "") === (r.step ?? "")) (seen.add(x.id), out.push({ to: x.id, kind: "same plan step", label: "same plan step" }));
  const src = (r.source ?? "").split(":").slice(0, -1).join(":");
  if (src && out.length < 8) for (const x of rows) if (!seen.has(x.id) && (x.source ?? "").startsWith(src + ":") && Math.abs(x.n - r.n) <= 2 && x.type === r.type) (seen.add(x.id), out.push({ to: x.id, kind: "same source", label: "same log, next row" }));
  return out.slice(0, 12);
}

function RecordGraph({ r, rows, onPick }: { r: Rec; rows: Rec[]; onPick: (id: string) => void }) {
  const edges = edgesOf(r, rows);
  const byId = new Map(rows.map((x) => [x.id, x]));
  const W = 640, H = 360, cx = W / 2, cy = H / 2, R = 130;
  const kinds = [...new Set(edges.map((e) => e.kind))];
  return (
    <div data-rec-graph>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: W }} role="img" aria-label={`graph of ${r.id}`}>
        {edges.map((e, i) => {
          const a = (2 * Math.PI * i) / Math.max(1, edges.length) - Math.PI / 2;
          const x = cx + R * 1.6 * Math.cos(a), y = cy + R * Math.sin(a);
          const t = byId.get(e.to);
          return (
            <g key={e.to} onClick={() => onPick(e.to)} style={{ cursor: "pointer" }}>
              <line x1={cx} y1={cy} x2={x} y2={y} stroke={EDGE[e.kind]} strokeWidth={2} />
              <circle cx={x} cy={y} r={22} fill="#1a1a1a" stroke={color(t?.type ?? "")} strokeWidth={3} />
              <text x={x} y={y + 4} textAnchor="middle" fontSize={11} fill="currentColor">{e.to}</text>
              <title>{e.label}: {t?.title ?? e.to}</title>
            </g>
          );
        })}
        <circle cx={cx} cy={cy} r={30} fill="#1a1a1a" stroke={color(r.type)} strokeWidth={4} />
        <text x={cx} y={cy + 4} textAnchor="middle" fontSize={12} fontWeight="bold" fill="currentColor">{r.id}</text>
      </svg>
      <p className="small">
        {edges.length === 0 ? <span className="muted">No links yet: this record stands alone.</span> : <>{edges.length} links · </>}
        {kinds.map((k) => <span key={k} style={{ color: EDGE[k], marginRight: 12 }}>━ {k} ({edges.filter((e) => e.kind === k).length})</span>)}
        {REC_TYPES.map((t) => <span key={t.id} style={{ color: t.color, marginRight: 10 }}>○ {t.id} {t.name}</span>)}
      </p>
      <p className="muted small">Lines: how a record links to this one. Rings: the record's type. Click a ring to open it.</p>
    </div>
  );
}

function HumanCopy({ rows }: { rows: Rec[] }) {
  const areas = [...new Set(rows.map((r) => r.area ?? "general"))].sort();
  const [area, setArea] = useState("");
  const [got, setGot] = useState<string | null>(null);
  const make = () => bridgePost<{ text: string }>("/text", { recordsCopy: area }).then((x) => setGot(x.text), (e) => setGot(`**Failed:** ${(e as Error).message ?? e}`));
  return (
    <Section id="records.copy" title="Human copy" extra="one page per area, made from the records, like rules-review.md" open={false}>
      <select value={area} onChange={(e) => setArea(e.target.value)}>
        <option value="">all areas</option>
        {areas.map((a) => <option key={a} value={a}>{a}</option>)}
      </select>{" "}
      <button onClick={make}>Make the copy</button>
      {got && <div data-human-copy><Md text={got} cwd="" /></div>}
    </Section>
  );
}
