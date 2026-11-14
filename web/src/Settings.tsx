// The Settings tab (the owner's picks, 2026-11-14: "use rem. open own settings tab."). Everything here is saved in this
// browser only (prefs.ts); another browser or the phone keeps its own. A change repaints the page once and reads no
// data. Shared settings (approvals, model, push, boxes) stay where they are, because the bridge reads them.
import { useRef, useState, type ReactNode } from "react";
import { dt, nf } from "./fmt";
import { DEFAULTS, HIDEABLE, LIMITS, diff, normalize, useSettings, type Settings, type TabId } from "./prefs";

export const TAB_NAME: Record<TabId, string> = {
  inbox: "Inbox", plans: "Plans", sessions: "Sessions", runs: "Runs", money: "Money", rates: "Rates", storage: "Storage", settings: "Settings",
};
const GROUPS = [
  ["set-text", "Text"], ["set-theme", "Theme"], ["set-layout", "Layout"], ["set-time", "Time and numbers"],
  ["set-phone", "Phone"], ["set-speed", "Speed"], ["set-reset", "Reset and files"],
] as const;

type Set = (p: Partial<Settings>) => void;

function Row({ what, why, children }: { what: string; why: string; children: ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-what"><b>{what}</b><span className="small muted">{why}</span></div>
      <div className="set-ctl">{children}</div>
    </div>
  );
}

function Pick<K extends keyof Settings>({ k, s, set, opts }: { k: K; s: Settings; set: Set; opts: [Settings[K], string][] }) {
  return (
    <>
      {opts.map(([v, label]) => (
        <button key={String(v)} className={s[k] === v ? "chip on primary" : "chip"} aria-pressed={s[k] === v}
          onClick={() => set({ [k]: v } as Partial<Settings>)}>{label}</button>
      ))}
    </>
  );
}

function Slide({ k, s, set, step, unit }: { k: keyof typeof LIMITS; s: Settings; set: Set; step: number; unit: string }) {
  const [lo, hi] = LIMITS[k];
  return (
    <>
      <input type="range" min={lo} max={hi} step={step} value={s[k]} onChange={(e) => set({ [k]: Number(e.target.value) })} />
      <span className="stat">{s[k]}{unit}</span>
      {s[k] !== DEFAULTS[k] && <button className="chip" onClick={() => set({ [k]: DEFAULTS[k] })}>Default {DEFAULTS[k]}{unit}</button>}
    </>
  );
}

export function SettingsSide({ onResetLayout }: { onResetLayout: () => void }) {
  return (
    <div className="pad">
      <p className="small muted">Saved in this browser only. Nothing goes to Firestore or the bridge.</p>
      <ul className="list">
        {GROUPS.map(([id, name]) => (
          <li key={id} className="row" onClick={() => document.getElementById(id)?.scrollIntoView({ block: "start" })}>{name}</li>
        ))}
      </ul>
      <p><button className="chip" onClick={onResetLayout}>Reset panel widths</button></p>
    </div>
  );
}

