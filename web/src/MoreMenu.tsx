import { useEffect, useRef, useState } from "react";
import { deleteRecords, linkedRecords, stopRunning, type Linked } from "./links";

// The "..." button on every record the page stores in Firestore (the owner's words, 2026-11-03: "every item that store
// in firestore will have a "..." button, inside it will have the first button is delete record from firestore").
export function MoreMenu({ path, onDeleted }: { path: string; onDeleted?: () => void }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Linked[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  async function ask() {
    setOpen(false);
    setBusy(true);
    setError("");
    try {
      setList(await linkedRecords(path));
    } catch (e) {
      setError(String((e as { code?: string }).code ?? e));
    }
    setBusy(false);
  }
  async function remove() {
    setBusy(true);
    try {
      await stopRunning(list!);
      await deleteRecords(list!.map((x) => x.path));
      setList(null);
      onDeleted?.();
    } catch (e) {
      setError(String((e as { code?: string }).code ?? e));
    }
    setBusy(false);
  }

  const running = list?.filter((x) => x.running !== undefined).length ?? 0;
  const inApp = list?.filter((x) => x.openInApp).length ?? 0;
  return (
    <span className="more" ref={box} onClick={(e) => e.stopPropagation()}>
      <button className="more-btn" aria-label="More" disabled={busy} onClick={() => setOpen(!open)}>…</button>
      {open && (
        <span className="more-menu" role="menu">
          <button role="menuitem" className="bad" onClick={ask}>Delete record</button>
        </span>
      )}
      {error && !list && <span className="bad small"> {error}</span>}
      {list && (
        <div className="modal-back" onClick={() => !busy && setList(null)}>
          <div className="modal" role="dialog" aria-label="Delete records" onClick={(e) => e.stopPropagation()}>
            <h3>Delete {list.length === 1 ? "this record" : `${list.length} records`}?</h3>
            {running > 0 && <p className="wait-fg">{running} running, will be stopped.</p>}
            {inApp > 0 && (
              <p className="bad small">
                {inApp === 1 ? "1 session is" : `${inApp} sessions are`} open in the Claude app. The dashboard can't stop
                it: it keeps working and can still post new questions. Close it in the app.
              </p>
            )}
            {list.length > 1 && <p className="small muted">The record and the records linked to it:</p>}
            <ul className="del-list">
              {list.map((x) => (
                <li key={x.path}>
                  <code>{x.path}</code> {x.label && <span className="small muted">{x.label}</span>}
                  {x.running !== undefined && <span className="wait-fg small"> · running, will be stopped</span>}
                  {x.openInApp && <span className="bad small"> · open in the Claude app</span>}
                </li>
              ))}
            </ul>
            <p className="small muted">Files on your PC and Claude Code's logs stay. This cannot be undone.</p>
            {error && <p className="bad small">{error}</p>}
            <div className="row-btns">
              <button disabled={busy} onClick={() => setList(null)}>Cancel</button>
              <button className="danger" disabled={busy} onClick={remove}>{busy ? "Deleting" : `Delete ${list.length}`}</button>
            </div>
          </div>
        </div>
      )}
    </span>
  );
}
