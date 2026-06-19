"""RTK integration — compact shell output (https://github.com/rtk-ai/rtk)."""

from __future__ import annotations

import shutil

# Commands RTK should not wrap (passthrough / interactive / already wrapped).
_RTK_SKIP_PREFIXES = (
    "rtk ",
    "codegraph ",
    "quill ",
    "python -m quill",
)


def rtk_available() -> bool:
    return shutil.which("rtk") is not None


def wrap_with_rtk(command: str, *, enabled: bool = True) -> str:
    """Prefix a shell command with `rtk` when available (mirrors Cursor/Claude hooks)."""
    cmd = (command or "").strip()
    if not enabled or not cmd:
        return cmd
    if any(cmd.lower().startswith(p) for p in _RTK_SKIP_PREFIXES):
        return cmd
    if not rtk_available():
        return cmd
    return f"rtk {cmd}"
