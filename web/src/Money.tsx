import { useState } from "react";
import {
  addEntry, ASSET_LABEL, ASSET_SHORT, ASSETS, assetOf, fmt, holdings, parseAmount, syncAll, UNIT, valuations, vnd,
  type Asset, type Entry, type FxSnapshot, type GoldPrice, type SyncLine,
} from "./moneyData";
import { MoreMenu } from "./MoreMenu";

const today = () => new Date().toLocaleDateString("en-CA");

// Save syncs every rate source first (the owner's choice, 2026-11-01: "sync when press save"), then saves the entry, so
// the balance uses the newest prices. A failed source shows its own line and never blocks the entry.
export function EntryForm({ fx, gold }: { fx: FxSnapshot[] | null; gold: GoldPrice[] | null }) {
  const [asset, setAsset] = useState<Asset>("VND");
  const [direction, setDirection] = useState<"in" | "out">("in");
  const [amount, setAmount] = useState("");
  const [price, setPrice] = useState("");
  const [date, setDate] = useState(today());
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState("");
  const [lines, setLines] = useState<SyncLine[]>([]);
  const [busy, setBusy] = useState(false);
  const a = parseAmount(amount);
  const withPrice = asset !== "VND" && direction === "in";
  const p = withPrice && price.trim() !== "" ? parseAmount(price) : null;
  const why = !fx || !gold ? "loading the saved rates" : amount.trim() === "" ? "type an amount" : a.error
    ? `amount: ${a.error}` : p?.error ? `price paid: ${p.error}` : !/^\d{4}-\d{2}-\d{2}$/.test(date) ? "pick a date" : "";

  const save = async () => {
    setBusy(true);
    setMsg("");
    setLines(await syncAll(fx!, gold!));
    try {
      await addEntry({ date, asset, direction, amount: a.value!, price: p?.value ?? null, note: note.trim() });
      setAmount("");
      setPrice("");
      setNote("");
      setMsg("Saved.");
    } catch (e) {
      setMsg("Not saved: " + (e as Error).message);
    }
    setBusy(false);
  };

  return (
    <div className="pad form">
      <h2>Add money in or out</h2>
      <select value={asset} onChange={(e) => setAsset(e.target.value as Asset)}>
        {ASSETS.map((x) => (
          <option key={x} value={x}>
            {ASSET_LABEL[x]}
          </option>
        ))}
      </select>
      <select value={direction} onChange={(e) => setDirection(e.target.value as "in" | "out")}>
        <option value="in">In</option>
        <option value="out">Out</option>
      </select>
      <input inputMode="decimal" placeholder={`Amount (${UNIT[asset]}), e.g. 1.000.000 or 1,5`} value={amount} onChange={(e) => setAmount(e.target.value)} />
      {withPrice && (
        <input inputMode="decimal" placeholder={`Price paid, đ per ${UNIT[asset]} (optional)`} value={price} onChange={(e) => setPrice(e.target.value)} />
      )}
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      <input placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="actions">
        <button className="primary" disabled={!!why || busy} onClick={save}>
          {busy ? "Syncing rates" : "Save"}
        </button>
      </div>
      {why && amount.trim() !== "" ? <p className="small bad">Cannot save: {why}.</p> : a.value !== undefined && (
        <p className="small muted">
          {direction === "in" ? "+" : "-"}
          {fmt(a.value, 4)} {UNIT[asset]}
          {p?.value !== undefined && ` at ${vnd(p.value)} per ${UNIT[asset]}`}
        </p>
      )}
      {withPrice && <p className="small muted">The price paid gives the profit or loss. Without it, that asset shows none.</p>}
      <p className="small muted">Save syncs the rates first, at most once every 5 minutes.</p>
      {lines.map((l) => (
        <p key={l.label} className={l.ok ? "small" : "small bad"}>
          {l.text}
        </p>
      ))}
      {msg && <p className="small muted">{msg}</p>}
    </div>
  );
}

