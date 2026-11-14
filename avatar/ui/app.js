// Polls the bridge's /status every 5 s and this PC's load every 2 s; no answer = OFFLINE.
// p11: when signed in (firebase.json + the owner's Google account), it listens to every bridge's machines record
// instead, so it works with no bridge on this machine (the owner's Mac); this PC's own bridge row still goes OFFLINE
// from /status at once.
const T = window.__TAURI__;
const invoke = T.core.invoke;
const win = T.window.getCurrentWindow();
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
let last = null, lastAt = null, failedSince = null;
// p8 fix 4: the page only touches what changed; the last HTML written to the rows and the step bar
let rowsHtml = null, barHtml = null;
const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };

function row(k, cls, v) { return `<div class="row"><span class="k">${esc(k)}</span><span class="${cls}">${v}</span></div>`; }
function hhmmss(d) { return d.toTimeString().slice(0, 8); }

function render(s, offline) {
  const off = offline || !!(s && s.anyOffline);   // p11: with all bridges merged, any followed bridge offline
  const kind = off ? "off" : s && s.status === "in progress" ? "going" : "done";
  const wc = "wrap " + kind; if ($("wrap").className !== wc) $("wrap").className = wc;
  // the badge's status: offline > needs you (inbox has questions) > in progress > done (the owner's pick: "Yes, NEEDS YOU")
  const face = off ? "offline" : s.inbox > 0 ? "needs_you" : kind === "going" ? "in_progress" : "done";
  const bc = "badge " + { offline: "off", needs_you: "needs", in_progress: "going", done: "done" }[face];
  if ($("badge").className !== bc) $("badge").className = bc;
  $("badge").title = { offline: "Bridge offline", needs_you: `${s && s.inbox} question(s) wait for you`, in_progress: "In progress", done: "Done" }[face];
  showFace(face);
  const ib = $("binbox"), n = offline ? 0 : s.inbox;
  if (ib.hidden !== !n) ib.hidden = !n;
  setText(ib, String(n || ""));
  const b4n = $("b4n");   // s4: button 4 carries the same count as the badge
  if (b4n.hidden !== !n) b4n.hidden = !n;
  setText(b4n, String(n || ""));
  setText($("state"), offline || (s.anyOffline && !s.bridges.some((b) => b.online)) ? "OFFLINE"
    : (s.status === "in progress" ? "IN PROGRESS" : "DONE") + (s.anyOffline ? " · 1+ OFFLINE" : ""));
  setText($("clock"), offline ? (lastAt ? "last " + hhmmss(lastAt) : "") : hhmmss(new Date()));
  let bar;
  let h = "";
  if (offline) {
    const mins = Math.max(0, Math.round((Date.now() - failedSince) / 60000));
    h += row("bridge PC", "bad", `✕ no answer ${mins}m`);
    for (const k of ["linux box", "sessions", "inbox", "plan", "steps"]) h += row(k, "k", "—");
    bar = "<i></i>".repeat(4);
  } else {
    for (const b of s.bridges) {
      const name = s.merged ? "bridge " + b.name + (b.self ? " (here)" : "") : b.self ? "bridge PC" : "bridge " + b.name;
      const st = b.state && b.state.status;
      h += row(name, b.online ? (st === "in progress" ? "ok" : "v") : "bad",
        b.online ? `● ${st || "online"}` : `✕ ${b.seenAgoS == null ? "none" : "seen " + Math.round(b.seenAgoS / 60) + "m ago"}`);
    }
    if (authError) h += row("sign-in", "bad", esc(authError));
    if (keyErr) h += row("hotkey", "bad", esc(keyErr));   // s5: the saved key was taken at start
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
    bar = p && p.steps.length
      ? p.steps.map((x) => `<i class="${x.state === "done" ? "on" : x.state === "now" ? "now" : ""}" title="${esc(x.id)}: ${esc(x.state)}"></i>`).join("")
      : "<i></i>".repeat(4);
  }
  let changed = false;
  if (h !== rowsHtml) { $("rows").innerHTML = rowsHtml = h; changed = true; }
  if (bar !== barHtml) { $("bar").innerHTML = barHtml = bar; changed = true; }
  if (changed && shown === "box") fit();   // only a change of the rows can change the box's size
}

// Layers (plan b73e97ad p6; the owner's words, 2026-11-11: "I want this table is second layer, the first layer is a small
// avatar (later) now is a small bridge status, when click the menu appear ... the first button is the current table
// box"; "drop from top to bottom and circle on the right around the main node"). The badge stays still on screen; the
// window grows and moves around it so every layer fits.
const R = 92, ANG = [-78, -28, 22, 72], GLOW = 14;
const BOX_X = Math.max(...ANG.map((a) => R * Math.cos(a * Math.PI / 180))) + 26 + 18;  // right of every button
let layer = "closed";      // closed | menu | box | rates (p15) | send (plan c5cb9485 s1) | need (s4)
let shown = "closed";      // the layer the window is sized for (it stays big while buttons fly back)
let badgeAt = null;        // the badge centre in window CSS px (unzoomed), from the last layout
let badgePx = null;        // the same in device px (zoom and Windows text size applied)
const btns = [...document.querySelectorAll(".btn")];

function rects(state) {
  // every visible part, in CSS px around the badge centre (0, 0)
  const r = [[-38, -38, 38, 38]];
  if (state === "closed") return r;
  const b1 = [R * Math.cos(ANG[0] * Math.PI / 180), R * Math.sin(ANG[0] * Math.PI / 180)];
  ANG.forEach((a) => { const x = R * Math.cos(a * Math.PI / 180), y = R * Math.sin(a * Math.PI / 180); r.push([x - 26, y - 26, x + 26, y + 26]); });
  const b2 = [R * Math.cos(ANG[1] * Math.PI / 180), R * Math.sin(ANG[1] * Math.PI / 180)];
  if (state === "menu") {
    r.push([b1[0] + 30, b1[1] - 14, b1[0] + 130, b1[1] + 14]);  // the STATUS label on hover
    r.push([b2[0] + 30, b2[1] - 14, b2[0] + 120, b2[1] + 14]);  // the RATES label on hover (p15)
    const b3 = [R * Math.cos(ANG[2] * Math.PI / 180), R * Math.sin(ANG[2] * Math.PI / 180)];
    r.push([b3[0] + 30, b3[1] - 14, b3[0] + 120, b3[1] + 14]);  // the SEND label on hover (s1)
    const b4 = [R * Math.cos(ANG[3] * Math.PI / 180), R * Math.sin(ANG[3] * Math.PI / 180)];
    r.push([b4[0] + 30, b4[1] - 14, b4[0] + 150, b4[1] + 14]);  // the NEEDS YOU label on hover (s4)
  }
  if (state === "box" || state === "rates" || state === "send" || state === "need" || state === "key") {
    const w = $({ box: "wrap", rates: "rwrap", send: "swrap", need: "nwrap", key: "kwrap" }[state]).getBoundingClientRect(), z = zoom || 1;
    const x0 = BOX_X, y0 = b1[1] - 26 - 14;
    r.push([x0, y0, x0 + w.width / z, y0 + w.height / z]);
  }
  return r;
}

