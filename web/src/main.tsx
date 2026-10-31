import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { onAuthStateChanged, signInWithPopup, signOut, type User } from "firebase/auth";
import { auth, google } from "./firebase";
import { checkOwner } from "./owner";

type State = { kind: "loading" } | { kind: "out"; refused: boolean } | { kind: "in"; user: User };

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
        <button onClick={() => signInWithPopup(auth, google).catch(() => undefined)}>Sign in with Google</button>
      </main>
    );
  return (
    <main className="card">
      <h1>Agent dashboard</h1>
      <p>Signed in as {state.user.displayName ?? "the owner"}.</p>
      <button onClick={() => signOut(auth)}>Sign out</button>
    </main>
  );
}

const css = `
:root { color-scheme: light dark; --bg: #f6f6f4; --fg: #1d1d1b; --card: #fff; --line: #d6d4cc; --bad: #a32d2d; }
@media (prefers-color-scheme: dark) { :root { --bg: #171716; --fg: #ecebe6; --card: #222220; --line: #3a3a37; --bad: #f09595; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 system-ui, sans-serif; }
.card { max-width: 420px; margin: 15vh auto; padding: 24px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; }
h1 { font-size: 20px; font-weight: 500; margin: 0 0 12px; }
button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: inherit; cursor: pointer; }
.bad { color: var(--bad); }
`;
document.head.appendChild(Object.assign(document.createElement("style"), { textContent: css }));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
