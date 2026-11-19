// F8, claims across boxes (plan bf73af63; the step: "a session claims a step or folder; shown on the page; a second
// box is refused"): a claimed step shows which box holds it, for which run or session, since when. The owner's words,
// 2026-11-19: "dead box need both expiry and button": the bridge lets a dead box's claim expire (claims.py), and
// Release here frees it by hand.
import { useState } from "react";
import { deleteDoc as fbDelete, doc as fbDoc } from "firebase/firestore";
import { db } from "./firebase";
import { deleteDoc, doc } from "./fs";
import type { Claim } from "./data";
import { dt } from "./fmt";

const who = (c: Claim) => (c.by === "run" ? `run ${c.runId.slice(0, 8)}` : `session ${c.sessionId.slice(0, 8)}`);

export function ClaimChip({ c }: { c?: Claim }) {
  if (!c) return null;
  return (
    <span className="claim-chip" data-claim={c.key} data-box={c.machine}
      title={`Claimed by box ${c.machine} for ${who(c)} since ${dt(c.at)}: a run of this step on another box is refused`}>
      claimed · {c.machine} · {who(c)}
    </span>
  );
}

// The claim on the control plane (Firestore claims/<key>) and the box's copy (boxClaims/<key>, on that box).
export async function releaseClaim(c: Claim): Promise<void> {
  await fbDelete(fbDoc(db, "claims", c.key));
  await deleteDoc(doc(db, "boxClaims", c.key)).catch(() => undefined); // a dead box does not answer: its copy waits
}

export function ClaimLine({ c }: { c?: Claim }) {
  const [state, setState] = useState("");
  if (!c) return null;
  const go = () => {
    setState("busy");
    releaseClaim(c).then(() => setState("released"), (e) => setState(`not released: ${String(e?.message ?? e)}`));
  };
  return (
    <p className="small claim-line" data-claim-line={c.key}>
      <ClaimChip c={c} />{" "}
      <span className="muted">since {dt(c.at)}; another box's run of this step is refused. A dead box's claim expires
        after 30 minutes without its heartbeat.</span>{" "}
      {state === "asking" ? (
        <>
          <button className="primary" data-release-confirm onClick={go}>Release now</button>{" "}
          <button onClick={() => setState("")}>Keep</button>
        </>
      ) : state === "busy" ? <span className="muted">releasing…</span>
        : state === "released" ? <span>released</span>
        : <button data-release onClick={() => setState("asking")} title="Free the step: delete this claim">Release</button>}
      {state.startsWith("not released") && <span className="bad"> {state}</span>}
    </p>
  );
}