async function fit() {
  const state = shown, rs = rects(state);
  const minx = Math.min(...rs.map((r) => r[0])) - GLOW, miny = Math.min(...rs.map((r) => r[1])) - GLOW;
  const maxx = Math.max(...rs.map((r) => r[2])) + GLOW, maxy = Math.max(...rs.map((r) => r[3])) + GLOW;
  const cx = -minx, cy = -miny;  // the badge centre in the window
  const place = (el, x, y) => { el.style.left = `${x}px`; el.style.top = `${y}px`; };
  place($("badge"), cx - 38, cy - 38);
  btns.forEach((el, i) => {
    const x = R * Math.cos(ANG[i] * Math.PI / 180), y = R * Math.sin(ANG[i] * Math.PI / 180);
    el.dataset.x = cx + x - 26; el.dataset.y = cy + y - 26;
    place(el, cx + x - 26, cy + y - 26);
  });
  const b1x = R * Math.cos(ANG[0] * Math.PI / 180), b1y = R * Math.sin(ANG[0] * Math.PI / 180);
  place($("wrap"), cx + BOX_X, cy + b1y - 26 - 14);
  place($("link"), cx + b1x + 26, cy + b1y - 1); $("link").style.width = `${BOX_X - b1x - 26 + 18}px`;
  // p15: the rate box opens in the same place, its link from button 2
  const b2x = R * Math.cos(ANG[1] * Math.PI / 180), b2y = R * Math.sin(ANG[1] * Math.PI / 180);
  place($("rwrap"), cx + BOX_X, cy + b1y - 26 - 14);
  place($("link2"), cx + b2x + 26, cy + b2y - 1); $("link2").style.width = `${BOX_X - b2x - 26 + 18}px`;
  // s1: the SEND box opens in the same place, its link from button 3
  const b3x = R * Math.cos(ANG[2] * Math.PI / 180), b3y = R * Math.sin(ANG[2] * Math.PI / 180);
  place($("swrap"), cx + BOX_X, cy + b1y - 26 - 14);
  place($("link3"), cx + b3x + 26, cy + b3y - 1); $("link3").style.width = `${BOX_X - b3x - 26 + 18}px`;
  // s4: the NEEDS YOU deck opens in the same place, its link from button 4
  const b4x = R * Math.cos(ANG[3] * Math.PI / 180), b4y = R * Math.sin(ANG[3] * Math.PI / 180);
  place($("nwrap"), cx + BOX_X, cy + b1y - 26 - 14);
  place($("kwrap"), cx + BOX_X, cy + b1y - 26 - 14);   // s5: the hotkey box
  place($("link4"), cx + b4x + 26, cy + b4y - 1); $("link4").style.width = `${BOX_X - b4x - 26 + 18}px`;
  setFly(layer !== "closed", true);
  const dpr = window.devicePixelRatio || 1, z = zoom || 1;
  // the badge's place in the window in device px; the window moves by its change, so the badge stays still on
  // screen when a layer opens or closes and when the zoom changes
  const px = [cx * z * dpr, cy * z * dpr];
  const moved = badgePx ? [px[0] - badgePx[0], px[1] - badgePx[1]] : [0, 0];
  badgeAt = [cx, cy]; badgePx = px;
  try {
    if (moved[0] || moved[1]) {
      const p = await win.outerPosition();
      await win.setPosition(new T.dpi.PhysicalPosition(Math.round(p.x - moved[0]), Math.round(p.y - moved[1])));
    }
    await win.setSize(new T.dpi.PhysicalSize(Math.ceil((maxx - minx) * z * dpr), Math.ceil((maxy - miny) * z * dpr)));
  } catch (_) {}
}

// the buttons fly out from the badge one after another, top to bottom, and back in the other order
function setFly(out, instant) {
  btns.forEach((el, i) => {
    const d = out ? i * 60 : (btns.length - 1 - i) * 40;
    el.style.transitionDelay = instant ? "0ms" : `${d}ms`;
    el.style.opacity = out ? (el.classList.contains("empty") ? String(0.85 - i * 0.15) : "1") : "0";
    el.style.pointerEvents = out ? "auto" : "none";
    const dx = badgeAt ? badgeAt[0] - 26 - Number(el.dataset.x || 0) : 0, dy = badgeAt ? badgeAt[1] - 26 - Number(el.dataset.y || 0) : 0;
    el.style.transform = out ? "none" : `translate(${dx}px, ${dy}px) scale(.3)`;
  });
}

async function go(next) {
  const was = layer;
  layer = next;
  document.body.classList.toggle("boxopen", next === "box");
  document.body.classList.toggle("ratesopen", next === "rates");
  $("b1").classList.toggle("on", next === "box");
  $("b2").classList.toggle("on", next === "rates");
  document.body.classList.toggle("sendopen", next === "send");
  $("b3").classList.toggle("on", next === "send");
  if (next === "send") sendOn(); else if (was === "send") sendOff();
  document.body.classList.toggle("needopen", next === "need");
  $("b4").classList.toggle("on", next === "need");
  if (next === "need") needOn(); else if (was === "need") needOff();
  document.body.classList.toggle("keyopen", next === "key");
  if (next === "box") load();
  if (next === "rates") ratesOn(); else if (was === "rates") ratesOff();
  if (next === "closed") {           // fly back first, then shrink
    setFly(false, false);
    await new Promise((r) => setTimeout(r, 360));
    if (layer !== "closed") return;
    shown = "closed"; await fit();
  } else {
    shown = next; await fit();
    if (was === "closed") { setFly(false, true); requestAnimationFrame(() => requestAnimationFrame(() => setFly(true, false))); }
  }
}

async function poll() {
  try {
    last = JSON.parse(await invoke("status"));
    lastAt = new Date(); failedSince = null;
    localSeen = true; localOk = true;
    localName = ((last.bridges || []).find((b) => b.self) || {}).name || null;
  } catch (_) {
    failedSince = failedSince || Date.now();
    localOk = false;
  }
  show();
}

// p11: every bridge from Firestore (the owner's picks "C: bridges publish, avatar listens", "All, merged + picker")
const MACHINE_LIVE_S = 420;           // the bridge's keepalive (5 min) + 2 rounds: status.py MACHINE_LIVE_SECONDS
let keyErr = "";   // s5
let machines = null, signed = false, authError = "", localName = null, localSeen = false, localOk = false;
let follow = localStorage.getItem("follow") || "all";
function merged() {
  const now = Date.now();
  let rows = machines.map((m) => {
    const age = m.seenAt ? Math.max(0, (now - Date.parse(m.seenAt)) / 1000) : null;
    const self = !!localName && m.name === localName;
    // this PC's own bridge: /status answers or not, at once; the others: their record's age
    const online = self && localSeen ? localOk : age != null && age < MACHINE_LIVE_S;
    return { name: m.name, self, online, seenAgoS: age == null ? null : Math.round(age), state: m.avatar || null, seenAt: m.seenAt || "" };
  });
  if (follow !== "all") rows = rows.filter((r) => r.name === follow);
  const live = rows.filter((r) => r.online);
  // the account's counts (sessions, inbox, plan): from the newest online record that carries them
  const acc = live.filter((r) => r.state && r.state.account).sort((a, b) => b.seenAt.localeCompare(a.seenAt))[0];
  const a = acc ? acc.state.account : {};
  const hosts = {};
  for (const r of live) for (const x of (r.state && r.state.hosts) || []) hosts[x.name] = x;
  return { merged: true, anyOffline: !rows.length || rows.some((r) => !r.online),
    status: live.some((r) => r.state && r.state.status === "in progress") ? "in progress" : "done",
    runs: live.reduce((n, r) => n + ((r.state && r.state.runs) || 0), 0),
    sessions: a.sessions || 0, inbox: a.inbox || 0, plan: a.plan || null, bridges: rows, hosts: Object.values(hosts) };
}
function show() {
  if (machines) render(merged(), false);
  else if (failedSince) render(null, true);
  else if (last) render(last, false);
  if (layer === "send") renderSend();   // s1: a box going online or offline shows in the BOX picker
  if (layer === "need") renderNeed();   // s4: the badge's count shows beside the deck's
}
async function startFirebase() {
  try {
    const cfg = await invoke("fb_config");
    if (!cfg || !window.FB) return;                 // no firebase.json: this PC's bridge only, as before
    const user = await invoke("auth_get");
    if (!user) return;                              // not signed in: right click > Sign in with Google
    FB.start(cfg, user,
      (j) => { signed = !!j; if (j) { authError = ""; invoke("auth_set", { json: j }).catch(() => {}); } else { machines = null; show(); } },
      (ms) => { machines = ms; show(); },
      (e) => { authError = String(e); show(); });
  } catch (e) { authError = String(e); }
}
T.event.listen("auth", () => location.reload());     // signed in on the browser page: start with the stored user
T.event.listen("auth-error", (e) => { authError = String(e.payload); show(); });
T.event.listen("signout", async () => { if (window.FB) await FB.stop(); signed = false; machines = null; show(); });
T.event.listen("follow", (e) => { follow = String(e.payload); localStorage.setItem("follow", follow); show(); });
startFirebase();

async function load() {
  try {
    const l = await invoke("load");
    for (const [k, v] of [["cpu", l.cpu], ["ram", l.ram], ["gpu", l.gpu]]) {
      setText($(k), v == null ? "–" : `${v}%`);
      $(k + "b").style.transform = `scaleX(${(v || 0) / 100})`;
    }
  } catch (_) {}
}