const when = (t: string) => {
  const d = new Date(t), p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const signed = (n: number | null) => (n === null ? "-" : (n > 0 ? "+" : "") + vnd(n));
const tone = (n: number | null) => (n === null || Math.round(n) === 0 ? "num" : n > 0 ? "num in" : "num bad");

// The balance dashboard (the owner's ask, 2026-11-01: "show my total currencies and asset with the latest rate saved so
// I can balance my accounts"): every asset, the rate it is valued at, its value in đ, its share and its profit or loss.
export function MoneyView({ entries, fx, gold }: { entries: Entry[]; fx: FxSnapshot[]; gold: GoldPrice[] }) {
  const h = holdings(entries, valuations(fx, gold));
  return (
    <article>
      <h1>Balance</h1>
      <div className="tiles">
        <div>
          <p className="small muted">Total value</p>
          <p className="big">{h.total === null ? "needs every rate" : vnd(h.total)}</p>
        </div>
        <div>
          <p className="small muted">Profit or loss{h.profitOf > 0 && `, ${h.profitOf} priced asset${h.profitOf > 1 ? "s" : ""}`}</p>
          <p className={"big " + tone(h.profitOf ? h.profit : null)}>{h.profitOf ? signed(h.profit) : "no price paid yet"}</p>
        </div>
      </div>
      <table className="balance">
        <thead>
          <tr className="small muted">
            <td>Asset</td>
            <td className="num">Balance</td>
            <td className="num">Rate, đ per unit</td>
            <td className="num">Value</td>
            <td className="num">Share</td>
            <td className="num">Paid</td>
            <td className="num">Profit or loss</td>
          </tr>
        </thead>
        <tbody>
          {h.rows.map((x) => (
            <tr key={x.asset}>
              <td title={ASSET_LABEL[x.asset]}>{ASSET_SHORT[x.asset]}</td>
              <td className={x.qty < 0 ? "num bad" : "num"}>
                {fmt(x.qty, 4)} {UNIT[x.asset]}
              </td>
              <td className="num" title={x.val?.label ? `${x.val.label}, price time ${new Date(x.val.time).toLocaleString()}` : undefined}>
                {x.asset === "VND" ? "-" : x.val === null ? <span className="muted small">no rate saved</span> : (
                  <>
                    {fmt(x.val.rate, 0)}
                    <br />
                    <span className="muted small">
                      {x.val.label.split(",")[0]} · {when(x.val.time)}
                    </span>
                  </>
                )}
              </td>
              <td className="num">{vnd(x.value)}</td>
              <td className="num muted">{h.total && x.value !== null ? fmt((x.value / h.total) * 100, 1) + "%" : "-"}</td>
              <td className="num">{x.asset === "VND" || x.qty === 0 ? "-" : x.cost === null ? <span className="muted small">{x.unpriced} entr{x.unpriced > 1 ? "ies" : "y"} without a price</span> : vnd(x.cost)}</td>
              <td className={x.asset === "VND" || x.cost === null || x.value === null ? "num muted" : tone(x.value - x.cost)}>
                {x.asset === "VND" || x.cost === null || x.value === null || x.qty === 0 ? "-" : signed(x.value - x.cost)}
              </td>
            </tr>
          ))}
          <tr className="sum">
            <td>Total</td>
            <td />
            <td />
            <td className="num">{h.total === null ? "needs every rate" : vnd(h.total)}</td>
            <td />
            <td />
            <td className={tone(h.profitOf ? h.profit : null)}>{h.profitOf ? signed(h.profit) : "-"}</td>
          </tr>
        </tbody>
      </table>
      <p className="muted small">
        Values use the newest rates saved on this page. Gold is valued at SJC's own buy price on giavang.net (bar or ring),
        dollars and euros at Vietcombank's cash buy. Paid is the average price paid; an "out" entry takes its share at that
        average.
      </p>
      <h2>Entries</h2>
      <table>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td className="small">{e.date}</td>
              <td className={e.direction === "in" ? "in" : "bad"}>{e.direction === "in" ? "+" : "-"}</td>
              <td className="num">
                {fmt(e.amount, 4)} {UNIT[assetOf(e)]}
              </td>
              <td className="small">{ASSET_SHORT[assetOf(e)]}</td>
              <td className="num small muted">{e.price != null ? `at ${vnd(e.price)}` : ""}</td>
              <td className="muted small">{e.note}</td>
              <td className="num">
                <MoreMenu path={`moneyEntries/${e.id}`} />
              </td>
            </tr>
          ))}
          {entries.length === 0 && (
            <tr>
              <td className="muted">No entries yet.</td>
            </tr>
          )}
        </tbody>
      </table>
    </article>
  );
}
