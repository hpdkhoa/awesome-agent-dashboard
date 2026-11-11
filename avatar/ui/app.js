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
let layer = "closed";      // closed | menu | box
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
  if (state === "menu") r.push([b1[0] + 30, b1[1] - 14, b1[0] + 130, b1[1] + 14]);  // the STATUS label on hover
  if (state === "box") {
    const w = $("wrap").getBoundingClientRect(), z = zoom || 1;
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
  $("b1").classList.toggle("on", next === "box");
  if (next === "box") load();
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
setInterval(() => { if (layer === "box") load(); }, 2000);
