"""Expand @file mentions in user input.

When the user writes `@path/to/file.py` (or `@./foo`, `@src/bar.ts`), inline the
file contents into the message so the model sees them up front, mirroring the
Cursor / Claude Code @-mention UX.
"""

from __future__ import annotations

import re
from pathlib import Path

# @-token: starts with @, ends at whitespace or end-of-string. Strips trailing punctuation
# that isn't part of typical paths.
_MENTION = re.compile(r"(?:^|(?<=\s))@([^\s@]+)")

_MAX_FILE_BYTES = 30_000
_MAX_TOTAL_BYTES = 80_000


def expand_mentions(text: str, workspace: Path) -> tuple[str, list[Path]]:
    """Return (augmented_text, list_of_attached_paths).

    The returned text contains the original input followed by an `<attached>`
    block per resolved mention. Non-existent mentions are left as-is in the
    original text.
    """
    matches = list(_MENTION.finditer(text))
    if not matches:
        return text, []

    attached: list[tuple[Path, str]] = []
    seen: set[Path] = set()
    total = 0
    for m in matches:
        raw = m.group(1).rstrip(".,;:)]}>'\"")
        if not raw:
            continue
        candidate = Path(raw)
        full = candidate if candidate.is_absolute() else (workspace / candidate)
        try:
            full = full.resolve()
        except Exception:
            continue
        if full in seen or not full.is_file():
            continue
        try:
            content = full.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        if len(content) > _MAX_FILE_BYTES:
            content = content[:_MAX_FILE_BYTES] + "\n[...truncated...]"
        if total + len(content) > _MAX_TOTAL_BYTES:
            break
        total += len(content)
        seen.add(full)
        attached.append((full, content))

    if not attached:
        return text, []

    parts = [text.rstrip(), "\n\n[Auto-attached via @-mention:]"]
    for path, content in attached:
        try:
            rel = path.relative_to(workspace).as_posix()
        except ValueError:
            rel = str(path)
        parts.append(f"\n<file path=\"{rel}\">\n{content}\n</file>")
    return "\n".join(parts), [p for p, _ in attached]
