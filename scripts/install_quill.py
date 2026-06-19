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


def cli_install_dir() -> Path:
    return Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Quill"


def desktop_install_dir() -> Path:
    return Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Quill Desktop"


def add_to_user_path(install_dir: Path) -> None:
    target = str(install_dir)
    ps = (
        f"$dir = '{target}'; "
        "$p = [Environment]::GetEnvironmentVariable('Path', 'User'); "
        "if ($p -notlike \"*$dir*\") { "
        "[Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';') + ';' + $dir), 'User') }"
    )
    subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=True)


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


def install_desktop_tree(src_dir: Path, dest_dir: Path) -> Path:
    """Copy full Electron output (Quill.exe + ffmpeg.dll + resources)."""
    if dest_dir.exists():
        shutil.rmtree(dest_dir)
    shutil.copytree(src_dir, dest_dir)
    exe = dest_dir / "Quill.exe"
    if not exe.is_file():
        raise FileNotFoundError(f"Desktop exe missing after copy: {exe}")
    return exe


def write_cli_shim(cli_dir: Path, exe_name: str = "Quill.exe") -> None:
    shim = cli_dir / "Quill.cmd"
    shim.write_text(
        f'@echo off\r\n"%~dp0{exe_name}" %*\r\n',
        encoding="utf-8",
    )


def main() -> int:
    if sys.platform != "win32":
        print("install_quill.py is Windows-focused.", file=sys.stderr)
        return 1

    migrate_env()

    run([sys.executable, "-m", "pip", "install", "-e", ".[cursor,build,voice]"])

    # Build CLI as Quill.exe (capital Q — user-facing command name)
    run([sys.executable, "scripts/build_binary.py", "--out", "dist/Quill.exe", "--with", "cursor"])

    desktop_dir = ROOT / "desktop"
    run(["npm", "install"], cwd=desktop_dir, shell=True)
    run(["npm", "run", "build:dir"], cwd=desktop_dir, shell=True)

    cli_src = ROOT / "dist" / "Quill.exe"
    desktop_src_dir = ROOT / "dist" / "desktop" / "win-unpacked"
    if not cli_src.is_file():
        print(f"CLI build missing: {cli_src}", file=sys.stderr)
        return 1
    if not desktop_src_dir.is_dir():
        print(f"Desktop build missing: {desktop_src_dir}", file=sys.stderr)
        return 1

    cli_dir = cli_install_dir()
    desk_dir = desktop_install_dir()
    cli_dir.mkdir(parents=True, exist_ok=True)
    cli_dest = cli_dir / "Quill.exe"
    if cli_dest.exists():
        cli_dest.unlink()
    shutil.copy2(cli_src, cli_dest)
    write_cli_shim(cli_dir)
    add_to_user_path(cli_dir)

    desk_exe = install_desktop_tree(desktop_src_dir, desk_dir)
    desktop_shortcut(desk_exe)

    print("\nDone.")
    print(f"  Desktop IDE: {desk_exe}")
    print(f"  CLI:         {cli_dest}")
    print("  Restart terminal, then run: Quill")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
