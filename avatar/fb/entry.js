// The avatar's Firebase part (plan b73e97ad p11; the owner's picks "C: bridges publish, avatar listens", "All, merged +
// picker"). Built into ../ui/fb.js by build.mjs (the app loads no script from the web). The avatar listens to the
// machines records only: each bridge publishes its own state and the account's counts there (bridge status.py).
// Since 2026-11-13 (the owner's words: "Change the avatar to read the bridge") the records come from the boxes
// themselves: Firestore gives the registry of boxes once (bridges/<name>, asked again every 10 minutes), then each
// plugged box's data API gives its own machines record, live. With no registered box it listens to Firestore, as before.
// Sign-in: the owner's Google account through the same localhost page the bridge uses (main.rs auth.rs); the Firebase
// user it returns lives in the OS key store and only in this page's memory (session storage) while the app runs.
import { initializeApp } from "firebase/app";
import { initializeAuth, browserSessionPersistence, onIdTokenChanged, signOut } from "firebase/auth";
import { getFirestore, collection, doc, getDocs, limit, onSnapshot, orderBy, query, setDoc, where } from "firebase/firestore";

let app = null, auth = null, db = null, unsub = null;

// --- the boxes -------------------------------------------------------------------------------------------------
const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);
const REGISTRY_MS = 10 * 60 * 1000;
let boxes = [], boxRows = new Map(), boxStop = false;
async function ask(box, body) {
  const token = await auth.currentUser.getIdToken();
  return JSON.parse(await invoke("box_data", { url: box.url, token, body: JSON.stringify(body) }));
}
async function readRegistry(onError) {
  try {
    const q = await getDocs(collection(db, "bridges"));
    window.FB.reads += Math.max(1, q.size);
    return q.docs.map((d) => ({ name: d.id, ...d.data() })).filter((b) => b.url && b.plugged !== false && b.db === "local");
  } catch (e) { onError(e.code || e.message); return null; }
}
// One box: its machines records now, then one open "changes" call that answers when something changed there.
async function follow(box, onMachines) {
  let seq = -1;
  while (!boxStop && boxes.includes(box)) {
    try {
      if (seq < 0) seq = (await ask(box, { op: "seq" })).seq;
      const rows = (await ask(box, { op: "find", coll: "machines" })).docs.map((d) => ({ id: d.id, ...d.data }));
      if (boxStop || !boxes.includes(box)) return;
      boxRows.set(box.name, rows);
      window.FB.boxAsks += 1;
      onMachines([...boxRows.values()].flat());
      seq = (await ask(box, { op: "changes", since: seq, wait: 25 })).seq;   // up to 25 s, or at once on a change
    } catch (e) {
      // the box does not answer: its last record stays and ages, so it turns offline after the usual 7 minutes
      seq = -1;
      await new Promise((r) => setTimeout(r, 15000));
    }
  }
}
async function startBoxes(onMachines, onError) {
  boxStop = false;
  const list = await readRegistry(onError);
  if (!list || !list.length) return false;
  boxes = list;
  boxRows = new Map();
  for (const b of boxes) follow(b, onMachines);
  const again = setInterval(async () => {
    if (boxStop) return clearInterval(again);
    const next = await readRegistry(onError);
    if (!next || boxStop) return;
    const same = (a, b) => a.name === b.name && a.url === b.url;
    const kept = boxes.filter((b) => next.some((n) => same(n, b)));
    const fresh = next.filter((n) => !boxes.some((b) => same(n, b)));
    for (const b of boxes) if (!kept.includes(b)) boxRows.delete(b.name);   // unplugged: its record leaves
    boxes = [...kept, ...fresh];
    for (const b of fresh) follow(b, onMachines);                         // plugged in: followed from now
    onMachines([...boxRows.values()].flat());
  }, REGISTRY_MS);
  return true;
}
function stopBoxes() { boxStop = true; boxes = []; boxRows = new Map(); }

