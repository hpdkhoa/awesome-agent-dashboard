// hayaku avatar packs (the owner's picks, 2026-11-17: "B+file", "only pictures", "Local only"): the bridge PC keeps
// named sets of the four status pictures (bridge avatarpacks.py, POST /packs). Here the owner sees them, uploads and
// downloads .hayaku files to share, renames, deletes, and picks the one hayaku shows ("Use on hayaku"; hayaku loads it
// within 30 s). Pictures stay on the bridge PC; a .hayaku download is their backup.
import { useEffect, useRef, useState } from "react";
import { bridgePost } from "./bridge";
import { dt } from "./fmt";

const STATUSES = [["in_progress", "In progress"], ["done", "Done"], ["offline", "Offline"], ["needs_you", "Needs you"]] as const;
type Pack = { id: string; name: string; created: number; updated: number; statuses: Record<string, { ext: string; size: number }> };
type List = { packs: Pack[]; current: { id: string | null; at: number } | null };

const call = <T,>(body: unknown) => bridgePost<T>("/packs", body);
const mb = (n: number) => (n / 1024 / 1024).toFixed(n < 1024 * 1024 ? 2 : 1) + " MB";

function fileB64(f: File): Promise<string> {
  return new Promise((ok, bad) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => bad(r.error);
    r.readAsDataURL(f);
  });
}

function download(name: string, b64: string) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
  a.download = name.replace(/[\\/:*?"<>|]/g, "_") + ".hayaku";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function Card({ p, current, busy, act }: { p: Pack; current: boolean; busy: boolean; act: (op: string, p: Pack) => void }) {
  const [pics, setPics] = useState<Record<string, string> | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    call<{ pictures: Record<string, string> }>({ op: "pictures", id: p.id })
      .then((r) => live && setPics(r.pictures), (e) => live && setErr(String(e.message ?? e)));
    return () => { live = false; };
  }, [p.id, p.updated]);
  const size = Object.values(p.statuses).reduce((a, s) => a + s.size, 0);
  return (
    <div className={current ? "pack on" : "pack"}>
      <div className="pack-head">
        <b>{p.name}</b>
        {current && <span className="chip on primary">On hayaku</span>}
        <span className="small muted">{Object.keys(p.statuses).length} of 4 pictures · {mb(size)} · {dt(p.updated * 1000)}</span>
      </div>
      <div className="pack-pics">
        {STATUSES.map(([k, label]) => (
          <figure key={k}>
            {p.statuses[k] ? (pics?.[k] ? <img src={pics[k]} alt={label} /> : <div className="pack-empty">{err ? "!" : "…"}</div>)
              : <div className="pack-empty" title="no picture: hayaku shows its robot">robot</div>}
            <figcaption className="small">{label}</figcaption>
          </figure>
        ))}
      </div>
      {err && <p className="small bad">{err}</p>}
      <div className="pack-acts">
        <button className={current ? "chip" : "chip primary"} disabled={busy || current} onClick={() => act("select", p)}>Use on hayaku</button>
        <button className="chip" disabled={busy} onClick={() => act("get", p)}>Download .hayaku</button>
        <button className="chip" disabled={busy} onClick={() => act("rename", p)}>Rename</button>
        <button className="chip danger" disabled={busy} onClick={() => act("delete", p)}>Delete</button>
      </div>
    </div>
  );
}

export function AvatarPacks() {
  const [list, setList] = useState<List | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const load = () => call<List>({ op: "list" }).then(setList, (e) => setMsg(String(e.message ?? e)));
  useEffect(() => { void load(); }, []);

  const run = async (what: string, f: () => Promise<unknown>) => {
    setBusy(true);
    setMsg("");
    try {
      await f();
      setMsg(what);
      await load();
    } catch (e) {
      setMsg(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };
  const act = (op: string, p: Pack) => {
    if (op === "select") void run(`hayaku shows "${p.name}" within 30 s.`, () => call({ op: "select", id: p.id }));
    if (op === "get") void run(`Downloaded ${p.name}.hayaku.`, async () => download(p.name, (await call<{ zip: string }>({ op: "get", id: p.id })).zip));
    if (op === "rename") {
      const name = prompt("New name", p.name)?.trim();
      if (name && name !== p.name) void run(`Renamed to ${name}.`, () => call({ op: "rename", id: p.id, name }));
    }
    if (op === "delete" && confirm(`Delete the pack "${p.name}"? Its pictures leave the bridge PC (download it first to keep a copy).`))
      void run(`Deleted ${p.name}.`, () => call({ op: "delete", id: p.id }));
  };
  const upload = (f?: File) => {
    if (file.current) file.current.value = "";
    if (!f) return;
    if (f.size > 80 * 1024 * 1024) return setMsg(`${f.name} is ${mb(f.size)}: a pack is 80 MB at most.`);
    void run(`Added ${f.name}.`, async () => call({ op: "put", zip: await fileB64(f) }));
  };
  const cur = list?.current?.id ?? null;

  return (
    <>
      <p className="small muted">Packs live on the bridge PC (pictures only, never on Firestore). Share one as a .hayaku file; hayaku also saves its current pictures as a pack from its Avatar menu.</p>
      <div className="pack-acts">
        <button className="chip primary" disabled={busy} onClick={() => file.current?.click()}>Upload .hayaku</button>
        <input ref={file} type="file" accept=".hayaku,application/zip" hidden onChange={(e) => upload(e.target.files?.[0])} />
        <button className="chip" disabled={busy || !cur} onClick={() => void run("hayaku keeps its own pictures from now.", () => call({ op: "select", id: null }))}>Stop following a pack</button>
        <button className="chip" disabled={busy} onClick={() => void load()}>Refresh</button>
      </div>
      {msg && <p className="small">{msg}</p>}
      {!list ? <p className="small muted">Loading…</p>
        : !list.packs.length ? <p className="small muted">No pack yet. Upload a .hayaku file, or use hayaku's Avatar › Save current as pack.</p>
        : list.packs.map((p) => <Card key={p.id} p={p} current={p.id === cur} busy={busy} act={act} />)}
    </>
  );
}
