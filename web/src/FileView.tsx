import { useEffect, useState } from "react";
import { auth } from "./firebase";
import { bridgePost, filesUrl } from "./bridge";
export { bridgePost, filesUrl } from "./bridge";
import { Md } from "./Markdown";

// The file viewer (the owner's idea, 2026-11-01: "just move binary to render it on the page using my local instance").
// A tap on a file path asks the bridge on the owner's PC, through the owner's Cloudflare Tunnel, for a 10-minute
// ticket, and the page shows the file from there (bridge/agent_bridge/files.py). Nothing is stored in Firestore: only
// the viewer's address, meta/files.

export type Ticket = { url: string; name: string; path: string; kind: string; size: number; dir: string };
type Ask = { path: string; cwd: string };

const TEXT_MAX = 2 * 1024 * 1024;
const EVENT = "aad.openFile";


export async function ticket(path: string, cwd: string): Promise<Ticket> {
  const url = await filesUrl();
  if (!url) throw new Error("The file viewer is off: set FILES_URL on the bridge.");
  const token = await auth.currentUser?.getIdToken();
  let r: Response;
  try {
    r = await fetch(url + "/ticket", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ path, cwd }),
    });
  } catch {
    throw new Error("The PC does not answer: is the bridge running and the tunnel up?");
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `The bridge answered ${r.status}.`);
  return { ...j, url: url + j.url };
}

// The whole text of a session's turn or of a run's result, read from the PC and never stored (the owner's words,
// 2026-11-08: "do option 3, the dashboard only load the file stored on the PC ... make sure the result is captured fully
// inside my PC so the file render completed result from each message turn"): bridge/agent_bridge/texts.py.
export type PcTurn = { n: number; at: string; prompt: string; chars: number };
export type PcReply = { text: string; chars: number; n?: number; at?: string; prompt?: string; turns?: PcTurn[]; isError?: boolean };

// One signed call to the bridge on the PC (POST /text, POST /usage): the answer is shown, never stored.

export type PcReplyRef = { session: string; item: string; k: number };
export const pcText = (body: { session?: string; turn?: number; run?: string; reply?: PcReplyRef }) => bridgePost<PcReply>("/text", body);

// The running turn, streamed by claude into the run's .out on the PC (step i3, the owner's choice, 2026-11-12: "Token
// stream"): asked every 2 s while the run is running, shown, never stored (no Firestore write).
export type PcLive = { text: string; chars: number; cut: boolean; tools: number; started: boolean; done: boolean };
export const LIVE_EVERY_MS = 2000;
export const pcLive = (run: string) => bridgePost<PcLive>("/text", { live: run });

export function LiveText({ run, cwd }: { run: string; cwd: string }) {
  const [got, setGot] = useState<PcLive | string | null>(null);
  useEffect(() => {
    let on = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = () =>
      pcLive(run)
        .then((r) => on && setGot(r), (e) => on && setGot(String(e.message ?? e)))
        .finally(() => {
          if (on) timer = setTimeout(ask, LIVE_EVERY_MS);
        });
    ask();
    return () => {
      on = false;
      clearTimeout(timer);
    };
  }, [run]);
  if (typeof got === "string") return <p className="muted small">{got}</p>;
  if (!got) return <p className="muted small">asking the PC</p>;
  if (!got.started) return <p className="muted small">claude is starting on the PC</p>;
  return (
    <div className="live-text">
      <p className="small muted">
        live from the PC · {got.chars.toLocaleString()} chars · {got.tools} tool {got.tools === 1 ? "call" : "calls"}
        {got.cut ? " · the last 8,000 chars" : ""}
      </p>
      {got.text ? <Md text={got.text} cwd={cwd} /> : <p className="muted small">thinking</p>}
    </div>
  );
}

// A session's reply (any turn, the last one first) or a run's result, whole, from the PC.
export function PcText({ session, run, reply, cwd }: { session?: string; run?: string; reply?: PcReplyRef; cwd: string }) {
  const [turn, setTurn] = useState<number | undefined>(undefined);
  const [got, setGot] = useState<PcReply | string | null>(null);
  useEffect(() => {
    setGot(null);
    pcText(reply ? { reply } : session ? { session, turn } : { run }).then(setGot, (e) => setGot(String(e.message ?? e)));
  }, [session, run, turn, reply?.session, reply?.item, reply?.k]);
  if (typeof got === "string") return <p className="muted small">{got}</p>;
  if (!got) return <p className="muted small">loading from the PC</p>;
  const total = got.turns?.length ?? 0;
  return (
    <div>
      {session && got.n != null && (
        <p className="small muted">
          <button disabled={got.n <= 1} onClick={() => setTurn(got.n! - 1)} aria-label="earlier turn">
            ‹
          </button>{" "}
          turn {got.n} of {total} · {got.at ? new Date(got.at).toLocaleString() : ""} · {got.chars.toLocaleString()} chars{" "}
          <button disabled={got.n >= total} onClick={() => setTurn(got.n! + 1)} aria-label="later turn">
            ›
          </button>
          {got.prompt && <> · asked: {got.prompt}</>}
        </p>
      )}
      {run && <p className="small muted">{got.chars.toLocaleString()} chars, whole, from the PC</p>}
      <Md text={got.text} cwd={cwd} />
    </div>
  );
}

