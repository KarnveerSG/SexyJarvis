"""System prompt assembly."""

from __future__ import annotations

import platform
from pathlib import Path

from .caveman import CAVEMAN_ULTRA, NORMAL_STYLE, NORMAL_THINKING_PROMPT, THINKING_PROMPT
from .codegraph_tools import CODEGRAPH_GUIDANCE

BASE_SYSTEM = """You are SexyJarvis, an autonomous terminal coding agent.

Agentic loop: brief thought → tool → observe → repeat until done.

Guidelines:
- Inspect before edit. Minimal focused changes.
- Non-interactive shell only. Use file tools not bash echo for writes.
- Call `finish` only when work verified.
- Never fabricate tool output.
"""


def build_system_prompt(
    workspace: Path,
    memory_section: str = "",
    *,
    codegraph_enabled: bool = True,
    rtk_enabled: bool = True,
    caveman_enabled: bool = True,
) -> str:
    env = (
        f"\nEnvironment:\n"
        f"- Working directory: {workspace}\n"
        f"- OS: {platform.system()} {platform.release()}\n"
        f"- Python: {platform.python_version()}\n"
    )
    if caveman_enabled:
        style_parts = [CAVEMAN_ULTRA, THINKING_PROMPT]
    else:
        style_parts = [NORMAL_STYLE, NORMAL_THINKING_PROMPT]
    parts = [BASE_SYSTEM, *style_parts, env]
    if codegraph_enabled:
        parts.append(CODEGRAPH_GUIDANCE)
    if rtk_enabled:
        parts.append(
            "\n## RTK\n"
            "`execute_bash` auto-wraps with `rtk` when installed — compact git/test/build output. "
            "Prefer bash+rtk over huge raw logs."
        )
    if memory_section:
        parts.append("\n" + memory_section)
    return "\n".join(parts)
