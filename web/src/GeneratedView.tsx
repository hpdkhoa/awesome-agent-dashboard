import { usePlanGenerated, type Plan, type PlanVersion } from "./data";
import { LocalImg, openFile } from "./FileView";
import { kindName, KINDS, type Kind } from "./planCheck";
import { Section } from "./Section";

// The plan's Generated section (the owner's words, 2026-11-04: "not new version because the generated just is the
// artifact to visualize the plan, it is the supplement for the current version so make another section display (like
// the other 6 or 7 header that collapsible and professional work for generated inside the plan and misc at the end").
// The approved files of the version shown, from planGenerated/<plan id>, one fold per kind; pictures show inline.
const PIC = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;

export function GeneratedSection({ plan, v }: { plan: Plan; v: PlanVersion }) {
  const rec = usePlanGenerated(plan.id);
  const files = rec?.versions?.[`v${v.n}`] ?? [];
  // earlier versions' files stay with their own version; listed closed, newest first
  const earlier = Object.entries(rec?.versions ?? {})
    .filter(([key, fs]) => Number(key.slice(1)) < v.n && fs.length)
    .sort((a, b) => Number(b[0].slice(1)) - Number(a[0].slice(1)));
  const kinds = [...new Set(files.map((f) => f.kind))].sort(
    (a, b) => KINDS.findIndex((k) => k.id === a) - KINDS.findIndex((k) => k.id === b));
  return (
    <Section id="plan.generated" title="Generated" extra={files.length ? `${files.length} approved · supplement to v${v.n}` : `none for v${v.n}`}>
      {files.length === 0 && <p className="muted small">No approved files for this version. Generate, then approve the final result.</p>}
      {earlier.length > 0 && (
        <details className="gen-kind">
          <summary><b>Earlier versions</b> <span className="small muted">{earlier.reduce((n, [, fs]) => n + fs.length, 0)}</span></summary>
          {earlier.map(([key, fs]) => (
            <p key={key} className="small">
              {key}:{" "}
              {fs.map((f) => (
                <code key={f.file} className="file-link" role="button" onClick={() => openFile(f.file, plan.cwd)}>{f.file.split("/").pop()} </code>
              ))}
            </p>
          ))}
        </details>
      )}
      {kinds.map((k) => {
        const mine = files.filter((f) => f.kind === k);
        return (
          <details key={k} className="gen-kind" open>
            <summary><b>{KINDS.some((x) => x.id === k) ? kindName(k as Kind) : k}</b> <span className="small muted">{mine.length}</span></summary>
            {mine.map((f) => (
              <figure key={f.file} className="gen-figure">
                {PIC.test(f.file) && <LocalImg src={f.file} alt={f.file} cwd={plan.cwd} />}
                <figcaption className="small">
                  <code className="file-link" role="button" onClick={() => openFile(f.file, plan.cwd)}>{f.file.split("/").pop()}</code>
                  <span className="muted"> · approved {new Date(f.at).toLocaleString()}</span>
                </figcaption>
              </figure>
            ))}
          </details>
        );
      })}
    </Section>
  );
}
