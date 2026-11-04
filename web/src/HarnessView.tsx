import { useState } from "react";
import { tickHarness, useHarness, type Plan, type PlanVersion } from "./data";
import { approved, harnessCount, harnessLine } from "./harness";
import { diffLines } from "./planDiff";
import { phaseOf } from "./phases";
import { Section } from "./Section";

// The harness section (harness.ts; this file is HarnessView, not Harness, so it never clashes with harness.ts on a case-blind disk): the list as it is in one version, its diff from the parent version, and the
// owner's checkbox on each item. Only the current version's items can be ticked: a tick approves what is current.
export function HarnessSection({ plan, v, parent }: { plan: Plan; v: PlanVersion; parent?: PlanVersion }) {
  const ticks = useHarness(plan.id);
  const [diff, setDiff] = useState(false);
  const [error, setError] = useState("");
  const list = v.harness ?? [];
  const before = parent?.harness ?? [];
  const { done, all } = harnessCount(list, ticks);
  const current = v.n === plan.current;
  const changed = diffLines(before.map(harnessLine), list.map(harnessLine)).filter((l) => l.op !== "same");
  return (
    <Section id="plan.harness" title="Harness" extra={all ? `${done} of ${all} approved` : "none yet"}>
      {all === 0 && <p className="muted small">No harness yet. The session lists it in Explore: the tools and context each step needs, and each step's check.</p>}
      {parent && changed.length > 0 && (
        <button className={diff ? "chip on" : "chip"} onClick={() => setDiff(!diff)}>Changes from v{parent.n} ({changed.length})</button>
      )}
      {diff && (
        <pre className="diff">
          {changed.map((l, i) => (
            <div key={i} className={l.op === "add" ? "in" : "bad"}>{l.op === "add" ? "+ " : "- "}{l.text}</div>
          ))}
        </pre>
      )}
      <ul className="harness">
        {list.map((h) => {
          const ok = approved(h, ticks);
          return (
            <li key={h.id}>
              <label>
                <input type="checkbox" checked={ok} disabled={!current || ticks === null}
                  onChange={(e) => tickHarness(plan.id, h, e.target.checked, v.n).catch((x) => setError(String(x?.code ?? x)))} />{" "}
                <b>{h.id}</b> <span className="tag">{h.kind}</span> {h.item}
                {!ok && phaseOf(plan) !== "explore" && <span className="small bad"> · not approved: left out of Build</span>}
              </label>
            </li>
          );
        })}
      </ul>
      {all > 0 && <p className="muted small">An unticked item is not approved: Move to Build still works, and the item stays out of Build.</p>}
      {!current && all > 0 && <p className="muted small">An older version: tick items on the current version, v{plan.current}.</p>}
      {error && <p className="bad small">{error}</p>}
    </Section>
  );
}
