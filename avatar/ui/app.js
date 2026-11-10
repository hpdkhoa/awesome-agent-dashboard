// Polls the bridge's /status every 5 s and this PC's load every 2 s; no answer = OFFLINE.
const T = window.__TAURI__;
const invoke = T.core.invoke;
const win = T.window.getCurrentWindow();
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
let last = null, lastAt = null, failedSince = null;

function row(k, cls, v) { return `<div class="row"><span class="k">${esc(k)}</span><span class="${cls}">${v}</span></div>`; }
function hhmmss(d) { return d.toTimeString().slice(0, 8); }

function render(s, offline) {
  const wrap = $("wrap");
  wrap.className = "wrap " + (offline ? "off" : s && s.status === "in progress" ? "going" : "done");
  $("state").textContent = offline ? "OFFLINE" : s.status === "in progress" ? "IN PROGRESS" : "DONE";
  $("clock").textContent = offline ? (lastAt ? "last " + hhmmss(lastAt) : "") : hhmmss(new Date());
  let h = "";
  if (offline) {
    const mins = Math.max(0, Math.round((Date.now() - failedSince) / 60000));
    h += row("bridge PC", "bad", `✕ no answer ${mins}m`);
    for (const k of ["linux box", "sessions", "inbox", "plan", "steps"]) h += row(k, "k", "—");
    $("bar").innerHTML = "<i></i>".repeat(4);
  } else {
    for (const b of s.bridges) {
      const name = b.self ? "bridge PC" : "bridge " + b.name;
      h += row(name, b.online ? "ok" : "bad", b.online ? "● online" : `✕ ${b.seenAgoS == null ? "none" : "seen " + Math.round(b.seenAgoS / 60) + "m ago"}`);
    }
    for (const x of s.hosts || []) {
      const both = x.ssh && x.ollama;
      const txt = x.ssh || x.ollama ? `${x.ssh ? "●" : "✕"} ssh ${x.ollama ? "●" : "✕"} ollama` : "✕ no link";
      h += row(x.name + " box", both ? "ok" : x.ssh ? "o" : "bad", txt);
    }
    h += row("sessions", "y", `${s.sessions} open · ${s.runs} run${s.runs === 1 ? "" : "s"}`);
    h += row("inbox", s.inbox ? "o" : "v", `${s.inbox} waiting${s.inbox ? " ▲" : ""}`);
    const p = s.plan;
    h += row("plan", "p", p ? `${esc(p.title)} · ${esc(p.phase)}` : "—");
    h += row("steps", "v", p ? `${p.stepsDone} / ${p.stepsAll}` : "—");
    $("bar").innerHTML = p && p.steps.length
      ? p.steps.map((x) => `<i class="${x.state === "done" ? "on" : x.state === "now" ? "now" : ""}" title="${esc(x.id)}: ${esc(x.state)}"></i>`).join("")
      : "<i></i>".repeat(4);
  }
  $("rows").innerHTML = h;
  fit();
}

async function fit() {
  const w = $("wrap").getBoundingClientRect();
  // physical pixels: WebView2 also zooms by Windows' text size (this PC: 114%), which logical pixels leave out
  const r = window.devicePixelRatio || 1;
  try { await win.setSize(new T.dpi.PhysicalSize(Math.ceil(w.width * r), Math.ceil(w.height * r))); } catch (_) {}
}

async function poll() {
  try {
    last = JSON.parse(await invoke("status"));
    lastAt = new Date(); failedSince = null;
    render(last, false);
  } catch (_) {
    failedSince = failedSince || Date.now();
    render(null, true);
  }
}

async function load() {
  try {
    const l = await invoke("load");
    for (const [k, v] of [["cpu", l.cpu], ["ram", l.ram], ["gpu", l.gpu]]) {
      $(k).textContent = v == null ? "–" : `${v}%`;
      $(k + "b").style.width = `${v || 0}%`;
    }
  } catch (_) {}
}

$("box").addEventListener("mousedown", (e) => { if (e.button === 0) win.startDragging(); });
document.addEventListener("contextmenu", (e) => { e.preventDefault(); invoke("menu"); });
poll(); load();
setInterval(poll, 5000);
setInterval(load, 2000);
