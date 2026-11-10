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