// Size: one zoom value, set by the corner grip, the right-click Size menu or Ctrl+wheel while the box has focus (the
// owner's words, 2026-11-11: "Drag corner, right-click menu and Ctrl+mouse scroll when focus"; "Zoom (keep shape)").
const ZMIN = 0.6, ZMAX = 2.0;
let zoom = Number(localStorage.getItem("zoom")) || 1;
function setZoom(z) {
  zoom = Math.round(Math.min(ZMAX, Math.max(ZMIN, z)) * 100) / 100;
  $("stage").style.zoom = zoom;
  localStorage.setItem("zoom", String(zoom));
  fit();
}
setZoom(zoom);
T.event.listen("zoom", (e) => setZoom(Number(e.payload)));

// the corner grip: the box keeps its shape, its width follows the pointer
const grip = $("grip");
let g = null;
grip.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  e.stopPropagation(); e.preventDefault();
  grip.setPointerCapture(e.pointerId);
  g = { x: e.screenX, z: zoom, w: $("wrap").getBoundingClientRect().width * (window.devicePixelRatio || 1) };
});
grip.addEventListener("pointermove", (e) => {
  if (!g) return;
  // screenX is in CSS pixels, g.w in device pixels: the grip stays under the pointer
  const z = g.z * (g.w + (e.screenX - g.x) * (window.devicePixelRatio || 1)) / g.w;
  if (Math.abs(z - zoom) >= 0.01) setZoom(z);
});
const gripEnd = (e) => { if (g) { g = null; try { grip.releasePointerCapture(e.pointerId); } catch (_) {} } };
grip.addEventListener("pointerup", gripEnd);
grip.addEventListener("pointercancel", gripEnd);

// Ctrl+wheel: 10% a notch, only while the box has focus; never the browser's own page zoom
window.addEventListener("wheel", (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  if (!document.hasFocus()) return;
  setZoom(zoom + (e.deltaY < 0 ? 0.1 : -0.1));
}, { passive: false });

let press = null;
document.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || e.target === grip || e.target.closest(".btn.empty")) return;
  if (e.target.closest("select, textarea, option")) return;   // s1: the pickers and the message take the mouse, no drag
  press = { x: e.screenX, y: e.screenY, t: e.target };
});
document.addEventListener("mousemove", (e) => {
  if (press && (Math.abs(e.screenX - press.x) > 4 || Math.abs(e.screenY - press.y) > 4)) {
    // catch up the few px the press moved before it counted as a drag, then let Windows move the window
    const r = window.devicePixelRatio || 1, dx = (e.screenX - press.x) * r, dy = (e.screenY - press.y) * r;
    press = null;
    win.outerPosition().then((p) => win.setPosition(new T.dpi.PhysicalPosition(Math.round(p.x + dx), Math.round(p.y + dy))))
      .finally(() => win.startDragging());
  }
});
document.addEventListener("mouseup", (e) => {
  if (!press || e.button !== 0) return;
  const t = press.t; press = null;
  if (t.closest("#badge")) go(layer === "closed" ? "menu" : "closed");
  else if (t.closest("#b1")) go(layer === "box" ? "menu" : "box");
  else if (t.closest("#rsync")) sync();
  else if (t.closest("#b2")) go(layer === "rates" ? "menu" : "rates");
  else if (t.closest("#b3")) go(layer === "send" ? "menu" : "send");
  else if (t.closest(".stabs button")) sendTab(t.closest(".stabs button").dataset.tab);
  else if (t.closest("#ssend")) sendVoice();
  else if (t.closest("#smic")) (vOn ? voiceOff(false) : voiceOn());
  else if (t.closest("#sopen")) { if (sRun) invoke("open_run", { id: sRun.id }).catch(() => {}); }
  else if (t.closest("#b4")) go(layer === "need" ? "menu" : "need");
  else if (t.closest("#kclear")) keySet("");
  else if (t.closest("#kclose")) go("menu");
  else if (t.closest("#nbox [data-act]")) needAct(t.closest("[data-act]"));
});
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  invoke("menu", { zoom, bridges: machines ? machines.map((m) => m.name) : [], follow, signed });
});

// Avatar per status (plan b73e97ad p7; the owner's picks: "Your files + built-in fallback", config "All 3"). The images
// come from the avatar folder as data URLs (avatar.rs); a status with none, or a broken one, shows the robot.
let avatars = {}, faceNow = null, faceSrc = null;
// The owner's pick (2026-11-11, Optimize): "Move 10 s, then rest". The robot moves for 10 s after a status change or a
// hover on the badge, then holds still (no frames drawn at all while it rests). Your own GIFs keep playing.
const REST_MS = 10000;
let restTimer = null;
function wake() {
  $("face").classList.remove("rest");
  clearTimeout(restTimer);
  restTimer = setTimeout(() => $("face").classList.add("rest"), REST_MS);
}
$("badge").addEventListener("mouseenter", wake);
function showFace(key) {
  // p8 fix 5: an image is a file link (Tauri asset protocol, the avatar folder only), not base64 text in memory
  const path = avatars[key] || null;
  const src = path ? T.core.convertFileSrc(path) + "?v=" + (avatars.stamp || 0) : null;
  if (key === faceNow && src === faceSrc) return;   // same picture: keep the gif running, never restart it
  faceNow = key; faceSrc = src;
  wake();
  const f = $("face");
  if (!src) { f.innerHTML = ROBOT[key]; f.dataset.src = "robot"; return; }
  const img = new Image();
  img.className = avatars.fit === "contain" ? "contain" : "";
  img.alt = key;
  img.onerror = () => { f.innerHTML = ROBOT[key]; f.dataset.src = "robot (broken file)"; };
  img.src = src;
  f.replaceChildren(img); f.dataset.src = "file";
}
async function loadAvatars() {
  try { avatars = await invoke("avatars"); } catch (_) { avatars = {}; }
  faceNow = null;                                     // redraw with the new files
  if (last || failedSince || machines) show(); else showFace("done");
}
T.event.listen("avatars", loadAvatars);
// a file dropped on the window: avatar.rs asks which status it is for
T.event.listen("tauri://drag-drop", (e) => {
  const p = e.payload && e.payload.paths && e.payload.paths[0];
  if (p) invoke("drop_ask", { path: p }).catch(() => {});
});
loadAvatars();
poll();
setInterval(poll, 5000);
// p8 fix 3: CPU, RAM and GPU are read only while the box is open (nobody sees them otherwise)
// p14 F2 (owner pick 2026-11-12): CPU/RAM/GPU every 5 s, not 2 s (box open measured 3.5-6.2% of one core in p13)
setInterval(() => { if (layer === "box") load(); }, 5000);

