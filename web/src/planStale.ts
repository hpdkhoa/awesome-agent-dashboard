// Does every section of a plan follow its current version? (the owner's words, 2026-11-10: "do the check if every info
// listed out in plan sections got an update when I change something in the plan and generated and result will be
// updated correctly or not"; the pick: "Both": a mark on each section header and a Check plan list with the fix per
// line). Pure, so it is tested without a browser.
import type { HarnessTicks } from "./harness";
import { approved } from "./harness";
import type { Parts, Plan, PlanGenerated, PlanStep, PlanVersion, Run } from "./data";

export type StaleRow = { section: string; ok: boolean; note: string; fix?: string };

const stepText = (p: Parts | undefined, id: string) => {
  const s = p?.steps.find((x) => x.id === id);
  return s ? `${s.title}\n${s.does}\n${s.check}` : "";
};

// The plan version that was current at a moment: the newest version created before it.
export function versionAt(versions: PlanVersion[], iso: string): number {
  const before = versions.filter((v) => v.createdAt <= iso).sort((a, b) => b.n - a.n);
  return before[0]?.n ?? 0;
}

export function staleness(
  plan: Plan, versions: PlanVersion[], ticks: HarnessTicks | null, generated: PlanGenerated | null, steps: PlanStep[], runs: Run[],
): StaleRow[] {
  const cur = versions.find((v) => v.n === plan.current) ?? versions.sort((a, b) => b.n - a.n)[0];
  if (!cur) return [{ section: "parts", ok: false, note: "no version yet", fix: "wait for the plan session's first version" }];
  const rows: StaleRow[] = [{ section: "parts", ok: true, note: `v${cur.n} · current` }];

  const h = cur.harness ?? [];
  if (h.length) {
    const done = h.filter((x) => approved(x, ticks)).length;
    rows.push({ section: "harness", ok: done === h.length, note: `${done} of ${h.length} items approved on v${cur.n}`,
      fix: done === h.length ? undefined : `tick the ${h.length - done} left, or they stay out of Build` });
  } else {
    rows.push({ section: "harness", ok: true, note: "no harness items in this version" });
  }

  const files = generated?.versions?.[`v${cur.n}`] ?? [];
  const earlier = Object.entries(generated?.versions ?? {}).filter(([k, fs]) => Number(k.slice(1)) < cur.n && fs.length).map(([k]) => k);
  if (files.length) rows.push({ section: "generated", ok: true, note: `${files.length} files approved for v${cur.n}` });
  else if (earlier.length) rows.push({ section: "generated", ok: false, note: `files approved for ${earlier.join(", ")}, none for v${cur.n}`, fix: "Generate again on this version, then approve the final result" });
  else rows.push({ section: "generated", ok: true, note: "no generated files yet" });

  const reported = steps.filter((s) => s.versions.length);
  if (!reported.length) rows.push({ section: "results", ok: true, note: "no step has reported yet" });
  for (const s of reported) {
    const last = s.versions[s.versions.length - 1];
    const then = versions.find((v) => v.n === last.planVersion)?.parts;
    const changed = last.planVersion < cur.n && stepText(then, s.stepId) !== stepText(cur.parts, s.stepId);
    const gone = !cur.parts?.steps.some((x) => x.id === s.stepId);
    rows.push({
      section: `results · ${s.stepId}`, ok: !changed && !gone,
      note: gone ? `reported on v${last.planVersion}; the step is no longer in v${cur.n}`
        : changed ? `${last.state} on v${last.planVersion}; the step changed in v${cur.n}`
        : `${last.state} on v${last.planVersion}${last.planVersion < cur.n ? `, unchanged since` : ""}`,
      fix: gone ? "nothing: its report stays in Results" : changed ? "Run step again on the current text" : undefined,
    });
  }

  const msgs = runs.filter((r) => r.planId === plan.id && r.kind && r.action === "message").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const m = msgs[0];
  if (m) {
    const answered = versions.some((v) => v.createdAt > m.createdAt);
    const live = m.status === "new" || m.status === "waiting" || m.status === "running";
    rows.push({
      section: "last message", ok: live || answered || m.kind === "qa" || m.kind === "lesson",
      note: `${m.kind} · ${m.status}${answered ? ` · answered with v${versionAt(versions, "9999")}` : ""}`,
      fix: live ? undefined : answered || m.kind === "qa" || m.kind === "lesson" ? undefined : "the session made no new version for it: send it again or read its reply",
    });
  }
  return rows;
}

// The mark for one section header: the first stale row of that section, or nothing.
export const staleMark = (rows: StaleRow[], section: string) =>
  rows.find((r) => !r.ok && (r.section === section || r.section.startsWith(section + " ")))?.note;
