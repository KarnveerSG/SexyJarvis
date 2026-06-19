"""User-defined external shell-backed tools.

Drop a JSON file at .quill/tools.json (or ~/.quill/tools.json) with:

    [
      {
        "name": "ruff_check",
        "description": "Run ruff linter on a path.",
        "command": "ruff check {path}",
        "args": {"path": {"type": "string", "description": "Path to lint."}}
      }
    ]

`command` is a shell template; placeholders `{name}` are filled from args.
Args use a tiny subset of JSON Schema (type + description). All are required
unless `optional: true`.
"""

from __future__ import annotations

import json
import shlex
import subprocess
from pathlib import Path

from .tool_types import ToolResult


def _config_paths(workspace: Path) -> list[Path]:
    return [
        workspace / ".quill" / "tools.json",
        Path.home() / ".quill" / "tools.json",
    ]


def load_external_tool_defs(workspace: Path) -> list[dict]:
    """Load and validate external tool definitions."""
    out: list[dict] = []
    seen: set[str] = set()
    for path in _config_paths(workspace):
        if not path.is_file():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(data, list):
            continue
        for entry in data:
            if not isinstance(entry, dict):
                continue
            name = entry.get("name")
            cmd = entry.get("command")
            if not name or not cmd or name in seen:
                continue
            seen.add(name)
            out.append(entry)
    return out


def external_tool_schemas(workspace: Path) -> list[dict]:
    """Convert external defs to Anthropic tool schema format."""
    schemas: list[dict] = []
    for ext in load_external_tool_defs(workspace):
        props: dict[str, dict] = {}
        required: list[str] = []
        for arg_name, spec in (ext.get("args") or {}).items():
            if not isinstance(spec, dict):
                continue
            props[arg_name] = {
                "type": spec.get("type", "string"),
                "description": spec.get("description", ""),
            }
            if not spec.get("optional"):
                required.append(arg_name)
        schemas.append(
            {
                "name": f"ext_{ext['name']}",
                "description": ext.get("description", "User-defined external tool."),
                "input_schema": {
                    "type": "object",
                    "properties": props,
                    "required": required,
                },
            }
        )
    return schemas


def run_external_tool(name: str, args: dict, workspace: Path, timeout: int = 120) -> ToolResult:
    """Execute an external tool by name (without the `ext_` prefix accepted)."""
    raw_name = name[4:] if name.startswith("ext_") else name
    defs = {d["name"]: d for d in load_external_tool_defs(workspace)}
    spec = defs.get(raw_name)
    if not spec:
        return ToolResult(f"Unknown external tool: {raw_name}", is_error=True)
    template = spec.get("command", "")
    try:
        # Use shlex.quote on string arguments to avoid command injection
        # from agent-supplied values.
        safe_args = {
            k: shlex.quote(str(v)) if isinstance(v, str) else str(v)
            for k, v in (args or {}).items()
        }
        cmd = template.format(**safe_args)
    except KeyError as missing:
        return ToolResult(f"Missing required arg: {missing}", is_error=True)
    try:
        proc = subprocess.run(
            cmd,
            shell=True,
            cwd=str(workspace),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return ToolResult(f"External tool '{raw_name}' timed out after {timeout}s.", is_error=True)
    body = (proc.stdout or "") + (("\n[stderr]\n" + proc.stderr) if proc.stderr else "")
    body = body.strip() or "(no output)"
    if len(body) > 20000:
        body = body[:20000] + "\n[...truncated...]"
    return ToolResult(f"exit_code={proc.returncode}\n{body}", is_error=proc.returncode != 0)
