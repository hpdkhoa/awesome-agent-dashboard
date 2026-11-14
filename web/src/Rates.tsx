import { useEffect, useState } from "react";
import { LineChart } from "./Charts";
import { addGold, fmt, parseAmount, FX_SOURCES, fxSource, GOLD_SOURCES, goldSource, syncAll, type FxSnapshot, type GoldPrice, type SyncLine } from "./moneyData";
import { dt } from "./fmt";

const today = () => new Date().toLocaleDateString("en-CA");

// fx and gold are null until the saved syncs have loaded; the button waits for them so each source's 5-minute check
// sees its last save.
export function RatesSide({ fx, gold }: { fx: FxSnapshot[] | null; gold: GoldPrice[] | null }) {
  const [lines, setLines] = useState<SyncLine[]>([]);
  const [busy, setBusy] = useState(false);
  const ready = fx !== null && gold !== null;

  const sync = () => {
    setBusy(true);
    setLines([]);
    syncAll(fx ?? [], gold ?? [])
      .then(setLines)
      .finally(() => setBusy(false));
  };

  return (
    <div className="pad form">
      <h2>Rates and gold</h2>
      <button className="primary" disabled={!ready || busy} onClick={sync}>
        {!ready ? "Loading" : busy ? "Syncing" : "Sync all sources"}
      </button>
      <p className="small muted">
        Manual, and on each Save in Money. Vietcombank and HSBC rates; the SJC bar and the plain 999.9 ring from giavang.net,
        PNJ and Bảo Tín Mạnh Hải. At most one sync every 5 minutes, Save included.
      </p>
      {lines.map((l) => (
        <p key={l.label} className={l.ok ? "small" : "small bad"}>
          {l.text}
        </p>
      ))}
      <GoldForm />
    </div>
  );
}
function GoldForm() {
  const [kind, setKind] = useState<"bar" | "ring">("bar");
  const [product, setProduct] = useState("SJC 1 lượng");
  const [buy, setBuy] = useState("");
  const [sell, setSell] = useState("");
  const [date, setDate] = useState(today());
  const [msg, setMsg] = useState("");
  const b = parseAmount(buy).value ?? 0;
  const s = parseAmount(sell).value ?? 0;
  const ok = b > 0 && s > 0 && s >= b && product.trim() !== "";

  const save = () =>
    addGold({ date, product: product.trim(), buy: b, sell: s, note: "", kind })
      .then(() => {
        setBuy("");
        setSell("");
        setMsg("Saved.");
      })
      .catch((e: Error) => setMsg("Not saved: " + e.message));

  return (
    <>
      <h2>Gold price typed by you</h2>
      <select value={kind} onChange={(e) => setKind(e.target.value as "bar" | "ring")}>
        <option value="bar">Gold bar</option>
        <option value="ring">Gold ring</option>
      </select>
      <input placeholder="Product" value={product} onChange={(e) => setProduct(e.target.value)} />
      <input inputMode="numeric" placeholder="Buy, đ per lượng" value={buy} onChange={(e) => setBuy(e.target.value)} />
      <input inputMode="numeric" placeholder="Sell, đ per lượng" value={sell} onChange={(e) => setSell(e.target.value)} />
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      <div className="actions">
        <button className="primary" disabled={!ok} onClick={save}>
          Save gold price
        </button>
      </div>
      {buy && sell && s < b && <p className="small bad">Sell is below buy.</p>}
      {msg && <p className="small muted">{msg}</p>}
      <p className="small muted">For a price no source covers.</p>
    </>
  );
}

// Line chart of one series over the saved snapshots, oldest on the left: dots, legend and stats (Charts.tsx).
function Line({ points, label }: { points: { t: string; v: number }[]; label: string }) {
  return <LineChart label={label} unit="đ" points={points} digits={0} />;
}

const diff = (a: number | null | undefined, b: number | null | undefined) =>
  a == null || b == null ? null : a - b;