// Button 2: the rate box (plan b73e97ad p15). The owner's words (2026-11-11): "I want the second button is my rate board,
// only need gold bar (SJC), USD (vietcombank and hsbc), change rate calculated from last sync and a sync button".
// Picks: SJC from "giavang.net"; the change from "The sync before" (the newest saved record minus the one before it,
// same source). Sync asks only these 3 sources through the dashboard Worker (main.rs price) and saves them as the Rates
// tab does (web/src/moneyData.ts): a source unchanged since its last record writes nothing; at most one sync every 5
// minutes (the owner's rule, 2026-11-01: "the sync must constraint the 5 mins between each sync so not spam my
// firestore"); one error line per source (the owner's rule). The records are listened to only while the box is open.
const GAP_MS = 5 * 60 * 1000;
const RSRC = [
  { id: "giavang", kind: "gold", label: "SJC", short: "SJC", path: "/api/gold/giavang" },
  { id: "vcb", kind: "fx", label: "Vietcombank", short: "VCB", path: "/api/fx/vcb" },
  { id: "hsbc", kind: "fx", label: "HSBC", short: "HSBC", path: "/api/fx/hsbc" },
];
let rfx = null, rgold = null, rerrs = {}, rbusy = false, rtick = null, rHtml = null, rFirebaseErr = "";
const fxOf = (d) => d.sourceId ?? "vcb", goldOf = (d) => d.sourceId ?? "typed";
const savedAt = (d) => d.savedAt || d.enteredAt || "";
// the newest two records of one source, newest first
function pair(src) {
  const list = src.kind === "fx" ? (rfx || []).filter((d) => fxOf(d) === src.id) : (rgold || []).filter((d) => goldOf(d) === src.id);
  return list.sort((a, b) => savedAt(b).localeCompare(savedAt(a))).slice(0, 2);
}
// buy and sell of one record: USD at Vietcombank cash buy (else transfer), as the Rates tab values it; gold per lượng
function bs(src, d) {
  if (!d) return null;
  if (src.kind === "gold") return { buy: d.buy, sell: d.sell };
  const u = (d.rates || {}).USD || {};
  return { buy: u.buy ?? u.transfer ?? null, sell: u.sell ?? null };
}
const nf0 = (n) => Math.round(n).toLocaleString("en-US");
const tr = (n) => (n / 1e6).toFixed(1);            // triệu đồng
function cell(src, now, prev) {
  if (now == null) return `<b>—</b><i class="eq">&nbsp;</i>`;
  const val = src.kind === "gold" ? tr(now) : nf0(now);
  if (prev == null) return `<b>${val}</b><i class="eq">no sync before</i>`;
  const d = now - prev, pc = prev ? (d / prev) * 100 : 0;
  const amt = src.kind === "gold" ? (Math.abs(d) / 1e6).toFixed(1) : nf0(Math.abs(d));
  const [cls, ar] = d > 0 ? ["up", "▲"] : d < 0 ? ["dn", "▼"] : ["eq", "="];
  return `<b>${val}</b><i class="${cls}">${ar} ${amt} · ${d >= 0 ? "+" : "−"}${Math.abs(pc).toFixed(2)}%</i>`;
}
const hm = (iso) => (iso ? new Date(iso).toTimeString().slice(0, 5) : "—");
const dayOr = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso), t = new Date();
  // today: the time; an earlier day: its date and time (two syncs on one earlier day stay apart)
  return d.toDateString() === t.toDateString() ? hm(iso) : `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")} ${hm(iso)}`;
};
function lastSyncAt() {
  // the newest saved record of the 3 sources, or this avatar's own last try (a failed sync counts too)
  const own = Number(localStorage.getItem("ratesLastSync")) || 0;
  const rec = Math.max(0, ...RSRC.map((s) => Date.parse(savedAt(pair(s)[0] || {})) || 0));
  return Math.max(own, rec);
}
function renderRates() {
  if (layer !== "rates") return;
  setText($("rclock"), new Date().toTimeString().slice(0, 8));
  let h = "";
  if (!window.FB || !FB.signedIn()) {
    h = `<div class="rerr">${esc(rFirebaseErr || "Not signed in: right click > Sign in with Google to see your saved rates.")}</div>`;
  } else if (!rfx || !rgold) {
    h = `<div class="rnote">loading your saved rates…</div>`;
  } else {
    h += `<div class="rhead"><span>buy</span><span>sell</span></div>`;
    const sec = (t) => `<div class="rsec">${t}</div>`;
    const line = (src) => {
      const [a, b] = pair(src), x = bs(src, a), y = bs(src, b);
      return `<div class="rrow"><span class="n">${esc(src.label)}</span><span class="c">${cell(src, x && x.buy, y && y.buy)}</span><span class="c">${cell(src, x && x.sell, y && y.sell)}</span></div>`;
    };
    h += sec("GOLD BAR SJC · triệu đ / lượng") + line(RSRC[0]);
    h += sec("USD · đ") + line(RSRC[1]) + line(RSRC[2]);
    for (const s of RSRC) if (rerrs[s.id]) h += `<div class="rerr">${esc(rerrs[s.id])}</div>`;
    const spans = RSRC.map((s) => { const [a, b] = pair(s); return `${s.short} ${b ? dayOr(savedAt(b)) : "—"} → ${a ? dayOr(savedAt(a)) : "—"}`; });
    h += `<div class="rnote">▲▼ = change from the sync before (${esc(spans.join(", "))})</div>`;
  }
  if (h !== rHtml) { $("rrows").innerHTML = rHtml = h; fit(); }
  // the Sync button: greyed with a countdown inside the 5-minute gap
  const wait = lastSyncAt() + GAP_MS - Date.now(), btn = $("rsync");
  const ok = !!(window.FB && FB.signedIn() && rfx && rgold);
  const inGap = wait > 0;
  btn.disabled = rbusy || inGap || !ok;
  setText(btn, rbusy ? "SYNC…" : inGap ? `SYNC ${Math.floor(wait / 60000)}:${String(Math.floor(wait / 1000) % 60).padStart(2, "0")}` : "SYNC");
  const n = RSRC.filter((s) => pair(s)[0]).length, last = lastSyncAt();
  setText($("rlast"), inGap ? `next sync after ${hm(new Date(last + GAP_MS).toISOString())}` : last ? `last sync ${dayOr(new Date(last).toISOString())} · ${n} sources` : "");
}
function ratesOn() {
  rHtml = null;
  if (window.FB && FB.signedIn())
    FB.ratesOpen({ fx: ["vcb", "hsbc"], gold: ["giavang"] }, (fx, gold) => { rfx = fx; rgold = gold; renderRates(); },
      (e) => { rFirebaseErr = `Firestore: ${e}`; renderRates(); });
  renderRates();
  clearInterval(rtick); rtick = setInterval(renderRates, 1000);   // the clock and the countdown, only while open
}
function ratesOff() { clearInterval(rtick); rtick = null; if (window.FB) FB.ratesClose(); rfx = rgold = null; }
async function sync() {
  if (rbusy || Date.now() < lastSyncAt() + GAP_MS) { renderRates(); return; }   // inside the gap: nothing asked or written
  rbusy = true; localStorage.setItem("ratesLastSync", String(Date.now())); renderRates();
  const at = new Date().toISOString();
  await Promise.all(RSRC.map(async (s) => {
    const [latest] = pair(s);
    try {
      const body = JSON.parse(await invoke("price", { path: s.path }));
      const same = s.kind === "fx"
        ? latest && JSON.stringify(sortKeys(latest.rates)) === JSON.stringify(sortKeys(body.rates))
        : latest && latest.buy === body.buy && latest.sell === body.sell && JSON.stringify(sortKeys(latest.ring ?? null)) === JSON.stringify(sortKeys(body.ring ?? null));
      if (!same) await (s.kind === "fx" ? FB.saveFx(body, s.id) : FB.saveGold(body));   // unchanged: nothing written
      delete rerrs[s.id];
    } catch (e) {
      rerrs[s.id] = `${s.label}: ${String(e).replace(/^Error: /, "")} at ${hm(at)}${latest ? ` (shows ${dayOr(savedAt(latest))} rate)` : ""}`;
    }
  }));
  rbusy = false; rHtml = null; renderRates();
}
// Firestore hands maps back with their keys sorted; compare with sorted keys (moneyData.ts same())
function sortKeys(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return v;
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
}

// Button 3: the SEND box (plan c5cb9485 s1). The owner's words (2026-11-13): "the third node will be the interaction
// place where I can send the message through the avatar, choose the target, the models, the session belong to targeted
// box". Picks: "Two tabs" (NEW = a folder of the box, CONTINUE = a session of the box), "+ effort + mode", layout
// "Approve, CONTINUE first" (it opens on the last used tab and session). Models and efforts are the bridge's exact lists
// (runs.py MODELS, EFFORTS; the owner's rule "I want exact option"; opus-5-5 + medium when nothing was picked before).
// The box's sessions are asked once when the box opens or the picked box changes (box closed = nothing read). Send
// writes the command to the picked box (s2, below).
const MODELS = ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const MODES = [["manual", "Manual"], ["auto", "Auto"]];
let sp = Object.assign({ tab: "cont", box: "", model: "claude-opus-5-5", effort: "medium", mode: "manual", folder: "", session: "" },
  JSON.parse(localStorage.getItem("send") || "{}"));