// A link or a path a session wrote that points at a file on the PC, not a web page.
export const isLocal = (href?: string) =>
  !!href && !href.startsWith("#") && (/^[a-zA-Z]:[\\/]/.test(href) || href.startsWith("file:") || !/^[a-z][a-z0-9+.-]*:/i.test(href));

const FILE_RE = /^[\w.\-\\/:~ ]+\.(png|jpe?g|gif|webp|svg|avif|html?|pdf|md|mp4|webm|mov|txt|log|json|csv|py|ts|tsx|go)(:\d+)?$/i;
export const looksLikeFile = (s: string) => FILE_RE.test(s) && /[\\/.]/.test(s);

export const openFile = (path: string, cwd: string) => window.dispatchEvent(new CustomEvent<Ask>(EVENT, { detail: { path, cwd } }));

const size = (n: number) => (n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + " MB" : Math.ceil(n / 1024) + " KB");

// An image a session put in markdown with a local path.
export function LocalImg({ src, alt, cwd }: { src: string; alt?: string; cwd: string }) {
  const [t, setT] = useState<Ticket | string | null>(null);
  useEffect(() => {
    ticket(src, cwd).then(setT, (e) => setT(String(e.message ?? e)));
  }, [src, cwd]);
  if (typeof t === "string") return <span className="muted small">[{alt || src}: {t}]</span>;
  if (!t) return <span className="muted small">[{alt || src}: loading]</span>;
  return <img className="md-img" src={t.url} alt={alt} onClick={() => openFile(src, cwd)} />;
}

function Body({ t }: { t: Ticket }) {
  const [text, setText] = useState<string | null>(null);
  const wantsText = (t.kind === "md" || t.kind === "text") && t.size <= TEXT_MAX;
  useEffect(() => {
    if (wantsText) fetch(t.url).then((r) => r.text()).then(setText, () => setText("Could not read the file."));
  }, [t.url, wantsText]);
  if (t.kind === "image") return <img className="viewer-img" src={t.url} alt={t.name} />;
  if (t.kind === "html") return <iframe className="viewer-frame" src={t.url} sandbox="allow-scripts allow-forms allow-popups allow-modals" title={t.name} />;
  if (t.kind === "pdf") return <iframe className="viewer-frame" src={t.url} title={t.name} />;
  if (t.kind === "video") return <video className="viewer-img" src={t.url} controls />;
  if (wantsText) {
    if (text === null) return <p className="muted">Loading</p>;
    return t.kind === "md" ? <Md text={text} cwd={t.dir} /> : <pre className="viewer-text">{text}</pre>;
  }
  return (
    <p>
      No preview for this kind of file. <a href={t.url} download={t.name}>Download {t.name}</a>
    </p>
  );
}

// Mounted once on the page; any Md or file list opens it with openFile().
export function FileViewer() {
  const [ask, setAsk] = useState<Ask | null>(null);
  const [t, setT] = useState<Ticket | string | null>(null);
  useEffect(() => {
    const on = (e: Event) => setAsk((e as CustomEvent<Ask>).detail);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  useEffect(() => {
    if (!ask) return;
    setT(null);
    ticket(ask.path, ask.cwd).then(setT, (e) => setT(String(e.message ?? e)));
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setAsk(null);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [ask]);
  if (!ask) return null;
  return (
    <div className="viewer" role="dialog" aria-label="File">
      <div className="viewer-head">
        <span className="viewer-name">
          <b>{typeof t === "object" && t ? t.name : ask.path}</b>
          {typeof t === "object" && t && (
            <span className="muted small"> {t.path} · {size(t.size)}</span>
          )}
        </span>
        {typeof t === "object" && t && (
          <a href={`${t.url}?download=1`} download={t.name} rel="noopener noreferrer">Download</a>
        )}
        <button onClick={() => setAsk(null)}>Close</button>
      </div>
      <div className="viewer-body">
        {t === null ? <p className="muted">Asking the PC</p> : typeof t === "string" ? <p className="bad">{ask.path}: {t}</p> : <Body t={t} />}
      </div>
    </div>
  );
}
