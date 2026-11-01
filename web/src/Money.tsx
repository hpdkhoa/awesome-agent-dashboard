import { useState } from "react";
import { addEntry, balances, fmt, removeEntry, UNIT, vnd, type Asset, type Entry, type FxSnapshot, type GoldPrice } from "./moneyData";

const today = () => new Date().toLocaleDateString("en-CA");

export function EntryForm() {
  const [asset, setAsset] = useState<Asset>("VND");
  const [direction, setDirection] = useState<"in" | "out">("in");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(today());
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState("");
  const value = Number(amount.replace(/,/g, ""));
  const ok = amount.trim() !== "" && Number.isFinite(value) && value > 0 && /^\d{4}-\d{2}-\d{2}$/.test(date);

  const save = () =>
    addEntry({ date, asset, direction, amount: value, note: note.trim() })
      .then(() => {
        setAmount("");
        setNote("");
        setMsg("Saved.");
      })
      .catch((e: Error) => setMsg("Not saved: " + e.message));

  return (
    <div className="pad form">
      <h2>Add money in or out</h2>
      <select value={asset} onChange={(e) => setAsset(e.target.value as Asset)}>
        <option value="VND">VND (đồng)</option>
        <option value="USD">USD (dollars)</option>
        <option value="GOLD">Gold (chỉ; 10 chỉ = 1 lượng)</option>
      </select>
      <select value={direction} onChange={(e) => setDirection(e.target.value as "in" | "out")}>
        <option value="in">In</option>
        <option value="out">Out</option>
      </select>
      <input inputMode="decimal" placeholder={`Amount (${UNIT[asset]})`} value={amount} onChange={(e) => setAmount(e.target.value)} />
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      <input placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="actions">
        <button className="primary" disabled={!ok} onClick={save}>
          Save
        </button>
      </div>
      {msg && <p className="small muted">{msg}</p>}
    </div>
  );
}

export function MoneyView({ entries, fx, gold }: { entries: Entry[]; fx?: FxSnapshot; gold?: GoldPrice }) {
  const b = balances(entries, fx, gold);
  const rows: [Asset, string, string][] = [
    ["VND", fmt(b.bal.VND, 0) + " đ", "-"],
    ["USD", "$" + fmt(b.bal.USD), b.usdRate === null ? "no synced rate yet" : `${fmt(b.usdRate, 0)} đ (Vietcombank cash buy)`],
    ["GOLD", fmt(b.bal.GOLD) + " chỉ", b.goldRate === null ? "no gold price yet" : `${fmt(b.goldRate, 0)} đ per chỉ (${gold?.product}, buy)`],
  ];
  return (
    <article>
      <h1>Money flow</h1>
      <table>
        <tbody>
          {rows.map(([a, amount, rate]) => (
            <tr key={a}>
              <td>{a}</td>
              <td className="num">{amount}</td>
              <td className="num muted small">{rate}</td>
              <td className="num">{vnd(b.inVnd[a])}</td>
            </tr>
          ))}
          <tr className="sum">
            <td>Total</td>
            <td />
            <td />
            <td className="num">{b.total === null ? "needs both rates" : vnd(b.total)}</td>
          </tr>
        </tbody>
      </table>
      <p className="muted small">
        Values use the last rates saved on this page: {fx ? `Vietcombank ${new Date(fx.sourceTime).toLocaleString()}` : "none synced"}
        {" · "}
        {gold ? `gold ${gold.source ?? "typed"} ${new Date(gold.sourceTime ?? gold.date).toLocaleString()}` : "no gold price"}.
      </p>
      <h2>Entries</h2>
      <table>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td className="small">{e.date}</td>
              <td className={e.direction === "in" ? "in" : "bad"}>{e.direction === "in" ? "+" : "-"}</td>
              <td className="num">
                {fmt(e.amount)} {UNIT[e.asset]}
              </td>
              <td className="muted small">{e.note}</td>
              <td className="num">
                <button className="link" onClick={() => confirm(`Delete this ${e.asset} entry?`) && removeEntry(e.id)}>
                  delete
                </button>
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