let sSessions = null, sSessErr = "", sSessFor = "", sTick = null;
const saveSp = () => localStorage.setItem("send", JSON.stringify(sp));
const opt = (v, label, on) => `<option value="${esc(v)}"${on ? " selected" : ""}>${esc(label)}</option>`;
function setOpts(el, html) { if (el.innerHTML !== html) el.innerHTML = html; }
const ago = (iso) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return !iso ? "" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};
const base = (p) => String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop();
function sendBoxes() {
  const now = Date.now();
  return (machines || []).map((m) => {
    const age = m.seenAt ? (now - Date.parse(m.seenAt)) / 1000 : null;
    const self = !!localName && m.name === localName;
    return { name: m.name, online: self && localSeen ? localOk : age != null && age < MACHINE_LIVE_S, folders: m.folders || [] };
  });
}
function renderSend() {
  if (layer !== "send") return;
  const bs = sendBoxes();
  if (!bs.some((b) => b.name === sp.box) && bs.length) { sp.box = (bs.find((b) => b.online) || bs[0]).name; saveSp(); }
  const box = bs.find((b) => b.name === sp.box);
  setOpts($("sbx"), bs.length ? bs.map((b) => opt(b.name, `${b.name} (${b.online ? "online" : "offline"})`, b.name === sp.box)).join("")
    : opt("", !signed ? "not signed in" : machines === null ? "loading boxes..." : "no box yet", true));
  setOpts($("smodel"), MODELS.map((m) => opt(m, m, m === sp.model)).join(""));
  setOpts($("seffort"), EFFORTS.map((x) => opt(x, x, x === sp.effort)).join(""));
  setOpts($("smode"), MODES.map(([v, l]) => opt(v, l, v === sp.mode)).join(""));
  const fs = box ? box.folders : [];
  // the folder's path is the value: two folders can share one name (engineering-reference twice on the PC)
  if (fs.length && !fs.some((f) => f.path === sp.folder)) { sp.folder = fs[0].path; saveSp(); }
  setOpts($("sfolder"), fs.length ? fs.map((f) => opt(f.path, `${f.workType} \u00b7 ${f.path}`, f.path === sp.folder)).join("")
    : opt("", "no folder on this box", true));
  let ss;
  if (sSessErr) ss = opt("", sSessErr, true);
  else if (!sSessions) ss = opt("", "loading sessions...", true);
  else if (!sSessions.length) ss = opt("", "no session on this box", true);
  else {
    if (!sSessions.some((x) => x.id === sp.session)) { sp.session = sSessions[0].id; saveSp(); }
    ss = sSessions.map((x) => opt(x.id, `${(x.title || x.firstPrompt || x.id).slice(0, 48)} \u00b7 ${base(x.cwd)} \u00b7 ${ago(x.lastAt)}`, x.id === sp.session)).join("");
  }
  setOpts($("ssess"), ss);
  $("snew").classList.toggle("on", sp.tab === "new"); $("scont").classList.toggle("on", sp.tab === "cont");
  $("ssearch").classList.toggle("on", sp.tab === "search");
  $("sfolderk").hidden = sp.tab !== "new"; $("ssessk").hidden = sp.tab !== "cont";
  // s9 SEARCH tab (the owner's pick "A: SEARCH tab"): Gemini needs only the box; model, effort and mode are hidden
  const srch = sp.tab === "search";
  for (const id of ["smodelk", "seffortk", "smodek"]) $(id).hidden = srch;
  $("sbx").closest(".sgrid").classList.toggle("one", srch);
  const ph = srch ? "ask the web (Gemini Flash + Google Search)..." : "message to the picked box...";
  if ($("smsg").placeholder !== ph) $("smsg").placeholder = ph;
  setText($("ssend"), srch ? "SEARCH" : "SEND");
  sendReady();
  setText($("sclock"), hhmmss(new Date()));
}
async function loadSessions() {
  const name = sp.box; sSessFor = name; sSessions = null; sSessErr = ""; renderSend();
  if (!name) return;
  try {
    if (!window.FB || !FB.signedIn()) throw new Error("not signed in: right click > Sign in with Google");
    const rows = await FB.sessions(name);
    if (sSessFor !== name) return;
    sSessions = rows;
  } catch (e) { if (sSessFor === name) sSessErr = String(e.message || e).slice(0, 80); }
  renderSend(); if (shown === "send") fit();
}
function sendTab(t) { sp.tab = ["new", "search"].includes(t) ? t : "cont"; saveSp(); renderSend(); fit(); }
function sendOn() { renderSend(); loadSessions(); sTick = setInterval(() => setText($("sclock"), hhmmss(new Date())), 1000); watchOn(); }
function sendOff() { clearInterval(sTick); sTick = null; sSessions = null; sSessFor = ""; watchOff(); voiceOff(false); }
$("sbx").addEventListener("change", (e) => { sp.box = e.target.value; saveSp(); loadSessions(); });
for (const [id, k] of [["smodel", "model"], ["seffort", "effort"], ["smode", "mode"], ["sfolder", "folder"], ["ssess", "session"]])
  $(id).addEventListener("change", (e) => { sp[k] = e.target.value; saveSp(); sNote = ""; sendReady(); });

// s2: the send path. NEW writes a start command (machine, folder, prompt), CONTINUE a message command (machine,
// sessionId, cwd, prompt), shaped as the dashboard writes them (web/src/data.ts startRun, sendMessage), with the picked
// exact model and effort. The command goes to the picked box: through its data API when it is a registered box, else to
// Firestore (FB.send). The box's bridge runs it as it runs the page's commands.
let sSending = false, sLast = null, sNote = "";
const newCmdId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 20);
function sendWhy() {
  if (!window.FB || !FB.signedIn()) return "not signed in";
  const box = sendBoxes().find((b) => b.name === sp.box);
  if (!box) return "pick a box";
  if (sp.tab === "new" && !box.folders.some((f) => f.path === sp.folder)) return "pick a folder";
  if (sp.tab === "cont" && !(sSessions || []).some((x) => x.id === sp.session)) return "pick a session";
  if (!$("smsg").value.trim()) return sp.tab === "search" ? "write a question" : "write a message";
  return "";
}
function sendReady() {
  const why = sSending ? "sending..." : sendWhy();
  $("ssend").disabled = !!why;
  setText($("snote"), sNote || why);
}
function sendCommand() {
  const prompt = $("smsg").value.trim(), id = newCmdId(), at = new Date().toISOString();
  // s9: a search (the owner's words, 2026-11-14: "Search box go to both send box and dashboard and count as a run"):
  // the box's bridge asks Gemini Flash with Google Search (bridge search.py); no model, effort or mode
  if (sp.tab === "search") return { id, action: "search", machine: sp.box, prompt, status: "new", createdAt: at };
  const run = { model: sp.model, effort: sp.effort, mode: sp.mode };   // mode per message (the owner's pick, s2)
  if (sp.tab === "new") return { id, action: "start", machine: sp.box, folder: sp.folder, prompt, status: "new", createdAt: at, ...run };
  const x = sSessions.find((s) => s.id === sp.session);
  return { id, action: "message", machine: sp.box, sessionId: x.id, cwd: x.cwd || "", prompt, status: "new", createdAt: at, ...run };
}
async function send() {
  if (sSending || sendWhy()) return;
  const c = sendCommand();
  sSending = true; sNote = ""; sendReady();
  try {
    const via = await FB.send(sp.box, c);
    sLast = { ...c, via }; $("smsg").value = "";
    sRun = { id: c.id, box: c.machine, model: c.model || (c.action === "search" ? "gemini" : ""), sentAt: c.createdAt, status: "new" }; sRunText = ""; saveRun(); watchOn();
    sNote = `sent to ${c.machine} (${via}) \u00b7 ${c.id}`;
  } catch (e) { sNote = "not sent: " + String(e.message || e).slice(0, 70); }
  sSending = false; sendReady();
}
$("smsg").addEventListener("input", () => { sNote = ""; sendReady(); });

// s3: the sent message's state and the head of its reply (the owner's pick, round 1: "State + reply head": queued /
// running / done, the first 3 lines of the reply, Open on dashboard). The last sent run is kept (localStorage), so the
// box reopens on it. Asked every 3 s, and only while the box is open and the run has not ended (box closed = nothing
// read); the reply is the box's own text of the run (/text: live while running, the result once ended).
const ENDED = ["done", "failed", "stopped", "cancelled"];
const STATE = { new: "QUEUED", waiting: "WAITING (session busy)", running: "RUNNING", done: "DONE", failed: "FAILED",
  stopped: "STOPPED", cancelled: "CANCELLED", paused: "PAUSED", stopping: "STOPPING" };
