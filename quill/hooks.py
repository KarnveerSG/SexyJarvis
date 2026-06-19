"""Pre/post tool hooks.

Config at `.quill/hooks.json`:

    {
      "pre": {"execute_bash": "echo running: $TOOL_ARGS"},
      "post": {"write_file": "git diff --stat"}
    }

Hooks are shell commands. They run in the workspace, with these env vars set:
- TOOL_NAME   — the tool being executed
- TOOL_ARGS   — the JSON-encoded args (best-effort)

Pre-hook failure (non-zero exit) blocks the tool call. Post-hook output is
returned alongside the tool result for the agent to see.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path


def _hooks_path(workspace: Path) -> Path:
    return workspace / ".quill" / "hooks.json"


def load_hooks(workspace: Path) -> dict:
    path = _hooks_path(workspace)
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def run_hook(phase: str, tool_name: str, args: dict, workspace: Path, timeout: int = 30) -> tuple[int, str] | None:
    """Run a pre/post hook if defined. Returns (exit_code, output) or None."""
    cfg = load_hooks(workspace)
    cmd = (cfg.get(phase) or {}).get(tool_name)
    if not cmd:
        return None
    env = os.environ.copy()
    env["TOOL_NAME"] = tool_name
    try:
        env["TOOL_ARGS"] = json.dumps(args, default=str)
    except Exception:
        env["TOOL_ARGS"] = "{}"
    try:
        proc = subprocess.run(
            cmd, shell=True, cwd=str(workspace),
            capture_output=True, text=True, timeout=timeout, env=env,
        )
    except subprocess.TimeoutExpired:
        return 124, f"Hook timed out after {timeout}s."
    out = (proc.stdout or "") + (proc.stderr or "")
    return proc.returncode, out.strip()
