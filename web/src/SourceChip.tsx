import { useEffect, useState, type ReactNode } from "react";
import { doc, getDoc } from "./fs";
import { db } from "./firebase";
import { LocalImg, openFile, ticket } from "./FileView";
import { Md } from "./Markdown";
import { countReads } from "./pageReads";
import { partLines } from "./planDiff";
import type { Parts, PlanStep } from "./data";
import type { Rec } from "./Records";

// Source chips on the report board (plan 44fc4979 s3; the owner's picks, 2026-11-19: "Source chip per line", truth
// "both a and c" = plan, KB, feedback log and project files, "Open under the line", "Red chip now, refuse after s6").
// Every board line carries its chips on the same line (rule B5); a click opens the full text right under the line and
// a second click closes it (rule B6: two levels, the line and its full text). A line with no source shows a red chip.
// The ids are the bridge's (inbox.py src_kind): a plan part, a step id, a KB record id, or a full file path (:line, or #"quoted words" for a log row).
export type SrcCtx = { parts?: Parts; steps: PlanStep[]; cwd: string };
type Kind = "part" | "step" | "record" | "file" | "";

const PARTS = ["goal", "summary", "rules", "lessons", "leftover", "steps"];
const FILE = /^(?<path>[A-Za-z]:[\\/][^#]+?)(?::(?<line>\d+)|#(?<quote>.+))?$/;
// the quoted words of a path#"words" id (a feedback log row: the owner's pick, 2026-11-19, "Anchor by quoted text")
const quoteOf = (q?: string) => (q ?? "").trim().replace(/^"|"$/g, "").trim();

export function srcKind(id: string): Kind {
  if (PARTS.includes(id)) return "part";
  if (/^(dec|att|les|rule|find):\d+$/.test(id)) return "record";
  if (FILE.test(id)) return "file";
  if (/^(step:)?s\w{0,18}$/.test(id)) return "step";
  return "";
}

function label(id: string): string {
  if (srcKind(id) !== "file") return id.replace(/^step:/, "");
  const m = FILE.exec(id)!.groups!;
  const q = quoteOf(m.quote);
  return m.path.split(/[\\/]/).pop()! + (m.line ? ":" + m.line : q ? ` "${q.length > 24 ? q.slice(0, 24) + "…" : q}"` : "");
}

// own: a line that is itself a stored item (an inbox question): its chip opens that item, its own full text
export function SrcLine({ ids, ctx, children, className, own }: {
  ids: string[] | null; ctx: SrcCtx; children: ReactNode; className?: string; own?: { label: string; open: () => void };
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className={"src-line" + (className ? " " + className : "")} data-src-line={ids?.length || own ? "ok" : "none"}>
      <div className="src-row">
        <div className="src-text">{children}</div>
        <span className="src-chips">
          {own && <button className="src-chip k-own" data-src="own" title="source: this item itself · click to open it" onClick={own.open}>{own.label}</button>}
          {ids?.length
            ? ids.map((id) => (
              <button key={id} className={"src-chip k-" + (srcKind(id) || "bad") + (open === id ? " on" : "")} data-src={id}
                title={`source: ${id} · click to open its full text under the line`} onClick={() => setOpen(open === id ? null : id)}>
                {label(id)}
              </button>
            ))
            : !own && <span className="src-chip none" data-src-missing title="This line names no source yet: its session adds src ids with the next plan version">no source</span>}
        </span>
      </div>
      {open && <div className="src-open" data-src-open={open}><SourceText id={open} ctx={ctx} /></div>}
    </div>
  );
}

function SourceText({ id, ctx }: { id: string; ctx: SrcCtx }) {
  const kind = srcKind(id);
  if (kind === "part") {
    const lines = ctx.parts ? partLines(ctx.parts, id as keyof Parts) : [];
    return <><p className="src-head">plan part · {id}</p><Md text={lines.map((l) => `- ${l}`).join("\n") || "empty"} cwd={ctx.cwd} /></>;
  }
  if (kind === "step") {
    const sid = id.replace(/^step:/, "");
    const def = ctx.parts?.steps.find((s) => s.id === sid);
    const sv = ctx.steps.find((s) => s.stepId === sid);
    // the session's own last report, not the bridge's receipt line that may follow it
    const all = sv?.versions ?? [];
    const own = [...all].reverse().find((x) => !(x as { by?: string }).by);
    const last = own ?? all[all.length - 1];
    const receipt = all.length && all[all.length - 1] !== last ? all[all.length - 1].reply : "";
    return (
      <>
        <p className="src-head">step {sid} · {def?.title ?? ""} · {sv?.state ?? "next"}</p>
        {def && <p className="small muted">{def.does}</p>}
        {last ? <Md text={last.reply} cwd={ctx.cwd} /> : <p className="small muted">no report yet</p>}
        {receipt && <p className="small muted">{receipt.replace(/^-\s*/, "")}</p>}
      </>
    );
  }
  if (kind === "record") return <RecordText id={id} cwd={ctx.cwd} />;
  if (kind === "file") return <FileText id={id} cwd={ctx.cwd} />;
  return <p className="small bad">source id not understood: {id}</p>;
}

function RecordText({ id, cwd }: { id: string; cwd: string }) {
  const [rec, setRec] = useState<Rec | null | undefined>(undefined);
  useEffect(() => {
    getDoc(doc(db, "records", id)).then((s) => { countReads(1, "records"); setRec(s.exists() ? (s.data() as Rec) : null); }, () => setRec(null));
  }, [id]);
  if (rec === undefined) return <p className="small muted">reading {id}…</p>;
  if (rec === null) return <p className="small bad">{id}: no such record</p>;
  const v = rec.versions?.length ? ` · v${rec.versions[rec.versions.length - 1].v}` : "";
  return (
    <>
      <p className="src-head">{rec.id}{v} · {rec.status ?? ""}</p>
      <Md text={rec.text} cwd={cwd} />
      {rec.words && <p className="small"><b>The owner's words:</b> {rec.words}</p>}
      {rec.source && <p className="small muted">source: {rec.source}</p>}
    </>
  );
}

const AROUND = 3;
const HEAD = 40;
const PICTURE = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
const NOT_TEXT = /\.(pdf|html?|mp4|webm|mov)$/i;
function FileText({ id, cwd }: { id: string; cwd: string }) {
  const m = FILE.exec(id)!.groups!;
  if (PICTURE.test(m.path)) return <><p className="src-head">{m.path}</p><LocalImg src={m.path} alt={label(id)} cwd={cwd} /></>;
  if (NOT_TEXT.test(m.path)) return <p className="src-head">{m.path} <button className="link" onClick={() => openFile(m.path, cwd)}>open the file</button></p>;
  return <TextFile id={id} cwd={cwd} />;
}

function TextFile({ id, cwd }: { id: string; cwd: string }) {
  const m = FILE.exec(id)!.groups!;
  let line = m.line ? parseInt(m.line, 10) : 0;
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    ticket(m.path, cwd).then((t) => fetch(t.url)).then((r) => r.text())
      .then((t) => live && setText(t), (e) => live && setErr(String(e?.message ?? e)));
    return () => { live = false; };
  }, [id, cwd]);
  if (err) return <p className="small bad">{label(id)}: could not open ({err})</p>;
  if (text === null) return <p className="small muted">reading {label(id)}…</p>;
  const all = text.split(/\r?\n/);
  const q = quoteOf(m.quote);
  if (q) {
    const at = all.findIndex((l) => l.includes(q));
    if (at < 0) return <p className="small bad">{m.path}: no row holds "{q}" now</p>;
    line = at + 1;
  }
  const from = line ? Math.max(1, line - AROUND) : 1;
  const to = line ? Math.min(all.length, line + AROUND) : Math.min(all.length, HEAD);
  return (
    <>
      <p className="src-head">{m.path}{line ? ` · line ${line} of ${all.length}` : ` · lines 1 to ${to} of ${all.length}`}{" "}
        <button className="link" onClick={() => openFile(m.path, cwd)}>open the whole file</button></p>
      <pre className="src-lines">
        {all.slice(from - 1, to).map((l, i) => (
          <span key={i} className={from + i === line ? "hit" : ""}>{String(from + i).padStart(4)}  {l}{"\n"}</span>
        ))}
      </pre>
    </>
  );
}