let sRun = JSON.parse(localStorage.getItem("sendRun") || "null"), sRunText = "", sWatch = null, sAsking = false;
const saveRun = () => localStorage.setItem("sendRun", JSON.stringify(sRun));
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
function renderRun() {
  const el = $("sstate");
  if (!sRun) { if (!el.hidden) { el.hidden = true; fit(); } return; }
  const st = sRun.status || "new", from = sRun.startedAt || sRun.sentAt, to = sRun.endedAt ? Date.parse(sRun.endedAt) : Date.now();
  const cls = st === "done" ? "ok" : ENDED.includes(st) ? "bad" : st === "running" ? "v" : "o";
  const h = `<span class="${cls}">\u25cf ${esc(STATE[st] || st.toUpperCase())}</span> \u00b7 ${esc(String(sRun.model || "").replace("claude-", ""))}`
    + ` \u00b7 ${esc(sRun.box)}${from ? " \u00b7 " + mmss(Math.max(0, (to - Date.parse(from)) / 1000)) : ""}`
    + (sRun.firstTokenMs != null ? ` \u00b7 first token ${(sRun.firstTokenMs / 1000).toFixed(1)} s` : "");
  if ($("sst").innerHTML !== h) $("sst").innerHTML = h;
  // s9: a search's reply leaves out its "Sources:" list; the links show on their own line, by site name; a failed
  // run shows why (a search with no key: "No Gemini key: set GEMINI_API_KEY in Config ...")
  const lines = String(sRunText || "").split(/\n\s*Sources:\s*\n/)[0].split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 3);
  const srcs = (sRun.sources || []).map((x) => x.title);
  let r = sRun.error && st === "failed" ? `<span class="rk">why:</span> <span class="bad">${esc(sRun.error.slice(0, 160))}</span>`
    : lines.length ? `<span class="rk">reply:</span> ${lines.map(esc).join("<br>")}` : `<span class="rk">reply:</span> <span class="k">${st === "done" ? "none" : "\u2026"}</span>`;
  if (srcs.length) r += `<br><span class="rk">sources:</span> ${srcs.slice(0, 2).map(esc).join(" \u00b7 ")}${srcs.length > 2 ? ` \u00b7 +${srcs.length - 2}` : ""}`;
  if ($("srep").innerHTML !== r) $("srep").innerHTML = r;
  if (el.hidden) { el.hidden = false; fit(); } else if (shown === "send") fit();
}
async function askRun() {
  if (!sRun || sAsking || !window.FB || !FB.signedIn()) return;
  sAsking = true;
  try {
    const c = await FB.runState(sRun.box, sRun.id);
    if (c) Object.assign(sRun, { status: c.status, startedAt: c.startedAt || null, endedAt: c.endedAt || null, model: c.model || sRun.model,
      firstTokenMs: c.firstTokenMs ?? null, sources: c.sources || null, error: c.error || "" });   // s9: first token, links, why it failed
    const ended = ENDED.includes(sRun.status);
    if (sRun.status === "running" || ended) {
      const t = await FB.runText(sRun.box, sRun.id, !ended).catch(() => null);
      if (t && typeof t.text === "string") sRunText = t.text;
    }
    saveRun();
    if (ended) watchOff();
  } catch (_) {}
  sAsking = false;
  if (layer === "send") renderRun();
}
function watchOn() {
  renderRun();
  if (!sRun || sWatch || layer !== "send") return;
  askRun();
  if (!ENDED.includes(sRun.status) || !sRunText) sWatch = setInterval(askRun, 3000);
}
function watchOff() { clearInterval(sWatch); sWatch = null; }

