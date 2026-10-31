import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { onAuthStateChanged, signInWithPopup, type User } from "firebase/auth";
import { auth, google } from "./firebase";
import { checkOwner } from "./owner";
import { Dashboard } from "./Dashboard";
import "./styles.css";

type State = { kind: "loading" } | { kind: "out"; refused: boolean; error?: string } | { kind: "in"; user: User };

function App() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(
    () =>
      onAuthStateChanged(auth, async (user) => {
        if (!user) return setState((s) => ({ kind: "out", refused: s.kind === "out" && s.refused }));
        const gate = await checkOwner(user);
        setState(gate === "owner" ? { kind: "in", user } : { kind: "out", refused: true });
      }),
    [],
  );

  if (state.kind === "loading") return <main className="card">Loading</main>;
  if (state.kind === "out")
    return (
      <main className="card">
        <h1>Agent dashboard</h1>
        {state.refused && <p className="bad">This account is not allowed.</p>}
        {state.error && <p className="bad">Sign-in failed: {state.error}</p>}
        <button
          onClick={() =>
            signInWithPopup(auth, google).catch((e: { code?: string; message?: string }) =>
              setState({ kind: "out", refused: false, error: e.code ?? e.message ?? "unknown error" }),
            )
          }
        >
          Sign in with Google
        </button>
      </main>
    );
  return <Dashboard />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
