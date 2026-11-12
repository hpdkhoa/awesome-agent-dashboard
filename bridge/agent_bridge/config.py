"""Settings from the repo's .env (never committed) and where the bridge keeps its own files on this machine."""

from __future__ import annotations

import os
import socket
from dataclasses import dataclass
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def read_env(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip("'\"")
    return env


def save_roots(roots: list[tuple[str, str]], env_path: Path | None = None) -> None:
    """Writes WORK_ROOTS in .env from roots (step i4: a folder added on the page). Only that line changes; every other
    line stays as it was. Written to a side file first, then swapped in, so a crash never leaves half a .env."""
    path = env_path or REPO / ".env"
    line = "WORK_ROOTS=" + ";".join(f"{n}={r}" for n, r in roots)
    raw = path.read_bytes().decode("utf-8") if path.exists() else ""
    eol = "\r\n" if "\r\n" in raw else "\n"  # the file's own line ends and last line end are kept
    old = raw.splitlines()
    hit = [i for i, x in enumerate(old) if x.strip().startswith("WORK_ROOTS=")]
    new = [line if hit and i == hit[-1] else x for i, x in enumerate(old) if i not in hit[:-1]]
    if not hit:
        new.append(line)
    side = path.with_name(path.name + ".new")
    end = eol if not raw or raw.endswith(("\n", "\r")) or not hit else ""
    side.write_bytes((eol.join(new) + end).encode("utf-8"))
    os.replace(side, path)


def root_refusal(name: str, folder: str, roots: list[tuple[str, str]], home: Path | None = None) -> str | None:
    """Why a folder can't be added from the page, or None (step i4, the owner's choice, 2026-11-12: "Bridge checks":
    the folder exists, is not a drive root or the user folder, is not inside AppData or .ssh). A folder that holds the
    user folder (C:\\Users) is refused as the user folder, since it would show it."""
    import re

    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 _-]{0,39}", name or ""):
        return "A name is 1 to 40 letters, digits, spaces, - or _."
    if any(n.lower() == name.lower() for n, _ in roots):
        return f"The name {name} is already used."
    if not folder or not os.path.isabs(folder):
        return "Give the whole path, such as K:\\Projects\\new."
    full = Path(os.path.realpath(folder))
    if not full.is_dir():
        return "No such folder on this PC."
    if full.parent == full:
        return "A drive root can't be a work folder."
    home_n = str(Path(os.path.realpath(home or Path.home()))).replace("\\", "/").rstrip("/").lower()
    norm = lambda p: str(p).replace("\\", "/").rstrip("/").lower()
    if norm(full) == home_n or home_n.startswith(norm(full) + "/"):
        return "Your user folder (or a folder holding it) can't be a work folder."
    parts = [p.lower() for p in full.parts]
    if "appdata" in parts or ".ssh" in parts:
        return "A folder inside AppData or .ssh can't be a work folder."
    if any(norm(full) == norm(os.path.realpath(r)) for _, r in roots):
        return "That folder is already a work folder."
    return None


def data_dir() -> Path:
    """The bridge's own folder, outside the repo: %APPDATA% on Windows, ~/.config elsewhere."""
    base = os.environ.get("APPDATA") or os.path.join(Path.home(), ".config")
    d = Path(base) / "awesome-agent-dashboard"
    d.mkdir(parents=True, exist_ok=True)
    return d


@dataclass
class Config:
    project_id: str
    api_key: str
    machine: str
    logs: Path
    roots: list[tuple[str, str]]
    claude_bin: str = ""
    owner_email: str = ""  # the VAPID contact of the bridge's pushes; stays on this machine
    files_url: str = ""  # the public address the owner's Cloudflare Tunnel routes to the file viewer (files.py)
    files_port: int = 8793
    site_origins: tuple[str, ...] = ()  # the page origins allowed to ask the file viewer
    status_port: int = 8794  # the desktop avatar's read-only /status (status.py); 127.0.0.1, never tunnelled
    status_hosts: tuple[tuple[str, str], ...] = ()  # name=host pairs whose ssh and Ollama ports /status checks

    @classmethod
    def load(cls, env_path: Path | None = None) -> Config:
        env = {**read_env(env_path or REPO / ".env"), **os.environ}
        project = env.get("FIREBASE_PROJECT_ID") or env.get("VITE_FIREBASE_PROJECT_ID") or ""
        key = env.get("VITE_FIREBASE_API_KEY", "")
        if not project or not key:
            raise SystemExit("FIREBASE_PROJECT_ID and VITE_FIREBASE_API_KEY must be set in .env")
        roots = []
        for part in env.get("WORK_ROOTS", "").split(";"):
            if "=" in part:
                name, root = part.split("=", 1)
                roots.append((name.strip(), root.strip()))
        logs = Path(env.get("CLAUDE_LOGS") or Path.home() / ".claude" / "projects")
        machine = env.get("MACHINE_NAME") or socket.gethostname()
        origins = tuple(o.strip().rstrip("/") for o in env.get("SITE_ORIGINS", "").split(";") if o.strip())
        hosts = tuple((n.strip(), h.strip()) for n, _, h in
                      (p.partition("=") for p in env.get("STATUS_HOSTS", "").split(";")) if n.strip() and h.strip())
        return cls(project, key, machine, logs, roots, env.get("CLAUDE_BIN", ""), env.get("OWNER_EMAIL", ""),
                   env.get("FILES_URL", "").rstrip("/"), int(env.get("FILES_PORT") or 8793), origins,
                   int(env.get("STATUS_PORT") or 8794), hosts)