function FxTable({ label, list }: { label: string; list: FxSnapshot[] }) {
  const [latest, prev] = list;
  const usd = [...list].reverse().filter((s) => s.rates.USD?.transfer != null);
  if (!latest) return <p className="muted">{label}: nothing saved yet.</p>;
  return (
    <>
      <h2>
        {label}, {dt(latest.sourceTime)}
        {prev && <span className="muted"> · change since {dt(prev.sourceTime)}</span>}
      </h2>
      <table>
        <thead>
          <tr className="small muted">
            <td>Currency</td>
            <td className="num">Cash buy</td>
            <td className="num">Transfer buy</td>
            <td className="num">Sell</td>
            <td className="num">Change (transfer)</td>
          </tr>
        </thead>
        <tbody>
          {Object.entries(latest.rates)
            .sort(([a], [b]) => (a === "USD" ? -1 : b === "USD" ? 1 : a.localeCompare(b)))
            .map(([code, r]) => {
              const d = diff(r.transfer, prev?.rates[code]?.transfer);
              return (
                <tr key={code}>
                  <td title={r.name}>{code}</td>
                  <td className="num">{fmt(r.buy)}</td>
                  <td className="num">{fmt(r.transfer)}</td>
                  <td className="num">{fmt(r.sell)}</td>
                  <td className={d === null || d === 0 ? "num muted" : d > 0 ? "num in" : "num bad"}>
                    {d === null ? "-" : (d > 0 ? "+" : "") + fmt(d)}
                  </td>
                </tr>
              );
            })}
        </tbody>
      </table>
      <Line label={`${label} USD transfer`} points={usd.map((s) => ({ t: s.sourceTime, v: s.rates.USD.transfer as number }))} />
      <p className="muted small">
        Source: <a href={latest.sourceUrl}>{label}</a>, for reference only.
      </p>
    </>
  );
}

export function RatesReport({ fx, gold }: { fx: FxSnapshot[]; gold: GoldPrice[] }) {
  const goldBy = [...GOLD_SOURCES, { id: "typed", label: "Typed by you", path: "" }].map((s) => ({
    ...s,
    list: gold.filter((g) => goldSource(g) === s.id),
  }));
  return (
    <article>
      <h1>Exchange rate report</h1>
      <p className="muted small">
        Uses only what this page saved: {FX_SOURCES.map((s) => `${fx.filter((x) => fxSource(x) === s.id).length} ${s.label}`).join(", ")} rate
        syncs; {gold.length} gold prices.
      </p>
      {FX_SOURCES.map((s) => (
        <FxTable key={s.id} label={s.label} list={fx.filter((x) => fxSource(x) === s.id)} />
      ))}
      <h2>Gold, đ per lượng</h2>
      <table>
        <thead>
          <tr className="small muted">
            <td>Source</td>
            <td>Kind</td>
            <td>Product</td>
            <td className="num">Buy</td>
            <td className="num">Sell</td>
            <td>Price time</td>
          </tr>
        </thead>
        <tbody>
          {goldBy
            .filter((s) => s.list.length > 0)
            .flatMap((s) => {
              // the newest saved bar and ring of each source; a typed price is one or the other
              const bar = s.list.find((g) => s.id !== "typed" || (g.kind ?? "bar") === "bar");
              const typedRing = s.id === "typed" ? s.list.find((g) => g.kind === "ring") : undefined;
              const ring = typedRing ? { ...typedRing, sourceTime: typedRing.sourceTime ?? typedRing.date } : s.list.find((g) => g.ring)?.ring;
              const link = (g?: GoldPrice) => (g?.sourceUrl ? <a href={g.sourceUrl}>{s.label}</a> : s.label);
              const rows: [string, string, { product: string; buy: number; sell: number | null }, string][] = [];
              if (bar) rows.push([s.id + "bar", "bar", bar, bar.sourceTime ?? bar.date]);
              if (ring) rows.push([s.id + "ring", "ring", ring, ring.sourceTime]);
              return rows.map(([key, kind, g, t]) => (
                <tr key={key}>
                  <td>{link(s.list[0])}</td>
                  <td className="small">{kind}</td>
                  <td className="small">{g.product}</td>
                  <td className="num">{fmt(g.buy, 0)}</td>
                  <td className="num">{fmt(g.sell, 0)}</td>
                  <td className="small">{dt(t)}</td>
                </tr>
              ));
            })}
        </tbody>
      </table>
      {goldBy
        .filter((s) => s.list.length > 0)
        .map((s) => (
          <div key={s.id}>
            <Line label={`${s.label} SJC bar buy`} points={[...s.list].reverse().filter((g) => (g.kind ?? "bar") === "bar").map((g) => ({ t: g.sourceTime ?? g.date, v: g.buy }))} />
            {s.list.some((g) => g.ring || g.kind === "ring") && (
              <Line
                label={`${s.label} ring buy`}
                points={[...s.list].reverse().flatMap((g) => (g.ring ? [{ t: g.ring.sourceTime, v: g.ring.buy }] : g.kind === "ring" ? [{ t: g.sourceTime ?? g.date, v: g.buy }] : []))}
              />
            )}
          </div>
        ))}
      {gold.length === 0 && <p className="muted">No gold price saved yet. Press "Sync all sources".</p>}
    </article>
  );
}