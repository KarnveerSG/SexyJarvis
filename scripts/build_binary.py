"""Build a standalone Quill binary.

Windows: PyInstaller -> dist/quill.exe
Unix:    shiv         -> dist/Quill.pyz

Usage:
    python scripts/build_binary.py [--out PATH] [--install]

Requires:
    pip install -e ".[build]"          # shiv on all platforms
    pip install pyinstaller            # Windows exe (or included in [build])
"""

from __future__ import annotations

import argparse
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path


def _project_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _install_dir() -> Path:
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "Programs" / "Quill"
    return Path.home() / ".local" / "bin"


def _add_to_user_path(install_dir: Path) -> None:
    target = str(install_dir)
    if sys.platform == "win32":
        ps = (
            f"$dir = '{target}'; "
            "$p = [Environment]::GetEnvironmentVariable('Path', 'User'); "
            "if ($p -notlike \"*$dir*\") { "
            "[Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';') + ';' + $dir), 'User') }"
        )
        subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=True)
        return
    shell_rc = Path.home() / ".profile"
    line = f'export PATH="{target}:$PATH"'
    text = shell_rc.read_text(encoding="utf-8") if shell_rc.exists() else ""
    if target not in text:
        shell_rc.write_text(text.rstrip() + ("\n" if text and not text.endswith("\n") else "") + line + "\n", encoding="utf-8")


def install_binary(binary: Path) -> Path:
    install_dir = _install_dir()
    install_dir.mkdir(parents=True, exist_ok=True)
    dest = install_dir / binary.name
    shutil.copy2(binary, dest)
    if sys.platform != "win32":
        dest.chmod(dest.stat().st_mode | 0o111)
    _add_to_user_path(install_dir)
    return dest


_EXTRA_PYINSTALLER: dict[str, list[str]] = {
    "cursor": ["--collect-all", "cursor_sdk", "--copy-metadata", "cursor-sdk"],
}


def build_windows(out_path: Path, extras: list[str]) -> int:
    try:
        import PyInstaller  # noqa: F401
    except ImportError:
        print("pyinstaller is not installed. Run: pip install pyinstaller", file=sys.stderr)
        return 2

    root = _project_root()
    entry = root / "scripts" / "pyinstaller_entry.py"
    work = root / "build" / "pyinstaller"
    spec_dir = root / "build"

    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onefile",
        "--console",
        "--name",
        out_path.stem,
        "--distpath",
        str(out_path.parent),
        "--workpath",
        str(work),
        "--specpath",
        str(spec_dir),
        "--paths",
        str(root),
        "--collect-submodules",
        "quill",
        "--collect-all",
        "rich",
        "--collect-all",
        "anthropic",
        str(entry),
    ]
    for extra in extras:
        cmd.extend(_EXTRA_PYINSTALLER.get(extra, [f"--copy-metadata", extra]))

    print("Running:", " ".join(cmd))
    result = subprocess.run(cmd, cwd=str(root))
    if result.returncode != 0:
        return result.returncode

    built = out_path.parent / f"{out_path.stem}.exe"
    if not built.exists():
        print(f"Expected binary not found: {built}", file=sys.stderr)
        return 1
    if built != out_path.resolve():
        shutil.move(str(built), str(out_path))
    print(f"\nBuilt: {out_path}")
    return 0


def build_unix(out_path: Path, extras: list[str], python_shebang: str) -> int:
    if shutil.which("shiv") is None:
        print('shiv is not installed. Run: pip install -e ".[build]"', file=sys.stderr)
        return 2

    root = _project_root()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    spec = "."
    if extras:
        spec = f".[{','.join(extras)}]"

    cmd = [
        "shiv",
        "-c",
        "quill",
        "-o",
        str(out_path),
        "-p",
        python_shebang,
        spec,
    ]
    print("Running:", " ".join(cmd))
    result = subprocess.run(cmd, cwd=str(root))
    if result.returncode != 0:
        return result.returncode
    print(f"\nBuilt: {out_path}")
    print("Run with:", out_path.name)
    return 0


def main() -> int:
    default_out = "dist/quill.exe" if sys.platform == "win32" else "dist/quill.pyz"
    parser = argparse.ArgumentParser(description="Build Quill as a standalone binary")
    parser.add_argument("--out", default=default_out)
    parser.add_argument("--python", default="/usr/bin/env python3", help="Shebang for shiv (Unix only)")
    parser.add_argument(
        "--with",
        dest="extras",
        action="append",
        default=[],
        help="Optional extras: cursor, voice, input (repeatable)",
    )
    parser.add_argument(
        "--install",
        action="store_true",
        help="Copy binary into a user bin dir and add it to PATH",
    )
    args = parser.parse_args()

    root = _project_root()
    out_path = (root / args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if sys.platform == "win32":
        code = build_windows(out_path, args.extras or ["cursor"])
    else:
        code = build_unix(out_path, args.extras, args.python)
    if code != 0:
        return code

    if args.install:
        dest = install_binary(out_path)
        print(f"Installed: {dest}")
        print("Restart your terminal, then run: quill")
    else:
        install_dir = _install_dir()
        print(f"To call from anywhere, run with --install or copy to: {install_dir}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
