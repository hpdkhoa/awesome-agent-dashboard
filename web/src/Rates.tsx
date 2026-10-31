import { useEffect, useState } from "react";
import { addGold, fmt, MIN_GAP_MS, syncRates, type FxSnapshot, type GoldPrice } from "./moneyData";

const today = () => new Date().toLocaleDateString("en-CA");

// fx is null until the saved syncs have loaded; the button waits for them so the 5-minute check sees the last save.
export function RatesSide({ fx }: { fx: FxSnapshot[] | null }) {
  const latest = fx?.[0];
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  const wait = latest ? MIN_GAP_MS - (Date.now() - Date.parse(latest.savedAt)) : 0;

  const sync = () => {
    setBusy(true);
    syncRates(latest)
      .then(setMsg)
      .catch((e: Error) => setMsg("Sync failed: " + e.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className="pad form">
      <h2>Exchange rates</h2>
      <button className="primary" disabled={!fx || busy || wait > 0} onClick={sync}>
        {!fx ? "Loading" : busy ? "Syncing" : wait > 0 ? `Sync again in ${Math.ceil(wait / 60000)} min` : "Sync Vietcombank rates"}
      </button>
      <p className="small muted">
        {latest ? `Last saved ${new Date(latest.savedAt).toLocaleString()}` : "Nothing synced yet."} Manual only; Vietcombank allows one request
        every 5 minutes.
      </p>
      {msg && <p className="small">{msg}</p>}
      <GoldForm />
    </div>
  );
}

function GoldForm() {
  const [product, setProduct] = useState("SJC 1 lượng");
  const [buy, setBuy] = useState("");
  const [sell, setSell] = useState("");
  const [date, setDate] = useState(today());
  const [msg, setMsg] = useState("");
  const b = Number(buy.replace(/[.,]/g, ""));
  const s = Number(sell.replace(/[.,]/g, ""));
  const ok = b > 0 && s > 0 && s >= b && product.trim() !== "";

  const save = () =>
    addGold({ date, product: product.trim(), buy: b, sell: s, note: "" })
      .then(() => {
        setBuy("");
        setSell("");
        setMsg("Saved.");
      })
      .catch((e: Error) => setMsg("Not saved: " + e.message));

  return (
    <>
      <h2>Gold price (typed by you)</h2>
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
      <p className="small muted">No legal automatic gold feed was found, so gold prices are typed here.</p>
    </>
  );
}

// Line chart of one series over the saved snapshots, oldest on the left.
function Line({ points, label }: { points: { t: string; v: number }[]; label: string }) {
  if (points.length < 2) return <p className="muted small">{label}: needs two saved points to draw.</p>;
  const w = 600, h = 140, pad = 4;
  const vs = points.map((p) => p.v);
  const lo = Math.min(...vs), hi = Math.max(...vs), span = hi - lo || 1;
  const xy = points.map((p, i) => [pad + (i / (points.length - 1)) * (w - 2 * pad), h - pad - ((p.v - lo) / span) * (h - 2 * pad)]);
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label}>
        <polyline fill="none" stroke="var(--accent)" strokeWidth="2" points={xy.map((p) => p.join(",")).join(" ")} />
      </svg>
      <figcaption className="small muted">
        {label}: {fmt(lo, 0)} to {fmt(hi, 0)} đ · {new Date(points[0].t).toLocaleDateString()} to{" "}
        {new Date(points[points.length - 1].t).toLocaleDateString()}
      </figcaption>
    </figure>
  );
}

const diff = (a: number | null | undefined, b: number | null | undefined) =>
  a == null || b == null ? null : a - b;

export function RatesReport({ fx, gold }: { fx: FxSnapshot[]; gold: GoldPrice[] }) {
  const [latest, prev] = fx;
  const usd = [...fx].reverse().filter((s) => s.rates.USD?.transfer != null);
  const goldUp = [...gold].reverse();
  return (
    <article>
      <h1>Exchange rate report</h1>
      <p className="muted small">
        Uses only the rates this page saved: {fx.length} Vietcombank syncs, {gold.length} typed gold prices.
      </p>
      {latest ? (
        <>
          <h2>
            Vietcombank, {new Date(latest.sourceTime).toLocaleString()}
            {prev && <span className="muted"> · change since {new Date(prev.sourceTime).toLocaleString()}</span>}
          </h2>
          <table>
            <thead>
              <tr className="small muted">
                <td>Currency</td>
                <td className="num">Cash buy</td>
                <td className="num">Transfer</td>
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
          <h2>USD over saved syncs</h2>
          <Line label="USD transfer" points={usd.map((s) => ({ t: s.sourceTime, v: s.rates.USD.transfer as number }))} />
        </>
      ) : (
        <p className="muted">No rates saved yet. Press "Sync Vietcombank rates".</p>
      )}
      <h2>Gold prices typed</h2>
      <Line label="Gold buy per lượng" points={goldUp.map((g) => ({ t: g.date, v: g.buy }))} />
      <table>
        <tbody>
          {gold.map((g) => (
            <tr key={g.id}>
              <td className="small">{g.date}</td>
              <td>{g.product}</td>
              <td className="num">buy {fmt(g.buy, 0)}</td>
              <td className="num">sell {fmt(g.sell, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">
        Source: <a href={latest?.sourceUrl ?? "https://portal.vietcombank.com.vn/Usercontrols/TVPortal.TyGia/pXML.aspx"}>Vietcombank public rate feed</a>,
        "for reference only".
      </p>
    </article>
  );
}
