"""F10 disk and resource check (plan bf73af63; the step: "free disk, RAM, GPU before a run starts; shown in Health; under
the limit the run waits"; its check: "low disk blocks the run with the number").

measure(): free disk on each drive a run writes to (the run's folder, this bridge's data folder, the user folder where
Claude Code keeps its logs), available RAM, and free GPU memory per card (nvidia-smi; none when there is no NVIDIA card).
low(): the readings under their limits, each as a line with its number and its limit. A run whose check is low waits
("waiting", waitReason "resources") and is checked again on every round of the bridge; it starts once all are above.

Limits, in GB, from the environment: AAD_MIN_DISK_GB (default 5), AAD_MIN_RAM_GB (default 2), AAD_MIN_GPU_GB
(default 0: GPU shown, not gated, since a Claude run uses no GPU). 0 turns a check off.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import time
from pathlib import Path

GB = 1 << 30
GPU_CACHE_SECONDS = 30
_gpu: tuple[float, list[dict]] = (0.0, [])


def limits() -> dict:
    def num(name: str, default: float) -> float:
        try:
            return max(0.0, float(os.environ.get(name, default)))
        except ValueError:
            return default
    return {"diskGB": num("AAD_MIN_DISK_GB", 5), "ramGB": num("AAD_MIN_RAM_GB", 2), "gpuGB": num("AAD_MIN_GPU_GB", 0)}


def drive_of(path: str | Path) -> str:
    p = Path(path).resolve()
    return p.anchor or str(p)


def gpus(clock=time.time) -> list[dict]:
    """Free and total memory of each NVIDIA card, read at most every 30 s (nvidia-smi takes ~0.3 s)."""
    global _gpu
    if clock() - _gpu[0] < GPU_CACHE_SECONDS:
        return _gpu[1]
    out: list[dict] = []
    exe = shutil.which("nvidia-smi")
    if exe:
        try:
            r = subprocess.run([exe, "--query-gpu=name,memory.free,memory.total", "--format=csv,noheader,nounits"],
                               capture_output=True, text=True, timeout=10)
            for line in r.stdout.splitlines():
                name, free, total = [x.strip() for x in line.split(",")]
                out.append({"name": name, "freeGB": round(float(free) / 1024, 2), "totalGB": round(float(total) / 1024, 2)})
        except (OSError, ValueError, subprocess.SubprocessError):
            out = []
    _gpu = (clock(), out)
    return out


def measure(paths: list[str | Path]) -> dict:
    """The readings for a run writing to these paths (each drive once)."""
    import psutil

    disks, seen = [], set()
    for p in paths:
        if not p:
            continue
        d = drive_of(p)
        if d in seen:
            continue
        seen.add(d)
        try:
            u = shutil.disk_usage(d)
        except OSError:
            continue
        disks.append({"drive": d, "freeGB": round(u.free / GB, 2), "totalGB": round(u.total / GB, 1)})
    m = psutil.virtual_memory()
    return {"disks": disks, "ramGB": round(m.available / GB, 2), "ramTotalGB": round(m.total / GB, 1), "gpus": gpus(),
            "limits": limits(), "at": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime())}


def n(x: float) -> str:
    """A number as written: 33.22, 5, 1000000 (never 1e+06)."""
    return f"{x:.2f}".rstrip("0").rstrip(".")


def low(m: dict) -> list[str]:
    """Each reading under its limit, with its number: "disk K:\\ 3.1 GB free, limit 5 GB"."""
    lim, out = m.get("limits") or limits(), []
    if lim["diskGB"]:
        out += [f"disk {d['drive']} {n(d['freeGB'])} GB free, limit {n(lim['diskGB'])} GB" for d in m["disks"] if d["freeGB"] < lim["diskGB"]]
    if lim["ramGB"] and m["ramGB"] < lim["ramGB"]:
        out.append(f"RAM {n(m['ramGB'])} GB free, limit {n(lim['ramGB'])} GB")
    if lim["gpuGB"]:
        out += [f"GPU {g['name']} {n(g['freeGB'])} GB free, limit {n(lim['gpuGB'])} GB" for g in m["gpus"] if g["freeGB"] < lim["gpuGB"]]
    return out


def run_paths(folder: str, data: Path | None) -> list[str]:
    """Where a run writes: its folder, the bridge's data folder (its .out), the user folder (Claude Code's logs)."""
    return [folder, str(data) if data else "", str(Path.home())]
