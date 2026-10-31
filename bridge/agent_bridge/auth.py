"""The bridge signs in once as the owner, through Google, and keeps only a Firebase refresh token on this machine.

Sign-in: the bridge serves a small page on http://localhost:<port> (localhost is a Firebase authorized domain by
default). The page signs in with Google through the Firebase web SDK and posts the refresh token back to the bridge,
with a one-time code so no other page can post one. The token goes to the OS key store through `keyring` (Windows
Credential Manager, Linux Secret Service, macOS Keychain), or, when the machine has none (a headless Linux box), to a
file only this user can read. It is never written to the repo or to Firestore. No Claude credential is involved.
"""

from __future__ import annotations

import json
import os
import secrets
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer

from .config import Config, data_dir

SERVICE = "awesome-agent-dashboard"
USER = "firebase-refresh-token"
FIREBASE_JS = "https://www.gstatic.com/firebasejs/11.10.0"

PAGE = """<!doctype html><meta charset="utf-8"><title>Bridge sign-in</title>
<body style="font:16px system-ui;max-width:420px;margin:15vh auto">
<h1 style="font-size:20px;font-weight:500">Bridge sign-in</h1><p id="s">Click to sign in with your Google account.</p>
<button id="b">Sign in with Google</button>
<script type="module">
import {{ initializeApp }} from "{js}/firebase-app.js";
import {{ getAuth, GoogleAuthProvider, signInWithPopup }} from "{js}/firebase-auth.js";
const auth = getAuth(initializeApp({{ apiKey: "{key}", authDomain: "{project}.firebaseapp.com", projectId: "{project}" }}));
const s = document.getElementById("s");
document.getElementById("b").onclick = async () => {{
  try {{
    const r = await signInWithPopup(auth, new GoogleAuthProvider());
    await fetch("/done?code={code}", {{ method: "POST", body: r.user.refreshToken }});
    s.textContent = "Signed in. You can close this tab.";
  }} catch (e) {{ s.textContent = "Sign-in failed: " + (e.code || e.message); }}
}};
</script>"""


def _file() -> str:
    return os.path.join(data_dir(), "token")


def _keyring():
    try:
        import keyring
        from keyring.backends import fail

        kr = keyring.get_keyring()
        return None if isinstance(kr, fail.Keyring) else kr
    except Exception:
        return None


def save_token(token: str) -> str:
    kr = _keyring()
    if kr is not None:
        kr.set_password(SERVICE, USER, token)
        return "the OS key store"
    path = _file()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(token)
    return path


def load_token() -> str | None:
    kr = _keyring()
    if kr is not None:
        t = kr.get_password(SERVICE, USER)
        if t:
            return t
    try:
        with open(_file()) as f:
            return f.read().strip() or None
    except OSError:
        return None


def sign_in(cfg: Config, port: int = 0, open_browser: bool = True, timeout: float = 300) -> str:
    """Serves the sign-in page, waits for the token, stores it. Returns where it was stored."""
    code = secrets.token_urlsafe(24)
    got: dict[str, str] = {}
    page = PAGE.format(js=FIREBASE_JS, key=cfg.api_key, project=cfg.project_id, code=code).encode()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(page)

        def do_POST(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            body = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode()
            ok = q.get("code") == [code] and body and "token" not in got
            if ok:
                got["token"] = body
            self.send_response(204 if ok else 403)
            self.end_headers()

    srv = HTTPServer(("127.0.0.1", port), Handler)
    url = f"http://localhost:{srv.server_address[1]}/"
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print(f"Open {url} and sign in with your Google account.")
    if open_browser:
        webbrowser.open(url)
    end = time.time() + timeout
    while "token" not in got and time.time() < end:
        time.sleep(0.2)
    srv.shutdown()
    if "token" not in got:
        raise SystemExit("No sign-in within the time limit.")
    return save_token(got["token"])


class Session:
    """A Firebase ID token for the owner, refreshed from the stored refresh token when it is near expiry."""

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.refresh = load_token()
        if not self.refresh:
            raise SystemExit("Not signed in. Run: python -m agent_bridge signin")
        self.id_token = ""
        self.expires = 0.0

    def token(self) -> str:
        if time.time() > self.expires - 300:
            body = urllib.parse.urlencode({"grant_type": "refresh_token", "refresh_token": self.refresh}).encode()
            url = f"https://securetoken.googleapis.com/v1/token?key={self.cfg.api_key}"
            with urllib.request.urlopen(urllib.request.Request(url, data=body), timeout=30) as r:
                d = json.load(r)
            self.id_token = d["id_token"]
            self.expires = time.time() + int(d.get("expires_in", 3600))
            if d.get("refresh_token") and d["refresh_token"] != self.refresh:
                self.refresh = d["refresh_token"]
                save_token(self.refresh)
        return self.id_token
