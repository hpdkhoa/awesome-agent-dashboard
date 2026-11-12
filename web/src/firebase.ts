import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from "firebase/firestore";

// Public config by design: the Firestore rules are the lock. The owner's email is never in the web build.
const app = initializeApp({
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
});

export const auth = getAuth(app);
// The persistent cache (IndexedDB), shared by every open tab (the owner's words, 2026-11-13: "build the cache too"): one
// tab's listeners feed all tabs, and a reload or a return re-reads only the documents that changed since the cache
// saw them. The home-screen app keeps it too. Show more pages still read from the server.
export const db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

// Google is the only sign-in this page offers.
export const google = new GoogleAuthProvider();
google.setCustomParameters({ prompt: "select_account" });
