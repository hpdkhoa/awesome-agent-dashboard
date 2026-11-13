import { useEffect, useState } from "react";
import { registry, setPlugged, type Box } from "./bridge";
import { reloadBoxes, useSource } from "./fs";

// The boxes that run a bridge (the owner's words, 2026-11-13: "make it in the way I can plug and play another box in
// this dashboard, same with unplug"). Each bridge registers itself; the owner plugs it in or out here. An unplugged
// box keeps its data and its bridge: the page only stops asking it.

const ago = (iso?: string) => {
  if (!iso) return "never seen";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 90 ? "seen now" : s < 5400 ? `seen ${Math.round(s / 60)} min ago` : s < 172800 ? `seen ${Math.round(s / 3600)} h ago` : `seen ${Math.round(s / 86400)} d ago`;
};

export function Boxes() {
  const [list, setList] = useState<Box[] | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const { source, boxes: live } = useSource();
  useEffect(() => {
    registry().then(setList, () => setList([]));
  }, []);
  const act = (name: string, p: Promise<Box[]>) => {
    setBusy(name);
    setError("");
    p.then(setList).then(reloadBoxes).catch((e) => setError(String((e as Error).message ?? e))).finally(() => setBusy(""));
  };
  return (
    <div className="boxes">
      {list === null && <p className="muted small">loading</p>}
      {list?.length === 0 && (
        <p className="muted small">No box has registered yet. A bridge registers itself once it keeps its data locally; until then the page uses the one address it knows.</p>
      )}
      {list?.map((b) => {
        const up = live.find((x) => x.url === b.url)?.up;
        const state = b.plugged === false ? "unplugged" : b.db !== "local" ? "data on Firestore" : up === false ? "off" : "on";
        return (
          <div key={b.name} className="ucheck">
            <div className="ucheck-head">
              <span>
                <span className={"status " + (state === "on" ? "running" : state === "off" ? "failed" : "waiting")}>{state}</span>{" "}
                <b>{b.name}</b>
              </span>
              {b.plugged === false ? (
                <button className="primary" disabled={busy === b.name} onClick={() => act(b.name, setPlugged(b.name, true))}>Plug in</button>
              ) : (
                <button disabled={busy === b.name} onClick={() => act(b.name, setPlugged(b.name, false))}>Unplug</button>
              )}
            </div>
            <p className="small muted">{b.url.replace(/^https?:\/\//, "")} · {ago(b.seenAt)}</p>
          </div>
        );
      })}
      {error && <p className="bad small">{error}</p>}
      <p className="small muted">
        {source === "backup" ? "Every box is off: the page shows the Firestore backup, read-only. " : ""}
        on: the page reads and writes this box · off: its records are missing until its bridge answers · unplugged: left out, its data stays on the box.{" "}
        <button className="link" onClick={() => act("", registry(true))}>Refresh</button>
      </p>
      <p className="small muted">
        Add a box: install the bridge there, sign in, set its FILES_URL (its own tunnel address), run <code>python -m agent_bridge init-local</code>, start it. It shows here by itself.
      </p>
    </div>
  );
}