// cfg: {apiKey, authDomain, projectId, ownerEmail}; user: the Firebase user JSON from the key store
async function start(cfg, user, onUser, onMachines, onError) {
  if (user) sessionStorage.setItem(`firebase:authUser:${cfg.apiKey}:[DEFAULT]`, user);
  app = initializeApp({ apiKey: cfg.apiKey, authDomain: cfg.authDomain, projectId: cfg.projectId });
  auth = initializeAuth(app, { persistence: browserSessionPersistence });
  db = getFirestore(app);
  onIdTokenChanged(auth, (u) => {
    if (!u) { if (unsub) unsub(); unsub = null; onUser(null); return; }
    if (u.email !== cfg.ownerEmail || !u.emailVerified) {   // only the owner's email (Firestore rules lock it too)
      onError(`refused: ${u.email} is not the owner`); signOut(auth); return;
    }
    onUser(JSON.stringify(u.toJSON()));     // an hourly token refresh: kept in the key store, the listen stays open
    if (unsub) return;
    unsub = () => {};                       // taken while the registry is read, so a token refresh starts nothing twice
    startBoxes(onMachines, onError).then((fromBoxes) => {
      if (fromBoxes) { unsub = stopBoxes; return; }
      // no box keeps its data locally yet: the machines records on Firestore, as before
      unsub = onSnapshot(collection(db, "machines"),
        (snap) => { window.FB.reads += Math.max(1, snap.docChanges().length); onMachines(snap.docs.map((d) => ({ id: d.id, ...d.data() }))); },
        (e) => onError(e.code || e.message));
    });
  });
}
async function stop() { ratesClose(); needsClose(); if (unsub) unsub(); unsub = null; if (auth) await signOut(auth); }

