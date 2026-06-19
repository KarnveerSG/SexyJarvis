#!/usr/bin/env python3
"""Build and install Quill CLI + desktop on Windows."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def run(cmd: list[str], *, cwd: Path | None = None, shell: bool = False) -> None:
    print("+", " ".join(cmd))
    subprocess.run(cmd, cwd=str(cwd or ROOT), check=True, shell=shell)


def migrate_env() -> None:
    legacy = Path.home() / ".sexyjarvis" / ".env"
    target_dir = Path.home() / ".quill"
    target = target_dir / ".env"
    if legacy.is_file() and not target.is_file():
        target_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(legacy, target)
        print(f"Migrated config: {legacy} -> {target}")


def desktop_shortcut(exe: Path) -> None:
    desktop = Path.home() / "Desktop" / "Quill.lnk"
    ps = (
        f"$s = (New-Object -COM WScript.Shell).CreateShortcut('{desktop}'); "
        f"$s.TargetPath = '{exe}'; "
        f"$s.WorkingDirectory = '{exe.parent}'; "
        f"$s.IconLocation = '{exe},0'; "
        f"$s.Description = 'Quill — CODE BEAUTIFUL'; "
        f"$s.Save()"
    )
    subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=True)
    print(f"Desktop shortcut: {desktop}")


def main() -> int:
    if sys.platform != "win32":
        print("install_quill.py is Windows-focused.", file=sys.stderr)
        return 1

    migrate_env()

    run([sys.executable, "-m", "pip", "install", "-e", ".[cursor,build,voice]"])

    run([sys.executable, "scripts/build_binary.py", "--install", "--with", "cursor"])

    desktop_dir = ROOT / "desktop"
    run(["npm", "install"], cwd=desktop_dir, shell=True)
    run(["npm", "run", "build:dir"], cwd=desktop_dir, shell=True)

    unpacked = ROOT / "dist" / "desktop" / "win-unpacked" / "Quill.exe"
    if not unpacked.is_file():
        print(f"Desktop build missing: {unpacked}", file=sys.stderr)
        return 1

    install_dir = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Quill"
    install_dir.mkdir(parents=True, exist_ok=True)
    dest = install_dir / "Quill.exe"
    shutil.copy2(unpacked, dest)

    # Also copy quill CLI if built
    cli_built = ROOT / "dist" / "quill.exe"
    if cli_built.is_file():
        shutil.copy2(cli_built, install_dir / "quill.exe")

    desktop_shortcut(dest)

    print("\nDone.")
    print(f"  Desktop IDE: {dest}")
    print(f"  CLI:         {install_dir / 'quill.exe'}")
    print("  Restart terminal, then run: quill")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