// Button 4: the NEEDS YOU deck (plan c5cb9485 s4). The owner's words (2026-11-13): "Do a deep research for virtual
// assistant to plan any new design for the 4th node"; round 2: "I want to see the preview like this inbox feature, can
// you make it?"; round 3: "Approve v2" (after-n4-v2.png); batches "One at a time". Each waiting ask (inbox status open,
// every box, oldest first) shows like the dashboard inbox (web/src/Inbox.tsx, Example.tsx): the question, its context,
// option cards with their pictures, drawings, code or drafts, REC on the recommended one, a note, Answer and Open on
// dashboard. A batch walks one question at a time: each answer is saved as the page saves it (draft + thread), and all
// answers go together at the end (data.ts saveDraft, sendBatch). A tool ask from a run shows its call with Allow / Deny.
// The answer is the same write the page makes, on the box that holds the ask. Read only while the deck is open.
let nItems = null, nErr = "", nKey = "", nQ = {}, nSel = {}, nBusy = false, nSay = "", nSayBad = false;
let nHtml = null, nActHtml = null, nPgHtml = null, nCur = null, nFull = [];
const nPicSrc = new Map(), nPlans = new Map();
const NKIND = { suggestion: "suggestion", result: "result to review", approval: "tool call from a run" };
const nOpen = (q) => q.status === "open";
const nKeyOf = (b) => `${b[0]._box}|${b[0].batchId || b[0].id}`;
function nAsks() {
  const g = new Map();
  for (const i of nItems || []) { const k = `${i._box}|${i.batchId || i.id}`; if (!g.has(k)) g.set(k, []); g.get(k).push(i); }
  return [...g.values()].map((b) => b.sort((a, c) => (a.batchIndex ?? 0) - (c.batchIndex ?? 0)))
    .sort((a, b) => String(a[0].createdAt).localeCompare(String(b[0].createdAt)));   // oldest first
}
function nNow() {
  const list = nAsks();
  let i = list.findIndex((b) => nKeyOf(b) === nKey);
  if (i < 0) { i = 0; nKey = list.length ? nKeyOf(list[0]) : ""; }
  const b = list[i] || null;
  if (!b) return { list, i, b: null, k: 0, q: null };
  let k = nQ[nKey];
  if (k == null || k >= b.length) { k = Math.max(0, b.findIndex((q) => !q.draft)); nQ[nKey] = k; }
  return { list, i, b, k, q: b[k] };
}
const nSelOf = (q) => nSel[q.id] || (nSel[q.id] = { choice: (q.draft && q.draft.choice) || "", text: (q.draft && q.draft.text) || "" });
const nAgo = (iso) => { const s = (Date.now() - Date.parse(iso)) / 1000; return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`; };
const NIMG = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;
function nShot(q, path, label) {
  if (!NIMG.test(path || "")) return `<figure><div class="ph">${esc(base(path) || "no file")}</div>${label}</figure>`;
  const f = nFull.push({ pic: `${q._box}|${q.cwd}|${path}`, box: q._box, path, cwd: q.cwd, label }) - 1;
  return `<figure><img data-act="full" data-f="${f}" data-pic="${f}" alt="${label}" title="${esc(path)}">${label}</figure>`;
}
function nExample(q, e) {
  if (!e) return "";
  const note = e.note ? ` title="${esc(e.note)}"` : "";
  if (e.type === "visual") {
    const src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(e.svg || "");   // an image: nothing in it can run
    const f = nFull.push({ src, label: "drawing" }) - 1;
    return `<img class="nvis" data-act="full" data-f="${f}" src="${esc(src)}" alt="drawing"${note}>`;
  }
  if (e.type === "image") return `<div class="npair"${note}>${nShot(q, e.before, "Before")}${nShot(q, e.after, "After")}</div>`;
  if (e.type === "code") {
    const bench = (e.bench || []).map((x) => `${x.name}: ${x.before} -> ${x.after} (${x.measured ? "measured" : "estimated"})`).join("\n");
    const f = nFull.push({ text: `${e.diff || ""}\n\n${bench}`, label: "code change + benchmark" }) - 1;
    const lines = String(e.diff || "").split("\n").slice(0, 6).map((l) =>
      `<span class="${l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : ""}">${esc(l) || " "}</span>`).join("\n");
    return `<div class="ndraft" data-act="full" data-f="${f}"${note}>${lines}</div>`;
  }
  if (e.type === "text") {
    const f = nFull.push({ text: e.draft || "", label: "draft" }) - 1;
    return `<div class="ndraft" data-act="full" data-f="${f}"${note}>${esc(e.draft || "")}</div>`;
  }
  return "";
}
function renderNeed() {
  if (layer !== "need") return;
  const { list, i, b, k, q } = nNow();
  const pg = `<b data-act="prev" class="${i > 0 ? "" : "off"}">‹</b>${list.length ? i + 1 : 0} / ${list.length}<b data-act="next" class="${i < list.length - 1 ? "" : "off"}">›</b>`;
  if (pg !== nPgHtml) $("npg").innerHTML = nPgHtml = pg;
  nFull = [];
  let h = "", act = "";
  if (!window.FB || !FB.signedIn()) h = `<div class="nempty">Not signed in: right click > Sign in with Google to see what waits for you.</div>`;
  else if (!nItems) h = `<div class="nempty">${esc(nErr || "loading the asks from your boxes...")}</div>`;
  else if (!q) h = `<div class="nempty">Nothing waits for you.</div>`;
  else {
    const pk = `${q._box}|${q.planId}`, plan = q.planId ? nPlans.get(pk) : "";
    if (q.planId && plan == null) {
      nPlans.set(pk, "");
      FB.planTitle(q._box, q.planId).then((t) => { nPlans.set(pk, t || ""); renderNeed(); }, () => {});
    }
    const meta = q.kind === "question"
      ? [q.machine, plan || q.workType, q.planId ? `round ${q.round || 0}` : "", `question ${k + 1} of ${b.length}`, nAgo(q.createdAt)]
      : [q.machine, q.workType, NKIND[q.kind] || q.kind, nAgo(q.createdAt)];
    h += `<div class="nmeta">${esc(meta.filter(Boolean).join(" · "))}</div><div class="nq">${esc(q.title)}</div>`;
    if (q.kind === "approval") h += `<div class="nctx call">${esc(q.text)}</div>`;
    else if (q.text && q.text !== q.title) h += `<div class="nctx">${esc(q.text)}</div>`;
    if (b.length > 1) h += `<div class="ndots">${b.map((x, n) => `<i data-act="q" data-i="${n}" class="${n === k ? "now" : x.draft ? "saved" : ""}" title="question ${n + 1}${x.draft ? ": saved" : ""}"></i>`).join("")}</div>`;
    const sel = nSelOf(q), picks = sel.choice.split(", ");
    const pickable = q.kind === "question" && nOpen(q);
    if (q.kind !== "approval" && (q.options || []).length) {
      h += `<div class="ncards">` + q.options.map((o, n) => {
        const on = q.multi ? picks.includes(o.label) : sel.choice === o.label;
        return `<div class="ncard${on ? " sel" : ""}${q.multi ? " multi" : ""}${pickable ? "" : " dis"}" data-act="pick" data-i="${n}"><span class="rad"></span>`
          + `<div class="tx"><span class="l">(${String.fromCharCode(97 + n)}) ${esc(o.label)}</span>${q.recommended === n ? `<span class="rec">REC</span>` : ""}`
          + `${o.detail ? `<div class="d">${esc(o.detail)}</div>` : ""}${o.differs ? `<div class="df">≠ ${esc(o.differs)}</div>` : ""}</div>`
          + nExample(q, o.example) + `</div>`;
      }).join("") + `</div>`;
    }
    const dash = `<button type="button" class="o" data-act="open">OPEN ON DASHBOARD</button>`;
    if (q.kind === "approval") act = `<button type="button" data-act="allow">ALLOW</button><button type="button" class="no" data-act="deny">DENY</button>`;
    else if (q.kind === "suggestion") act = `<button type="button" data-act="accept">ACCEPT</button><button type="button" class="no" data-act="decline">DECLINE</button>`;
    else if (q.kind === "result") act = `<button type="button" data-act="reviewed">MARK REVIEWED</button>`;
    else if (b.length === 1) act = `<button type="button" data-act="answer">ANSWER</button>`;
    else {
      const open = b.filter(nOpen), ready = open.length && open.every((x) => x.draft);
      act = `<button type="button" data-act="save">${q.draft ? "CHANGE, NEXT" : "SAVE, NEXT"}</button>`
        + (ready ? `<button type="button" data-act="sendall">SEND ${open.length} ANSWERS</button>` : "");
    }
    act += dash;
  }
  if (nBusy) act = act.replace(/<button /g, "<button disabled ");
  let changed = false;
  if (h !== nHtml) { $("nbody").innerHTML = nHtml = h; changed = true; nFill(); }
  if (act !== nActHtml) { $("nact").innerHTML = nActHtml = act; changed = true; }
  const note = $("nnote");
  if (note.hidden !== !q) { note.hidden = !q; changed = true; }
  if (q && nCur !== q.id) { nCur = q.id; note.value = nSelOf(q).text; }
  const left = b && b.length > 1 ? b.filter((x) => nOpen(x) && !x.draft).length : 0;
  const say = nSay || (b && b.length > 1 ? `${b.length - left} of ${b.length} saved · all ${b.length} go together after the last` : "");
  setText($("nsay"), say);
  const sc = nSayBad ? "nsay bad" : "nsay"; if ($("nsay").className !== sc) $("nsay").className = sc;
  const boxesN = new Set((nItems || []).map((x) => x._box)).size;
  setText($("nfoot"), `${(nItems || []).length} waiting on ${boxesN} box${boxesN === 1 ? "" : "es"} · oldest first · click a picture: full size · listens only while open`);
  if (changed && shown === "need") fit();
}
// the pictures of the shown ask, from the box that asked (main.rs box_picture); kept only while the deck is open
function nFill() {
  for (const img of document.querySelectorAll("#nbody img[data-pic]")) {
    const x = nFull[Number(img.dataset.pic)];
    if (!x) continue;
    const got = nPicSrc.get(x.pic);
    if (typeof got === "string") { if (img.src !== got) img.src = got; continue; }
    if (got && got.err) { img.replaceWith(Object.assign(document.createElement("div"), { className: "ph", textContent: `${base(x.path)}: ${got.err}` })); continue; }
    if (got) continue;   // asked already
    nPicSrc.set(x.pic, { asking: true });
    FB.picture(x.box, x.path, x.cwd).then((src) => nPicSrc.set(x.pic, src), (e) => nPicSrc.set(x.pic, { err: String(e.message || e).slice(0, 60) }))
      .then(() => { if (layer === "need") nFill(); });
  }
}
function nShowFull(x) {
  const el = $("nfull");
  if (!x) { if (!el.hidden) { el.hidden = true; el.replaceChildren(); } return; }
  el.replaceChildren();
  if (x.text != null) el.append(Object.assign(document.createElement("pre"), { textContent: x.text }));
  else {
    const src = x.src || nPicSrc.get(x.pic);
    if (typeof src !== "string") return;
    el.append(Object.assign(document.createElement("img"), { src, alt: x.label }));
  }
  el.append(Object.assign(document.createElement("span"), { textContent: `${x.label}${x.path ? " · " + x.path : ""} · click to close` }));
  el.dataset.act = "close"; el.hidden = false;
}
// the page's own writes (web/src/data.ts): answerItem, saveDraft, sendBatch, on the box that holds the ask
const nAnswer = (q, choice, text) => FB.needsWrite(q._box, q.id, { status: "answered", answer: { choice, text, at: new Date().toISOString() }, error: null });
async function nDraft(q, choice, text) {
  const at = new Date().toISOString(), draft = { choice, text, at };
  const thread = [...(q.thread || []), { who: "owner", kind: "answer", choice, text, at }];
  await FB.needsWrite(q._box, q.id, { draft, thread });
  q.draft = draft; q.thread = thread;   // shown at once; the next read of the box brings the same
}
async function nRun(f) {
  nBusy = true; nSay = "sending..."; nSayBad = false; renderNeed();
  try { await f(); nSay = ""; } catch (e) { nSay = "not sent: " + String(e.message || e).slice(0, 80); nSayBad = true; }
  nBusy = false; renderNeed();
}
function needAct(el) {
  const a = el.dataset.act, { list, i, b, k, q } = nNow();
  if (a === "close") return nShowFull(null);
  if (a === "full") return nShowFull(nFull[Number(el.dataset.f)]);
  if (a === "prev" || a === "next") { const j = i + (a === "next" ? 1 : -1); if (list[j]) { nKey = nKeyOf(list[j]); nSay = ""; nShowFull(null); renderNeed(); } return; }
  if (!q || nBusy) return;
  if (a === "open") return void invoke("open_item", { id: q.id }).catch(() => {});
  if (a === "q") { nQ[nKey] = Number(el.dataset.i); nSay = ""; return renderNeed(); }
  const sel = nSelOf(q), text = sel.text.trim();
  if (a === "pick") {
    if (q.kind !== "question" || !nOpen(q)) return;
    const o = q.options[Number(el.dataset.i)].label;
    if (q.multi) {
      const now = sel.choice.split(", ").filter(Boolean), next = now.includes(o) ? now.filter((l) => l !== o) : [...now, o];
      sel.choice = q.options.map((x) => x.label).filter((l) => next.includes(l)).join(", ");   // in the offered order, as the page joins it
    } else sel.choice = sel.choice === o ? "" : o;
    nSay = ""; nSayBad = false; return renderNeed();
  }
  if (a === "allow" || a === "deny") return nRun(() => nAnswer(q, a === "allow" ? "Allow" : "Deny", text));
  if (a === "accept" || a === "decline") return nRun(() => nAnswer(q, a === "accept" ? "Accept" : "Decline", text));
  if (a === "reviewed") return nRun(() => nAnswer(q, text ? "Reviewed, see note" : "", text));
  if (a === "answer" || a === "save") {
    if (!sel.choice && !text) { nSay = "Pick an option or write an answer first."; nSayBad = true; return renderNeed(); }
    if (a === "answer") return nRun(async () => { await nDraft(q, sel.choice, text); await nAnswer(q, sel.choice, text); });
    return nRun(async () => {
      await nDraft(q, sel.choice, text);
      const n = b.findIndex((x, j) => j > k && nOpen(x) && !x.draft), m = b.findIndex((x) => nOpen(x) && !x.draft);
      nQ[nKey] = n >= 0 ? n : m >= 0 ? m : k;   // the next question still to answer; the last one stays for Send
    });
  }
  if (a === "sendall") {
    const open = b.filter(nOpen);
    if (open.some((x) => !x.draft)) { nSay = "Save an answer for every question first."; nSayBad = true; return renderNeed(); }
    return nRun(async () => { for (const x of open) await nAnswer(x, x.draft.choice, x.draft.text); });
  }
}
$("nnote").addEventListener("input", (e) => { const { q } = nNow(); if (q) nSelOf(q).text = e.target.value; nSay = ""; nSayBad = false; setText($("nsay"), ""); });
function needOn() {
  nItems = null; nErr = ""; nHtml = nActHtml = nPgHtml = null; nCur = null;
  if (window.FB && FB.signedIn()) FB.needsOpen((items) => { nItems = items; nErr = ""; renderNeed(); }, (e) => { nErr = String(e); if (!nItems) renderNeed(); });
  renderNeed();
}
function needOff() { if (window.FB) FB.needsClose(); nItems = null; nPicSrc.clear(); nPlans.clear(); nShowFull(null); }

// (d) the hotkey composer (plan c5cb9485 s5). The owner's pick (round 2): "Set in menu": right click > Hotkey opens
// this box; the keys pressed here are set at once (hotkey.rs registers them first, so a combo another app or the
// system holds is refused and the old key stays). The key, pressed with any app in front, opens node 3 here.
let keyOld = "";
const KMOD = ["Control", "Shift", "Alt", "Meta", "AltGraph", "OS"];
function keyName(e) {
  // the key's place on the keyboard (e.code); a key with no place (some remote or injected input) by its name
  const c = e.code || (e.key === " " ? "Space" : e.key && e.key.length === 1 ? (/[a-z]/i.test(e.key) ? "Key" + e.key.toUpperCase() : /\d/.test(e.key) ? "Digit" + e.key : "") : e.key || "");
  const k = /^Key[A-Z]$/.test(c) ? c.slice(3) : /^Digit\d$/.test(c) ? c.slice(5) : c;
  return [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super", k].filter(Boolean).join("+");
}
function keyShow(cap, cls, say, scls) {
  setText($("kcap"), cap); $("kcap").className = "kcap" + (cls ? " " + cls : "");
  setText($("ksay"), say); $("ksay").className = "ksay" + (scls ? " " + scls : "");
}
async function keySet(combo) {
  try {
    const got = await invoke("hotkey_set", { combo });
    keyOld = got; keyErr = ""; setText($("know"), got || "none");
    keyShow(got || "cleared", "ok", got ? `set: press ${got} with any app in front to open SEND` : "no key now", "ok");
  } catch (e) { keyShow(combo, "bad", String(e), "bad"); }
}
T.event.listen("hotkey-capture", (e) => {
  keyOld = String(e.payload || ""); setText($("know"), keyOld || "none");
  keyShow("press the keys...", "", "Ctrl, Alt, Shift or Win + a key · Esc closes");
  go("key"); window.focus();
});
window.addEventListener("keydown", (e) => {
  if (layer !== "key") return;
  e.preventDefault();
  if (e.key === "Escape") return void go("menu");
  if (KMOD.includes(e.key)) { keyShow(keyName(e) + "+...", "", "now the key"); return; }
  const combo = keyName(e);
  keyDown.add(e.code);
  if (!(e.ctrlKey || e.altKey || e.shiftKey || e.metaKey)) return keyShow(combo, "bad", "add Ctrl, Alt, Shift or Win to the key", "bad");
  keyShow(combo, "", "setting...");
  keySet(combo);
});
T.event.listen("hotkey", () => {
  if (layer !== "send") go("send");
  setTimeout(() => $("smsg").focus(), 400);   // type at once
  voiceOn();                                   // s6: "Hotkey = SEND + mic on"
});
T.event.listen("hotkey-error", (e) => { keyErr = String(e.payload); rowsHtml = null; show(); });
// a combo another app holds never reaches this window as a key press (the system hands it to that app), only its
// release does: a key let go that was never seen going down is a taken combo
const keyDown = new Set();
window.addEventListener("keyup", (e) => {
  if (layer !== "key" || KMOD.includes(e.key)) return;
  if (keyDown.delete(e.code)) return;
  keyShow(keyName(e), "bad", `${keyName(e)} is taken by another app or the system: pick another`, "bad");
});

// (b) the voice toggle, English (plan c5cb9485 s6). The owner's words (2026-11-14): "no need to hold, use toggle just
// click and mic on to use speech to text until I click send"; pick "Hotkey = SEND + mic on". The s5 key or the MIC
// button turns the mic on (voice.rs); each piece of speech, cut at a pause, is written into the message as text. Send
// turns the mic off, waits for the last piece, then sends; Esc or closing the box turns it off and drops the rest.
let vOn = false, vEngine = "", vSrc = "", vAt = 0, vTick = null, vErr = "";
function voiceLine() {
  const el = $("svoice");
  const t = vOn ? `● MIC ON · ${vEngine || "starting"} · ${mmss((Date.now() - vAt) / 1000)} · Send, Esc or close turns it off` : vErr;
  setText(el, t); el.className = vErr && !vOn ? "svoice bad" : "svoice";
  if (el.hidden !== !t) { el.hidden = !t; if (shown === "send") fit(); }
  $("smic").classList.toggle("on", vOn); setText($("smic"), vOn ? "● MIC" : "MIC");
}
async function voiceOn() {
  if (vOn) return;
  vErr = ""; vOn = true; vEngine = ""; vAt = Date.now(); voiceLine();
  try { vSrc = await invoke("voice_start"); }
  catch (e) { vOn = false; vErr = "mic: " + String(e); voiceLine(); return; }
  clearInterval(vTick); vTick = setInterval(voiceLine, 1000);
}
async function voiceOff(flush) {
  if (!vOn) return;
  if (!flush) vOn = false;   // Esc / close: text still on its way is dropped
  clearInterval(vTick); vTick = null; voiceLine();
  try { await invoke("voice_stop", { flush }); } catch (_) {}
  vOn = false; voiceLine();
}
async function sendVoice() {
  if (vOn) { setText($("snote"), "last words..."); await voiceOff(true); }
  send();
}
T.event.listen("voice-state", (e) => { const p = e.payload || {}; if (p.on) { vEngine = p.engine + (p.why ? ` (${p.why})` : ""); voiceLine(); } });
T.event.listen("voice-text", (e) => {
  const p = e.payload || {};
  if (!vOn) return;
  if (p.error) { vErr = `voice: ${p.error}`; return; }
  if (!p.text) return;
  const m = $("smsg");
  m.value = (m.value && !/\s$/.test(m.value) ? m.value + " " : m.value) + p.text;
  sNote = ""; sendReady();
});
window.addEventListener("keydown", (e) => { if (e.key === "Escape" && layer === "send" && vOn) { e.preventDefault(); voiceOff(false); } });
