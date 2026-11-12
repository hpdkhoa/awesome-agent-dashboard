// The avatar's Firebase part (plan b73e97ad p11; the owner's picks "C: bridges publish, avatar listens", "All, merged +
// picker"). Built into ../ui/fb.js by build.mjs (the app loads no script from the web). The avatar listens to the
// machines records only: each bridge publishes its own state and the account's counts there (bridge status.py).
// Sign-in: the owner's Google account through the same localhost page the bridge uses (main.rs auth.rs); the Firebase
// user it returns lives in the OS key store and only in this page's memory (session storage) while the app runs.
import { initializeApp } from "firebase/app";
import { initializeAuth, browserSessionPersistence, onIdTokenChanged, signOut } from "firebase/auth";
import { getFirestore, collection, doc, getDocs, limit, onSnapshot, orderBy, query, setDoc, where } from "firebase/firestore";

let app = null, auth = null, db = null, unsub = null;

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
    unsub = onSnapshot(collection(db, "machines"),
      (snap) => { window.FB.reads += Math.max(1, snap.docChanges().length); onMachines(snap.docs.map((d) => ({ id: d.id, ...d.data() }))); },
      (e) => onError(e.code || e.message));
  });
}
async function stop() { ratesClose(); if (unsub) unsub(); unsub = null; if (auth) await signOut(auth); }

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
// reads/writes: Firestore bills one read per changed record delivered (at least one per answer); counted for the checks
window.FB = { start, stop, ratesOpen, ratesClose, saveFx, saveGold, signedIn: () => !!(auth && auth.currentUser), reads: 0, writes: 0 };
