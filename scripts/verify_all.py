#!/usr/bin/env python3
"""Verify Quill CLI, desktop packaging, and path resolution."""

from __future__ import annotations

import importlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
DESKTOP = ROOT / "desktop"
FAILURES: list[str] = []


def ok(name: str, detail: str = "") -> None:
    msg = f"PASS  {name}"
    if detail:
        msg += f" — {detail}"
    print(msg)


def fail(name: str, detail: str) -> None:
    FAILURES.append(f"{name}: {detail}")
    print(f"FAIL  {name} — {detail}")


def run(cmd: list[str], *, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=str(cwd or ROOT),
        capture_output=True,
        text=True,
        check=False,
    )


def test_python_imports() -> None:
    modules = sorted(
        p for p in list(DESKTOP.parent.glob("quill/**/*.py"))
        if p.name != "__init__.py"
    )
    bad = []
    for path in modules:
        rel = path.relative_to(ROOT).with_suffix("").as_posix().replace("/", ".")
        try:
            importlib.import_module(rel)
        except Exception as exc:
            bad.append(f"{rel}: {exc}")
    if bad:
        fail("python imports", "; ".join(bad))
    else:
        ok("python imports", f"{len(modules)} modules")


def test_cli_version() -> None:
    r = run([sys.executable, "-m", "quill", "--version"])
    if r.returncode == 0 and "Quill" in r.stdout:
        ok("cli --version", r.stdout.strip())
    else:
        fail("cli --version", r.stderr or r.stdout or f"exit {r.returncode}")


def test_cli_parser() -> None:
    code = """
from quill.cli import build_parser
p = build_parser()
for args in [
    ["--desktop"],
    ["-w", "C:/tmp", "--provider", "auto", "--no-speech", "--yolo"],
]:
    p.parse_args(args)
print("ok")
"""
    r = run([sys.executable, "-c", code])
    if r.returncode == 0:
        ok("cli parser flags")
    else:
        fail("cli parser flags", r.stderr.strip())


def test_integration_parity() -> None:
    from quill.integrations import INTEGRATIONS as PY_INTEGRATIONS

    js_src = (DESKTOP / "integrations.js").read_text(encoding="utf-8")
    block = js_src.split("const SETTINGS_SECTIONS")[0]
    js_ids = set(re.findall(r'id:\s*"([^"]+)"', block))
    js_env = set(re.findall(r'env:\s*"([A-Z0-9_]+)"', block))
    py_ids = {i.id for i in PY_INTEGRATIONS}
    py_env = {k.env for i in PY_INTEGRATIONS for k in i.keys}
    mismatches = []
    if py_ids != js_ids:
        mismatches.append(f"ids py-only={py_ids - js_ids} js-only={js_ids - py_ids}")
    if py_env != js_env:
        mismatches.append(f"env py-only={py_env - js_env} js-only={js_env - py_env}")
    if mismatches:
        fail("integration parity", "; ".join(mismatches))
    else:
        ok("integration parity", f"{len(py_ids)} integrations, {len(py_env)} env keys")


def test_dist_artifacts() -> None:
    desktop_candidates = [
        ROOT / "dist" / "desktop" / "win-unpacked" / "Quill.exe",
        ROOT / "dist" / "desktop-build" / "win-unpacked" / "Quill.exe",
    ]
    desktop_exe = next((p for p in desktop_candidates if p.is_file()), None)
    paths = {
        "cli exe": ROOT / "dist" / "Quill.exe",
        "desktop unpacked": desktop_exe,
        "desktop portable": ROOT / "dist" / "desktop" / "Quill-0.2.0-portable.exe",
    }
    local = Path(os.environ.get("LOCALAPPDATA", ""))
    paths["installed cli"] = local / "Programs" / "Quill" / "Quill.exe"
    paths["installed desktop"] = local / "Programs" / "Quill Desktop" / "Quill.exe"
    missing = [k for k, p in paths.items() if p is None or not p.is_file()]
    if missing:
        fail("dist artifacts", f"missing: {', '.join(missing)}")
    else:
        ok("dist artifacts", f"{len(paths)} paths present")


