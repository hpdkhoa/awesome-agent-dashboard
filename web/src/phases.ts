// The plan's phases: where the plan is (the owner's words, 2026-11-04). Every plan starts in Explore; only the owner
// moves a phase, forward or back; each move is a plain plan version, and every version carries its phase, so a
// version list shows a divider where the phase changes ("when I read the version I can see the delimiter with each
// phase"). A plan or version saved before phases existed counts as Explore.
import type { Plan, PlanVersion } from "./data";

export type Phase = "explore" | "build" | "verify" | "remove" | "optimize";

export const PHASES: { id: Phase; name: string; means: string }[] = [
  { id: "explore", name: "Explore", means: "this phase the plan is mainly used for summarize, deeper in details, pivot and validate the idea." },
  { id: "build", name: "Build", means: "this is when the plan is approve, no more concerns in design and idea. the result of build phase will be the MVP according to the approved plan." },
  { id: "verify", name: "Verify", means: "this phase is the A/B testing, benchmark, UAT testing, etc... Do every thing to test and benchmark the MVP result in Build phase." },
  { id: "remove", name: "Remove", means: "this phase I'll test, look back, pivot and can remove some feature, tune the MVP, tune the plan, remove anything inside a plan and MVP to make the sub-final product." },
  { id: "optimize", name: "Optimize", means: "this phase is sorely used for hardening the MVP to make it come to the state of the art to ready for production or mass user testing." },
];

export const phaseOf = (x: Pick<Plan, "phase"> | Pick<PlanVersion, "phase"> | undefined): Phase => x?.phase ?? "explore";
export const phaseName = (p: Phase) => PHASES.find((x) => x.id === p)?.name ?? p;

// The versions, in number order, where a new phase begins (the first version always begins one).
export function phaseStarts(versions: PlanVersion[]): Map<number, Phase> {
  const out = new Map<number, Phase>();
  let last: Phase | null = null;
  for (const v of [...versions].sort((a, b) => a.n - b.n)) {
    const p = phaseOf(v);
    if (p !== last) out.set(v.n, p);
    last = p;
  }
  return out;
}

// The owner's order the Move button sends to the plan's session (it records a plain version with plan_version).
export const phaseOrder = (to: Phase) => `Move the plan to phase ${phaseName(to)}.`;
export const phasePrompt = (to: Phase) =>
  `${phaseOrder(to)} Record it with plan_version(phase="${to}", order="${phaseOrder(to)}") and no text or parts: a plain version.`;
