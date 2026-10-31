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
        return cls(project, key, machine, logs, roots, env.get("CLAUDE_BIN", ""))
