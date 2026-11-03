import type { Example as Ex } from "./data";
import { LocalImg, openFile } from "./FileView";
import { Md } from "./Markdown";

// An option's example (the owner's words, 2026-11-03: "images or vision blob file will need to show me the before and
// after; the code will need to show before and after code change with estimated benchmark and result; the document or
// text I will want to see the drafts").
const IMG = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;

function Shot({ path, label, cwd }: { path: string; label: string; cwd: string }) {
  return (
    <figure className="ex-shot">
      {IMG.test(path) ? (
        <LocalImg src={path} alt={label} cwd={cwd} />
      ) : (
        <code className="file-link" role="button" onClick={() => openFile(path, cwd)}>{path}</code>
      )}
      <figcaption className="small muted">{label}</figcaption>
    </figure>
  );
}

export function Example({ e, cwd }: { e: Ex; cwd: string }) {
  return (
    <div className="example">
      {e.type === "image" && (
        <div className="ex-pair">
          <Shot path={e.before} label="Before" cwd={cwd} />
          <Shot path={e.after} label="After" cwd={cwd} />
        </div>
      )}
      {e.type === "code" && (
        <>
          <pre className="ex-diff">
            {e.diff.split("\n").map((l, i) => (
              <div key={i} className={l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : ""}>
                {l || " "}
              </div>
            ))}
          </pre>
          <table className="ex-bench">
            <thead>
              <tr><th>Benchmark</th><th>Before</th><th>After</th><th></th></tr>
            </thead>
            <tbody>
              {e.bench.map((b, i) => (
                <tr key={i}>
                  <td>{b.name}</td>
                  <td className="num">{b.before}</td>
                  <td className="num">{b.after}</td>
                  <td className={b.measured ? "small ok-fg" : "small wait-fg"} title={b.source}>
                    {b.measured ? `measured${b.source ? ": " + b.source : ""}` : "estimated"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {e.type === "text" && <Md className="ex-draft" text={e.draft} cwd={cwd} />}
      {e.note && <p className="small muted">{e.note}</p>}
    </div>
  );
}