export function SettingsView({ onResetLayout }: { onResetLayout: () => void }) {
  const [s, set] = useSettings();
  const [msg, setMsg] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const changed = Object.entries(diff(s));

  const exportFile = () => {
    const blob = new Blob([JSON.stringify(diff(s), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "agent-dashboard-settings.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const importFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      const got = normalize(JSON.parse(await f.text()));
      set(got);
      setMsg(`Imported ${Object.keys(diff(got)).length} changed settings from ${f.name}.`);
    } catch (e) {
      setMsg(`Could not read ${f.name}: ${(e as Error).message}`);
    }
    if (file.current) file.current.value = "";
  };

  return (
    <div>
      <h1>Settings</h1>
      <p className="muted small">This browser only · {changed.length} changed from the default · a change shows at once.</p>

      <section className="set-group" id="set-text">
        <h2>Text</h2>
        <Row what="Font" why="The page's text font">
          <Pick k="font" s={s} set={set} opts={[["system", "System"], ["tahoma", "Tahoma"], ["verdana", "Verdana"], ["georgia", "Georgia"], ["custom", "Other"]]} />
          {s.font === "custom" && <input type="text" placeholder="a font name on this PC" value={s.fontCustom} onChange={(e) => set({ fontCustom: e.target.value })} />}
        </Row>
        <Row what="Size" why="One size for the whole page; headings, spaces and lists scale with it">
          <Slide k="size" s={s} set={set} step={1} unit=" px" />
        </Row>
        <Row what="Line height" why="Space between lines of text">
          <Slide k="lineHeight" s={s} set={set} step={0.05} unit="" />
        </Row>
        <Row what="Code font" why="Code, paths and diffs">
          <Pick k="mono" s={s} set={set} opts={[["default", "Default"], ["consolas", "Consolas"], ["cascadia", "Cascadia"], ["custom", "Other"]]} />
          {s.mono === "custom" && <input type="text" placeholder="a font name on this PC" value={s.monoCustom} onChange={(e) => set({ monoCustom: e.target.value })} />}
        </Row>
        <Row what="Code size" why="Code size against the text size">
          <Slide k="codeScale" s={s} set={set} step={0.05} unit="×" />
        </Row>
        <Row what="Even digits" why="Every digit the same width, so numbers line up in columns">
          <Pick k="tabular" s={s} set={set} opts={[[false, "Off"], [true, "On"]]} />
        </Row>
        <div className="set-sample">
          <b>Sample</b> · The plan moved to Build at {dt(Date.now())}. Tokens {nf(1234567)}. <code>web/src/Settings.tsx</code>
        </div>
      </section>

      <section className="set-group" id="set-theme">
        <h2>Theme</h2>
        <Row what="Theme" why="System follows this device's light or dark mode">
          <Pick k="theme" s={s} set={set} opts={[["system", "System"], ["light", "Light"], ["dark", "Dark"]]} />
        </Row>
        <Row what="Accent colour" why="Main buttons, picked rows and tabs">
          <input type="color" value={s.accent || "#185fa5"} onChange={(e) => set({ accent: e.target.value })} />
          {s.accent ? <button className="chip" onClick={() => set({ accent: "" })}>Use the theme colour</button> : <span className="small muted">the theme colour</span>}
        </Row>
        <Row what="Contrast" why="High makes grey text and lines darker">
          <Pick k="contrast" s={s} set={set} opts={[["normal", "Normal"], ["high", "High"]]} />
        </Row>
        <Row what="Motion" why="Reduce turns off the small animations">
          <Pick k="reduceMotion" s={s} set={set} opts={[[false, "Normal"], [true, "Reduce"]]} />
        </Row>
      </section>

      <section className="set-group" id="set-layout">
        <h2>Layout</h2>
        <Row what="Density" why="Space inside rows, buttons and tables on a desktop">
          <Pick k="density" s={s} set={set} opts={[["compact", "Compact"], ["normal", "Normal"], ["roomy", "Roomy"]]} />
        </Row>
        <Row what="Content width" why="How wide the middle column's content can grow">
          <Pick k="width" s={s} set={set} opts={[["full", "Full"], ["wide", "Wide"], ["narrow", "Narrow"]]} />
        </Row>
        <Row what="Start tab" why="The tab this browser opens on; a link to a plan, run or item still opens that">
          <select value={s.startTab} onChange={(e) => set({ startTab: e.target.value as TabId })}>
            {(Object.keys(TAB_NAME) as TabId[]).filter((t) => !s.hiddenTabs.includes(t)).map((t) => <option key={t} value={t}>{TAB_NAME[t]}</option>)}
          </select>
        </Row>
        <Row what="Tabs shown" why="A hidden tab is not drawn and loads nothing">
          {HIDEABLE.map((t) => {
            const on = !s.hiddenTabs.includes(t);
            return (
              <button key={t} className={on ? "chip on primary" : "chip"} aria-pressed={on}
                onClick={() => set({ hiddenTabs: on ? [...s.hiddenTabs, t] : s.hiddenTabs.filter((x) => x !== t) })}>
                {TAB_NAME[t]} {on ? "shown" : "hidden"}
              </button>
            );
          })}
        </Row>
        <Row what="Sections start" why="Open or folded, for sections this browser has not opened or folded yet">
          <Pick k="foldDefault" s={s} set={set} opts={[[false, "Open"], [true, "Folded"]]} />
        </Row>
      </section>

      <section className="set-group" id="set-time">
        <h2>Time and numbers</h2>
        <Row what="Clock" why="System uses this browser's own format">
          <Pick k="clock" s={s} set={set} opts={[["system", "System"], ["24h", "24 h"], ["12h", "12 h"]]} />
        </Row>
        <Row what="Last active" why="In lists: 5m ago, or the exact time">
          <Pick k="ago" s={s} set={set} opts={[["relative", "Relative"], ["exact", "Exact"]]} />
        </Row>
        <Row what="Numbers" why="Separators in counts and times; Money keeps the Vietnamese format">
          <Pick k="numbers" s={s} set={set} opts={[["system", "System"], ["en", "1,234.5"], ["vi", "1.234,5"]]} />
        </Row>
      </section>

      <section className="set-group" id="set-phone">
        <h2>Phone (560 px and narrower)</h2>
        <Row what="Size" why="The phone's own page size">
          <Slide k="phoneSize" s={s} set={set} step={1} unit=" px" />
        </Row>
        <Row what="Density" why="The phone's own row and button spacing">
          <Pick k="phoneDensity" s={s} set={set} opts={[["compact", "Compact"], ["normal", "Normal"], ["roomy", "Roomy"]]} />
        </Row>
        <Row what="Plan graph" why="Off: plans open as a list on the phone and the graph is not drawn">
          <Pick k="phoneGraph" s={s} set={set} opts={[[true, "On"], [false, "Off"]]} />
        </Row>
      </section>

      <section className="set-group" id="set-speed">
        <h2>Speed</h2>
        <Row what="Pictures" why="Ask the PC for a picture only when it scrolls into view">
          <Pick k="lazyImages" s={s} set={set} opts={[[false, "Load all"], [true, "When in view"]]} />
        </Row>
        <p className="small muted">A hidden browser tab already asks the bridge nothing until it shows again. Hidden tabs load nothing.</p>
      </section>

      <section className="set-group" id="set-reset">
        <h2>Reset and files</h2>
        <Row what="Reset" why="Back to the default look; folds and panel widths each on their own">
          <button className="danger" disabled={!changed.length} onClick={() => set(DEFAULTS)}>Reset all settings</button>
          <button className="chip" onClick={() => {
            try { localStorage.removeItem("aad.sections"); } catch { /* blocked storage */ }
            setMsg("Section folds reset; they show from the next open.");
          }}>Reset section folds</button>
          <button className="chip" onClick={onResetLayout}>Reset panel widths</button>
        </Row>
        <Row what="File" why="Copy these settings to another browser">
          <button className="chip" onClick={exportFile}>Export</button>
          <button className="chip" onClick={() => file.current?.click()}>Import</button>
          <input ref={file} type="file" accept="application/json" hidden onChange={(e) => void importFile(e.target.files?.[0])} />
        </Row>
        {msg && <p className="small">{msg}</p>}
        <p className="small muted">Changed: {changed.length ? changed.map(([k, v]) => `${k} ${JSON.stringify(v)}`).join(" · ") : "none"}</p>
      </section>
    </div>
  );
}
