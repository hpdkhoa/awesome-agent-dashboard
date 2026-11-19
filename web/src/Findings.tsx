// F5, review findings with dispositions (plan bf73af63, the step: "extend the evidence LLM check: findings list, each
// confirmed / rejected / fixed with a reason"; rules-review.md: "Validate each finding first, fix every confirmed one
// ... and record each disposition"). The LLM check's findings, each with its disposition and the reason.
import type { EvidenceFinding } from "./data";
import { dt } from "./fmt";

const ORDER = { confirmed: 0, fixed: 1, rejected: 2 } as const;

export function findingCount(f?: EvidenceFinding[]) {
  const n = (d: EvidenceFinding["disposition"]) => (f ?? []).filter((x) => x.disposition === d).length;
  return { confirmed: n("confirmed"), rejected: n("rejected"), fixed: n("fixed"), total: (f ?? []).length };
}

export function Findings({ findings }: { findings?: EvidenceFinding[] }) {
  if (!findings) return null;
  const c = findingCount(findings);
  const list = [...findings].sort((a, b) => ORDER[a.disposition] - ORDER[b.disposition] || a.id.localeCompare(b.id, undefined, { numeric: true }));
  return (
    <div className="findings" data-findings={c.total}>
      <b className="small">Findings</b>{" "}
      <span className="small muted">
        {c.total === 0 ? "none: the check found nothing wrong" : `${c.confirmed} confirmed · ${c.fixed} fixed · ${c.rejected} rejected`}
      </span>
      {c.total > 0 && (
        <ul className="findings-list small">
          {list.map((f) => (
            <li key={f.id} data-disposition={f.disposition}>
              <span className={"disp-chip " + f.disposition}>{f.disposition}</span>{" "}
              <b>{f.id}</b> {f.text}
              {f.picture && <span className="muted"> · {f.picture.split(/[\\/]/).pop()}</span>}
              <div className="muted">why: {f.why || "no reason given"} · {dt(f.at)}{f.raised !== f.at ? ` · raised ${dt(f.raised)}` : ""}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
