import { useEffect, useState } from "react";
import type { QueryDocumentSnapshot } from "firebase/firestore";
import { MoreMenu } from "./MoreMenu";
import { COLLECTIONS, countAll, listPage, removeRows, type Row } from "./storeData";

const kb = (n: number) => (n < 1024 ? n + " B" : (n / 1024).toFixed(1) + " KB");
const cell = (v: unknown) => {
  const s = typeof v === "string" ? v : v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.length > 60 ? s.slice(0, 60) + "…" : s;
};

export function StorageSide({ picked, onPick }: { picked: string; onPick: (name: string) => void }) {
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [error, setError] = useState("");
  const load = () => {
    setError("");
    countAll().then(setCounts, (e) => setError(String(e.code ?? e)));
  };
  useEffect(load, []);
  return (
    <div className="pad">
      <ul className="list">
        {COLLECTIONS.map((c) => (
          <li key={c.name} className={c.name === picked ? "row on" : "row"} onClick={() => onPick(c.name)}>
            <div className="grow">
              <div className="title">{c.label}</div>
              <div className="muted small">
                {c.name} · {counts ? counts[c.name].toLocaleString() + " docs" : "counting"}
                {c.bridge && " · stays deleted"}
              </div>
            </div>
          </li>
        ))}
      </ul>
      {error && <p className="bad small">{error}</p>}
      <button className="link" onClick={load}>
        Count again
      </button>
    </div>
  );
}

export function StorageView({ name }: { name: string }) {
  const c = COLLECTIONS.find((x) => x.name === name)!;
  const [rows, setRows] = useState<Row[]>([]);
  const [last, setLast] = useState<QueryDocumentSnapshot | undefined>();
  const [more, setMore] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function page(after?: QueryDocumentSnapshot) {
    setBusy(true);
    try {
      const r = await listPage(name, after);
      setRows((old) => (after ? [...old, ...r.rows] : r.rows));
      setLast(r.last);
      setMore(r.more);
    } catch (e) {
      setMsg(String((e as { code?: string }).code ?? e));
    }
    setBusy(false);
  }
  useEffect(() => {
    setRows([]);
    setSel(new Set());
    setMsg("");
    page();
  }, [name]);

  const toggle = (p: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });
  const allOn = rows.length > 0 && rows.every((r) => sel.has(r.path));
  const picked = rows.filter((r) => sel.has(r.path));
  const total = rows.reduce((a, r) => a + r.bytes, 0);

  async function remove() {
    const note = c.bridge ? " The bridge will not write them again." : "";
    if (!window.confirm(`Delete ${picked.length} documents from ${name}?${note} This cannot be undone.`)) return;
    setBusy(true);
    try {
      await removeRows(name, picked.map((r) => r.path));
      setRows((rs) => rs.filter((r) => !sel.has(r.path)));
      setMsg(`Deleted ${picked.length} documents (${kb(picked.reduce((a, r) => a + r.bytes, 0))}).`);
      setSel(new Set());
    } catch (e) {
      setMsg(String((e as { code?: string }).code ?? e));
    }
    setBusy(false);
  }

  return (
    <article>
      <h1>{c.label}</h1>
      <p className="meta">
        {name} · {rows.length} shown{more ? " (more below)" : ""} · {kb(total)} by Firestore's size rules
        {c.bridge && " · deleted documents stay deleted: the bridge skips them"}
      </p>
      <div className="actions">
        <button className="primary" disabled={busy || picked.length === 0} onClick={remove}>
          Delete {picked.length || ""} selected
        </button>
        {msg && <span className="small">{msg}</span>}
      </div>
      <table className="store">
        <thead>
          <tr>
            <td>
              <input type="checkbox" checked={allOn} onChange={() => setSel(allOn ? new Set() : new Set(rows.map((r) => r.path)))} />
            </td>
            <td>id</td>
            {c.show.map((f) => (
              <td key={f}>{f}</td>
            ))}
            <td className="num">size</td>
            <td></td>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.path} onClick={() => toggle(r.path)} className={sel.has(r.path) ? "on" : ""}>
              <td>
                <input type="checkbox" checked={sel.has(r.path)} onChange={() => toggle(r.path)} onClick={(e) => e.stopPropagation()} />
              </td>
              <td className="small">{cell(r.id)}</td>
              {c.show.map((f) => (
                <td key={f} className="small">
                  {cell(r.data[f])}
                </td>
              ))}
              <td className="num small">{kb(r.bytes)}</td>
              {/* a heartbeat goes only with its session: deleted alone, the bridge would take an open session as closed
                  (the owner's choice, 2026-11-03: "take heartbeats off the menu") */}
              <td>{name !== "liveSessions" && <MoreMenu path={r.path} onDeleted={() => page()} />}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && !busy && <p className="muted">Empty.</p>}
      {more && (
        <button disabled={busy} onClick={() => page(last)}>
          Show 50 more
        </button>
      )}
    </article>
  );
}
