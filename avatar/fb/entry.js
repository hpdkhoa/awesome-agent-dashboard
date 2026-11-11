// The avatar's Firebase part (plan b73e97ad p11; the owner's picks "C: bridges publish, avatar listens", "All, merged +
// picker"). Built into ../ui/fb.js by build.mjs (the app loads no script from the web). The avatar listens to the
// machines records only: each bridge publishes its own state and the account's counts there (bridge status.py).
// Sign-in: the owner's Google account through the same localhost page the bridge uses (main.rs auth.rs); the Firebase
// user it returns lives in the OS key store and only in this page's memory (session storage) while the app runs.
import { initializeApp } from "firebase/app";
import { initializeAuth, browserSessionPersistence, onIdTokenChanged, signOut } from "firebase/auth";
import { getFirestore, collection, onSnapshot } from "firebase/firestore";

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
async function stop() { if (unsub) unsub(); unsub = null; if (auth) await signOut(auth); }
// reads: Firestore bills one read per changed record delivered (at least one per answer); counted for the checks
window.FB = { start, stop, reads: 0 };
