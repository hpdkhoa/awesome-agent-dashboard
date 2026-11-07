"""The file viewer: the page shows a file from this machine, sent straight from here, never stored (the owner's idea,
2026-11-01: "how about open connection without store the file? just move binary to render it on the page using my
local instance?", then "do 1": through a Cloudflare Tunnel).

A small HTTP server on 127.0.0.1 only. The owner's Cloudflare Tunnel routes FILES_URL to it; the bridge never changes
the tunnel. Two calls:

- POST /ticket with the owner's Firebase ID token and {path, cwd}: checks the token (Google's signature, this project,
  the owner's verified Google email, the same lock as the Firestore rules), resolves the path inside a WORK_ROOTS
  folder, and returns a ticket URL that works for 10 minutes.
- GET /t/<ticket>/<path in that root>: the file's bytes. The ticket covers the file's root, so an html page also loads
  its own images and css. Nothing outside WORK_ROOTS is ever served.

Every answer carries no-store, no-referrer and a sandbox CSP (an html page runs with no origin of its own, so it can
never reach the dashboard or the sign-in).
"""

from __future__ import annotations

import json
import mimetypes
import os
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

TICKET_SECONDS = 600
JWK_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken%40system.gserviceaccount.com"
CHUNK = 64 * 1024
SANDBOX = "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads"

KINDS = {
    "image": {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".avif"},
    "html": {".html", ".htm"},
    "pdf": {".pdf"},
    "md": {".md", ".markdown"},
    "video": {".mp4", ".webm", ".mov"},
    "text": {".txt", ".log", ".json", ".jsonl", ".csv", ".tsv", ".py", ".ts", ".tsx", ".js", ".mjs", ".go", ".rs", ".c",
             ".h", ".cpp", ".cu", ".css", ".yml", ".yaml", ".toml", ".ini", ".sh", ".ps1", ".sql", ".xml"},
}


# never served, even inside WORK_ROOTS: env files, keys, credentials
SECRET_NAMES = (".env", "id_rsa", "id_ed25519", "credentials", ".npmrc", ".netrc", ".pypirc")
SECRET_EXTS = {".pem", ".key", ".p12", ".pfx", ".keystore", ".jks"}


def secret(name: str) -> bool:
    n = os.path.basename(name).lower()
    return n.startswith(SECRET_NAMES) or os.path.splitext(n)[1] in SECRET_EXTS


def kind_of(name: str) -> str:
    ext = os.path.splitext(name)[1].lower()
    return next((k for k, exts in KINDS.items() if ext in exts), "file")


def clean(path: str) -> str:
    """A path as a session wrote it: `code`, file:///, a #anchor or a :line suffix, url-encoded spaces."""
    p = path.strip().strip("`'\"<>")
    if p.lower().startswith("file:"):
        p = urlsplit(p).path
        if len(p) > 2 and p[0] == "/" and p[2] == ":":
            p = p[1:]
    p = unquote(p.split("#", 1)[0].split("?", 1)[0])
    head, sep, tail = p.rpartition(":")
    if sep and tail.isdigit() and len(head) > 2:  # web/a.html:42, but not K:
        p = head
    return p


def _norm(p: str) -> str:
    return os.path.normcase(os.path.realpath(p))


def inside(path: str, root: str) -> bool:
    p, r = _norm(path), _norm(root)
    return p == r or p.startswith(r.rstrip(os.sep) + os.sep)


def firebase_verifier(project_id: str, owner_email: str):
    """Checks a Firebase ID token like the Firestore rules do: signed by Google for this project, the owner's verified
    email, signed in with Google."""
    import jwt

    jwks = jwt.PyJWKClient(JWK_URL, cache_keys=True, lifespan=3600)

    def verify(token: str) -> None:
        key = jwks.get_signing_key_from_jwt(token).key
        c = jwt.decode(token, key, algorithms=["RS256"], audience=project_id,
                       issuer=f"https://securetoken.google.com/{project_id}", leeway=30)
        if not (owner_email and c.get("email") == owner_email and c.get("email_verified") is True
                and (c.get("firebase") or {}).get("sign_in_provider") == "google.com"):
            raise PermissionError("not the owner")

    return verify