// p15 RATES box: the newest saved rates, the same records the dashboard's Rates tab saves and reads (web/src/moneyData.ts:
// fxRates by savedAt, goldPrices by enteredAt). Listened to only while the box is open (box closed = no reads). The
// change needs each source's newest two records: the newest 12 of each collection hold them; a source with fewer than
// two there is asked once by its own id. src: {fx: ["vcb", "hsbc"], gold: ["giavang"]}
const fxSrc = (d) => d.sourceId ?? "vcb", goldSrc = (d) => d.sourceId ?? "typed";
let rUnsub = [];
function ratesOpen(src, onData, onError) {
  if (!db || rUnsub.length) return;
  const got = { fx: null, gold: null }, extra = { fx: {}, gold: {} }, asked = new Set();
  const send = () => {
    if (!got.fx || !got.gold) return;
    const all = (k, by) => { const m = new Map(); for (const d of [...got[k], ...Object.values(extra[k]).flat()]) m.set(d.id, d); return [...m.values()].sort((a, b) => String(b[by]).localeCompare(String(a[by]))); };
    const fx = all("fx", "savedAt"), gold = all("gold", "enteredAt");
    onData(fx, gold);
    for (const [k, ids, of, col] of [["fx", src.fx, fxSrc, "fxRates"], ["gold", src.gold, goldSrc, "goldPrices"]])
      for (const id of ids) {
        const list = k === "fx" ? fx : gold;
        if (list.filter((d) => of(d) === id).length >= 2 || asked.has(k + id)) continue;
        asked.add(k + id);
        getDocs(query(collection(db, col), where("sourceId", "==", id))).then((q) => {
          window.FB.reads += Math.max(1, q.size); extra[k][id] = q.docs.map((d) => ({ id: d.id, ...d.data() })); send();
        }, (e) => onError(e.code || e.message));
      }
  };
  const listen = (k, col, by) => onSnapshot(query(collection(db, col), orderBy(by, "desc"), limit(12)),
    (q) => { window.FB.reads += Math.max(1, q.docChanges().length); got[k] = q.docs.map((d) => ({ id: d.id, ...d.data() })); send(); },
    (e) => onError(e.code || e.message));
  rUnsub = [listen("fx", "fxRates", "savedAt"), listen("gold", "goldPrices", "enteredAt")];
}
function ratesClose() { for (const u of rUnsub) u(); rUnsub = []; }
// one synced source saved, shaped as the Rates tab saves it (moneyData.ts syncFx / syncGold)
const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 20);
async function saveFx(body, sourceId) {
  const id = newId();
  await setDoc(doc(db, "fxRates", id), { ...body, sourceId, id, savedAt: new Date().toISOString() });
  window.FB.writes += 1;
}
async function saveGold(q) {
  const id = newId();
  await setDoc(doc(db, "goldPrices", id), { ...q, id, date: q.sourceTime.slice(0, 10), note: "", enteredAt: new Date().toISOString() });
  window.FB.writes += 1;
}
// plan c5cb9485 s1: the SEND box's CONTINUE list: one box's sessions, newest first, asked once per open or box change.
// A registered box answers through its own data API; else Firestore (newest 100 by lastAt, this box's kept).
const SESSIONS = 30;
async function sessions(name) {
  const box = boxes.find((b) => b.name === name);
  if (box) {
    const r = await ask(box, { op: "find", coll: "sessions", filters: [["machine", "==", name]], order: "lastAt", desc: true, limit: SESSIONS });
    window.FB.boxAsks += 1;
    return r.docs.map((d) => ({ id: d.id, ...d.data }));
  }
  const q = await getDocs(query(collection(db, "sessions"), orderBy("lastAt", "desc"), limit(100)));
  window.FB.reads += Math.max(1, q.size);
  return q.docs.map((d) => ({ id: d.id, ...d.data() })).filter((d) => d.machine === name).slice(0, SESSIONS);
}
// plan c5cb9485 s2: one command to one box: its data API when the box is registered, else Firestore. Returns the way.
async function send(name, c) {
  const box = boxes.find((b) => b.name === name);
  if (box) {
    const r = await ask(box, { op: "set", path: `commands/${c.id}`, data: c });
    if (!r || r.ok !== true) throw new Error((r && r.error) || "the box refused the command");
    window.FB.boxAsks += 1;
    return "box";
  }
  await setDoc(doc(db, "commands", c.id), c);
  window.FB.writes += 1;
  return "firestore";
}
// plan c5cb9485 s10: the CONFIG box. The allowed keys of a box's .env, masked (the last 4), and one key written there.
// Only through a registered box's data API: a key never goes to Firestore.
async function envKeys(name) {
  const box = boxes.find((b) => b.name === name);
  if (!box) throw new Error("this box has no data API: keys go only to a registered box");
  window.FB.boxAsks += 1;
  return (await ask(box, { op: "env_keys" })).keys;
}
async function envSet(name, key, value) {
  const box = boxes.find((b) => b.name === name);
  if (!box) throw new Error("this box has no data API: keys go only to a registered box");
  const r = await ask(box, { op: "env_set", name: key, value });
  if (!r || r.ok !== true) throw new Error((r && r.error) || "the box refused the key");
  window.FB.boxAsks += 1;
  return r;
}
// plan c5cb9485 s3: a sent command's record and its reply text, asked only while the SEND box is open.
// The record: the box's data API (one get), else Firestore (one read). The text: the box's /text route ({run} when
// ended, {live} while running), never stored; a box with no address has no text (null).
import { getDoc } from "firebase/firestore";
async function runState(name, id) {
  const box = boxes.find((b) => b.name === name);
  if (box) { window.FB.boxAsks += 1; return (await ask(box, { op: "get", path: `commands/${id}` })).doc; }
  const d = await getDoc(doc(db, "commands", id));
  window.FB.reads += 1;
  return d.exists() ? d.data() : null;
}
async function runText(name, id, live) {
  const box = boxes.find((b) => b.name === name);
  if (!box) return null;
  const token = await auth.currentUser.getIdToken();
  window.FB.boxAsks += 1;
  return JSON.parse(await invoke("box_text", { url: box.url, token, body: JSON.stringify(live ? { live: id } : { run: id }) }));
}
// plan c5cb9485 s4: the NEEDS YOU deck. The owner's open asks from every box (inbox status "open"), read only while the
// deck is open: each registered box answers through its data API, then one open "changes" call per box re-reads its
// inbox only when the inbox changed there (deck closed = nothing asked). No registered box: one Firestore listen.
import { updateDoc } from "firebase/firestore";
let nStop = true, nUnsub = null;
const nWait = (ms) => new Promise((r) => setTimeout(r, ms));
function needsOpen(onItems, onError) {
  needsClose();
  nStop = false;
  const got = new Map(), push = () => onItems([...got.values()].flat());
  if (!boxes.length) {
    nUnsub = onSnapshot(query(collection(db, "inbox"), where("status", "==", "open")),
      (q) => { window.FB.reads += Math.max(1, q.docChanges().length); got.set("", q.docs.map((d) => ({ id: d.id, ...d.data(), _box: "" }))); push(); },
      (e) => onError(e.code || e.message));
    return;
  }
  for (const box of boxes.slice()) (async () => {
    let seq = -1;
    while (!nStop && boxes.includes(box)) {
      try {
        if (seq < 0) seq = (await ask(box, { op: "seq" })).seq;
        const r = await ask(box, { op: "find", coll: "inbox", filters: [["status", "==", "open"]] });
        window.FB.boxAsks += 1; window.FB.needAsks += 1;
        if (nStop) return;
        got.set(box.name, r.docs.map((d) => ({ id: d.id, ...d.data, _box: box.name }))); push();
        for (;;) {   // up to 25 s a call; the inbox is read again only when it changed on this box
          const c = await ask(box, { op: "changes", since: seq, wait: 25 });
          seq = c.seq;
          if (nStop) return;
          if (c.reset || (c.changes || []).some((x) => x.coll === "inbox")) break;
        }
      } catch (e) {
        onError(`${box.name}: ${String(e.message || e).slice(0, 60)}`);
        seq = -1; await nWait(15000);
      }
    }
  })();
}
function needsClose() { nStop = true; if (nUnsub) nUnsub(); nUnsub = null; }
// one answer write on one inbox record, on the box that holds it (the fields the page writes: data.ts answerItem, saveDraft)
async function needsWrite(name, id, fields) {
  const box = boxes.find((b) => b.name === name);
  if (box) {
    const r = await ask(box, { op: "update", path: `inbox/${id}`, fields });
    if (!r || r.ok !== true) throw new Error((r && r.error) || "the box refused the answer");
    window.FB.boxAsks += 1;
    return "box";
  }
  await updateDoc(doc(db, "inbox", id), fields);
  window.FB.writes += 1;
  return "firestore";
}
// a plan's title for the deck's line (one get per plan while the deck is open)
async function planTitle(name, id) {
  const box = boxes.find((b) => b.name === name);
  if (box) { window.FB.boxAsks += 1; const d = (await ask(box, { op: "get", path: `plans/${id}` })).doc; return d ? d.title : ""; }
  const d = await getDoc(doc(db, "plans", id));
  window.FB.reads += 1;
  return d.exists() ? d.data().title : "";
}
// a picture of an ask, from the box that asked (main.rs box_picture: its /ticket, then the bytes as a data URL)
async function picture(name, path, cwd) {
  const box = boxes.find((b) => b.name === name);
  if (!box) throw new Error("no box address to load it from");
  const token = await auth.currentUser.getIdToken();
  window.FB.boxAsks += 1; window.FB.pics += 1;
  return invoke("box_picture", { url: box.url, token, path, cwd });
}
// reads/writes: Firestore bills one read per changed record delivered (at least one per answer); counted for the checks
window.FB = { start, stop, sessions, send, envKeys, envSet, runState, runText, needsOpen, needsClose, needsWrite, planTitle, picture, needAsks: 0, pics: 0, ratesOpen, ratesClose, saveFx, saveGold, signedIn: () => !!(auth && auth.currentUser), reads: 0, writes: 0,
  boxAsks: 0, boxes: () => boxes.map((b) => b.name) };