def test_cli_binary_version() -> None:
    exe = ROOT / "dist" / "Quill.exe"
    if not exe.is_file():
        fail("dist Quill.exe --version", "binary missing")
        return
    r = run([str(exe), "--version"])
    if r.returncode == 0 and "Quill" in (r.stdout + r.stderr):
        ok("dist Quill.exe --version", (r.stdout or r.stderr).strip())
    else:
        fail("dist Quill.exe --version", r.stderr or r.stdout)


def test_desktop_package_files() -> None:
    pkg = json.loads((DESKTOP / "package.json").read_text(encoding="utf-8"))
    files: list[str] = pkg.get("build", {}).get("files", [])
    main_src = (DESKTOP / "main.js").read_text(encoding="utf-8")
    requires = re.findall(r'require\("\./([^"]+)"\)', main_src)
    missing_from_files = []
    for req in requires:
        fname = req if req.endswith(".js") else f"{req}.js"
        if fname not in files and not any(
            f.replace("**/*", "").startswith(fname.replace(".js", "")) for f in files
        ):
            missing_from_files.append(fname)
    if missing_from_files:
        fail("desktop build.files", f"main.js requires missing from files: {missing_from_files}")
    else:
        ok("desktop build.files", f"covers {requires}")

    for pattern in files:
        if "**" in pattern:
            base = pattern.split("**")[0].rstrip("/")
            if base and not (DESKTOP / base).exists():
                if pattern == "assets/**/*":
                    continue  # optional until assets exist
                fail("desktop source files", f"pattern {pattern} matches nothing")
                return
        elif not (DESKTOP / pattern).is_file():
            fail("desktop source files", f"missing {pattern}")
            return
    ok("desktop source files", f"{len(files)} patterns")


def test_asar_contents() -> None:
    asar_paths = [
        ROOT / "dist" / "desktop" / "win-unpacked" / "resources" / "app.asar",
        Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Quill Desktop" / "resources" / "app.asar",
    ]
    required = {"\\main.js", "\\preload.js", "\\integrations.js", "\\themes.js", "\\renderer\\index.html"}
    for asar in asar_paths:
        label = asar.parent.parent.name
        if not asar.is_file():
            fail(f"asar {label}", "app.asar missing")
            continue
        r = subprocess.run(
            f'npx --yes asar list "{asar}"',
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            shell=True,
        )
        if r.returncode != 0:
            fail(f"asar {label}", r.stderr.strip())
            continue
        entries = set(r.stdout.splitlines())
        missing = sorted(required - entries)
        if missing:
            fail(f"asar {label}", f"missing {missing}")
        else:
            ok(f"asar {label}", "required modules present")


def test_ipc_wiring() -> None:
    main = (DESKTOP / "main.js").read_text(encoding="utf-8")
    preload = (DESKTOP / "preload.js").read_text(encoding="utf-8")
    app_js = (DESKTOP / "renderer" / "app.js").read_text(encoding="utf-8")
    handles = set(re.findall(r'ipcMain\.handle\("([^"]+)"', main))
    invokes = set(re.findall(r'invoke\("([^"]+)"', preload))
    used = set(re.findall(r"window\.quill\.(\w+)", app_js))
    preload_methods = set(re.findall(r"^\s+(\w+):", preload, re.M))
    missing_handles = sorted(invokes - handles)
    orphan_handles = sorted(handles - invokes)
    unused_preload = sorted(preload_methods - used - {"onPtyData", "onPtyExit", "getEnv", "openExternal"})
    if missing_handles:
        fail("ipc wiring", f"preload invoke without handle: {missing_handles}")
    elif used - preload_methods:
        fail("ipc wiring", f"app.js uses unknown quill API: {sorted(used - preload_methods)}")
    else:
        ok("ipc wiring", f"{len(handles)} handles; unused preload: {unused_preload or 'none'}")


def test_themes() -> None:
    r = run(
        ["node", "-e", "const {THEMES}=require('./themes'); console.log(Object.keys(THEMES).join(','))"],
        cwd=DESKTOP,
    )
    if r.returncode != 0:
        fail("themes", r.stderr.strip())
        return
    found = set(r.stdout.strip().split(","))
    expected = {"dark", "imode", "midnight", "ocean", "sunset", "forest"}
    css = (DESKTOP / "renderer" / "styles.css").read_text(encoding="utf-8")
    css_themes = set(re.findall(r"body\.(theme-\w+)", css))
    themes_src = (DESKTOP / "themes.js").read_text(encoding="utf-8")
    js_classes = set(re.findall(r'cssClass:\s*"(theme-\w+)"', themes_src))
    if found != expected:
        fail("themes.js keys", f"expected {expected}, got {found}")
    else:
        extra_css = js_classes - css_themes - {"theme-dark"}  # dark uses :root defaults
        if extra_css:
            fail("theme css", f"themes.js classes missing in styles.css: {extra_css}")
        else:
            ok("themes", f"{len(expected)} themes, css aligned")


def test_theme_apply_reset() -> None:
    app = (DESKTOP / "renderer" / "app.js").read_text(encoding="utf-8")
    if "THEME_CSS_VARS" not in app or "removeProperty" not in app:
        fail("theme apply reset", "applyTheme must clear inline CSS vars when returning to Dark")
    else:
        ok("theme apply reset", "THEME_CSS_VARS cleared on switch")


def test_scrollbar_css() -> None:
    css = (DESKTOP / "renderer" / "styles.css").read_text(encoding="utf-8")
    if "::-webkit-scrollbar-thumb" not in css or "--scrollbar-thumb" not in css:
        fail("scrollbar css", "missing global scrollbar styling")
    else:
        ok("scrollbar css", "thin scrollbars + tokens")


def test_agent_chat_filtering() -> None:
    app = (DESKTOP / "renderer" / "app.js").read_text(encoding="utf-8")
    ui = (ROOT / "quill" / "ui.py").read_text(encoding="utf-8")
    if "isTerminalNoise" not in app or "QUILL_REPLY" not in ui:
        fail("agent chat filter", "missing noise filter or QUILL_REPLY emitter")
    else:
        ok("agent chat filter", "PTY off by default + structured replies")


def test_desktop_launcher_candidates() -> None:
    code = """
from quill.desktop_launcher import _desktop_candidates
for p in _desktop_candidates():
    print(p, p.is_file())
"""
    r = run([sys.executable, "-c", code])
    lines = [ln for ln in r.stdout.splitlines() if ln.strip()]
    found = sum(1 for ln in lines if ln.endswith(" True"))
    if found == 0:
        fail("desktop launcher", "no desktop exe candidate found")
    else:
        ok("desktop launcher", f"{found}/{len(lines)} candidates exist")


def test_config_paths() -> None:
    code = """
from pathlib import Path
from quill.config import _global_config_dir, load_config
d = _global_config_dir()
assert d == Path.home() / ".quill"
load_config(workspace=Path.cwd())
print(d)
"""
    r = run([sys.executable, "-c", code])
    if r.returncode == 0:
        ok("config paths", r.stdout.strip())
    else:
        fail("config paths", r.stderr.strip())


def test_node_modules() -> None:
    r = run(["node", "-e", 'require("./integrations"); require("./themes"); console.log("ok")'], cwd=DESKTOP)
    if r.returncode == 0:
        ok("desktop node requires")
    else:
        fail("desktop node requires", r.stderr.strip())


def main() -> int:
    print(f"Quill verify — {ROOT}\n")
    tests = [
        test_python_imports,
        test_cli_version,
        test_cli_parser,
        test_integration_parity,
        test_config_paths,
        test_desktop_launcher_candidates,
        test_dist_artifacts,
        test_cli_binary_version,
        test_desktop_package_files,
        test_node_modules,
        test_themes,
        test_theme_apply_reset,
        test_scrollbar_css,
        test_agent_chat_filtering,
        test_ipc_wiring,
        test_asar_contents,
    ]
    for fn in tests:
        try:
            fn()
        except Exception as exc:
            fail(fn.__name__, str(exc))
    print()
    if FAILURES:
        print(f"{len(FAILURES)} failure(s):")
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    print("All checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
