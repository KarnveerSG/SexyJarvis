"""Generate a QUILL.md from a workspace scan (like Claude Code /init)."""

from __future__ import annotations

from pathlib import Path

_SKIP = {".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", ".idea", ".vscode"}

_STACK_HINTS = [
    ("package.json", "Node.js / JavaScript project"),
    ("pyproject.toml", "Python project (pyproject)"),
    ("requirements.txt", "Python project (requirements)"),
    ("setup.py", "Python project (setup.py)"),
    ("Cargo.toml", "Rust project"),
    ("go.mod", "Go project"),
    ("pom.xml", "Java / Maven project"),
    ("build.gradle", "Gradle project"),
    ("*.csproj", "C# / .NET project"),
    ("*.sln", "C# / .NET solution"),
    ("Gemfile", "Ruby project"),
    ("composer.json", "PHP project"),
]


def _list_top(workspace: Path, limit: int = 40) -> list[str]:
    items: list[str] = []
    for entry in sorted(workspace.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
        if entry.name in _SKIP or entry.name.startswith("."):
            continue
        items.append(entry.name + ("/" if entry.is_dir() else ""))
        if len(items) >= limit:
            break
    return items


def _detect_stack(workspace: Path) -> list[str]:
    found: list[str] = []
    for pattern, label in _STACK_HINTS:
        if "*" in pattern:
            if any(workspace.glob(pattern)):
                found.append(label)
        elif (workspace / pattern).exists():
            found.append(label)
    return found


def _detect_commands(workspace: Path) -> list[str]:
    cmds: list[str] = []
    pkg = workspace / "package.json"
    if pkg.is_file():
        try:
            import json
            data = json.loads(pkg.read_text(encoding="utf-8"))
            for name in ("dev", "start", "build", "test", "lint"):
                if name in (data.get("scripts") or {}):
                    cmds.append(f"npm run {name}")
        except Exception:
            pass
    if (workspace / "pyproject.toml").is_file():
        cmds.append("python -m pytest")
    if (workspace / "Cargo.toml").exists():
        cmds.extend(["cargo build", "cargo test"])
    if (workspace / "go.mod").exists():
        cmds.extend(["go build ./...", "go test ./..."])
    return cmds


def generate_quill_md(workspace: Path, overwrite: bool = False) -> tuple[Path, bool, str]:
    """Write QUILL.md. Returns (path, created_bool, status_message)."""
    target = workspace / "QUILL.md"
    if target.exists() and not overwrite:
        return target, False, f"{target.name} already exists. Pass overwrite=True to replace."

    stack = _detect_stack(workspace) or ["(stack not auto-detected — please fill in)"]
    top = _list_top(workspace)
    cmds = _detect_commands(workspace)

    lines = [
        f"# {workspace.name}",
        "",
        "_Standing instructions for Quill. Edit freely — this file is "
        "auto-included in the system prompt._",
        "",
        "## Stack",
        "",
    ]
    lines.extend(f"- {s}" for s in stack)
    lines.append("")
    lines.append("## Top-level layout")
    lines.append("")
    lines.append("```")
    lines.extend(top)
    lines.append("```")
    lines.append("")
    if cmds:
        lines.append("## Common commands")
        lines.append("")
        lines.append("```bash")
        lines.extend(cmds)
        lines.append("```")
        lines.append("")
    lines.extend([
        "## Conventions",
        "",
        "- (Add house style, formatting rules, things to avoid here.)",
        "",
        "## Project context",
        "",
        "- (What this codebase does, who uses it, current focus.)",
        "",
    ])

    target.write_text("\n".join(lines), encoding="utf-8")
    return target, True, f"Wrote {target}. Edit it to add your own conventions."
