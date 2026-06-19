"""Launch the Quill desktop IDE (Electron)."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def _desktop_candidates() -> list[Path]:
    local = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    desktop = Path.home() / "Desktop"
    root = Path(__file__).resolve().parent.parent
    return [
        local / "Programs" / "Quill" / "Quill.exe",
        desktop / "Quill.exe",
        root / "dist" / "desktop" / "Quill-0.2.0-portable.exe",
        root / "dist" / "desktop" / "win-unpacked" / "Quill.exe",
    ]


def launch_desktop() -> int:
    for exe in _desktop_candidates():
        if exe.is_file():
            subprocess.Popen([str(exe)], cwd=str(exe.parent))
            return 0
    desktop_dir = Path(__file__).resolve().parent.parent / "desktop"
    if (desktop_dir / "package.json").is_file():
        try:
            subprocess.Popen(["npm", "start"], cwd=str(desktop_dir), shell=True)
            return 0
        except OSError:
            pass
    print(
        "Quill desktop not found. Build with: python scripts/install_quill.py",
        file=sys.stderr,
    )
    return 1