class Files:
    def __init__(self, roots: list[tuple[str, str]], verify, clock=time.time):
        self.roots = [r for _, r in roots if r]
        self.verify, self.clock = verify, clock
        self.tickets: dict[str, tuple[str, float]] = {}  # ticket -> (root, expiry)
        self.lock = threading.Lock()

    def resolve(self, path: str, cwd: str) -> tuple[str, str]:
        """(root, the file's path inside it, with /). Raises ValueError with the reason."""
        p = clean(path)
        if not p:
            raise ValueError("no path")
        full = p if os.path.isabs(p) else os.path.join(cwd or "", p)
        if not os.path.isabs(full):
            raise ValueError("a relative path with no folder")
        root = next((r for r in self.roots if inside(full, r)), None)
        if root is None:
            raise ValueError("outside WORK_ROOTS")
        real = os.path.realpath(full)
        if not os.path.isfile(real):
            raise ValueError("no such file")
        if secret(real):
            raise ValueError("a secret file is never sent")
        return root, os.path.relpath(real, os.path.realpath(root)).replace(os.sep, "/")

    def ticket(self, token: str, path: str, cwd: str) -> dict:
        self.verify(token)
        root, rel = self.resolve(path, cwd)
        t = secrets.token_urlsafe(24)
        now = self.clock()
        with self.lock:
            self.tickets = {k: v for k, v in self.tickets.items() if v[1] > now}
            self.tickets[t] = (root, now + TICKET_SECONDS)
        full = os.path.join(os.path.realpath(root), rel)
        return {"url": f"/t/{t}/{quote(rel)}", "name": os.path.basename(rel), "path": rel,
                "kind": kind_of(rel), "size": os.path.getsize(full), "dir": os.path.dirname(full)}

    def open(self, ticket: str, rel: str) -> str | None:
        """The file a ticket URL points to, or None (unknown or old ticket, outside its root, not a file)."""
        with self.lock:
            root, exp = self.tickets.get(ticket, ("", 0.0))
        if not root or exp <= self.clock():
            return None
        full = os.path.join(os.path.realpath(root), unquote(rel))
        return full if inside(full, root) and os.path.isfile(full) and not secret(full) else None


def handler(files: Files, origins: list[str]):
    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):  # the bridge log stays quiet: no paths, no tickets
            pass

        def _head(self, status: int, ctype: str, length: int, extra: dict | None = None) -> None:
            self.send_response(status)
            origin = self.headers.get("Origin", "")
            if origin in origins:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(length))
            self.send_header("Cache-Control", "private, no-store")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Content-Type-Options", "nosniff")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()

        def _json(self, status: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self._head(status, "application/json", len(data))
            self.wfile.write(data)

        def do_OPTIONS(self):
            self._head(204, "text/plain", 0, {"Access-Control-Allow-Methods": "POST, GET",
                                              "Access-Control-Allow-Headers": "Authorization, Content-Type",
                                              "Access-Control-Max-Age": "600"})

        def do_POST(self):
            if self.path != "/ticket":
                return self._json(404, {"error": "not found"})
            auth = self.headers.get("Authorization", "")
            try:
                body = json.loads(self.rfile.read(min(int(self.headers.get("Content-Length") or 0), 8192)) or b"{}")
                if not auth.startswith("Bearer "):
                    raise PermissionError("no sign-in")
                self._json(200, files.ticket(auth[7:], str(body.get("path", "")), str(body.get("cwd", ""))))
            except ValueError as e:
                self._json(404 if str(e) == "no such file" else 400, {"error": str(e)})
            except Exception:  # a bad, old or foreign token
                self._json(401, {"error": "sign in again"})

        def do_GET(self):
            path, _, query = self.path.partition("?")
            parts = path.split("/", 3)  # "", "t", ticket, rel
            full = files.open(parts[2], parts[3]) if len(parts) == 4 and parts[1] == "t" else None
            if full is None:
                return self._json(404, {"error": "not found or expired"})
            ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype in ("application/json", "image/svg+xml"):
                ctype += "; charset=utf-8"
            # a PDF opens in the browser's own viewer, which a sandbox CSP blocks
            extra = {} if ctype == "application/pdf" else {"Content-Security-Policy": SANDBOX}
            if "download=1" in query.split("&"):  # the Download button (the owner's words, 2026-11-08: "replace the new
                # tab button when see the file by download button"); a cross-site link's download attribute is ignored
                name = os.path.basename(full)
                ascii_name = name.encode("ascii", "replace").decode().replace('"', "_").replace("?", "_")
                extra["Content-Disposition"] = f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name)}"
            size = os.path.getsize(full)
            self._head(200, ctype, size, extra)
            with open(full, "rb") as f:
                while chunk := f.read(CHUNK):
                    self.wfile.write(chunk)

    return H


def serve(files: Files, origins: list[str], port: int) -> ThreadingHTTPServer:
    """Starts the server on 127.0.0.1:port in a daemon thread."""
    srv = ThreadingHTTPServer(("127.0.0.1", port), handler(files, origins))
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv
