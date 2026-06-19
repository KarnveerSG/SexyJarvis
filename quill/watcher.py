"""Lightweight mtime-based file watcher for live-reloading Quill config.

Watches the small set of files Quill loads at startup (QUILL.md /
CLAUDE.md, .quillignore, hooks.json, config.toml profile, custom command
dir) and fires a callback on any change. Polls — no extra dependency.
"""

from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Callable


_WATCH_FILES = [
    "QUILL.md",
    ".quill.md",
    "CLAUDE.md",
    ".claude/CLAUDE.md",
    ".quillignore",
    ".quill/hooks.json",
    ".quill/config.toml",
    ".quill/tools.json",
    ".quill/mcp.json",
    ".quill/mcp.reload",
]
_WATCH_DIRS = [
    ".quill/commands",
]


def _snapshot(workspace: Path) -> dict[str, float]:
    out: dict[str, float] = {}
    for rel in _WATCH_FILES:
        p = workspace / rel
        try:
            if p.is_file():
                out[rel] = p.stat().st_mtime
        except OSError:
            pass
    for rel in _WATCH_DIRS:
        p = workspace / rel
        try:
            if p.is_dir():
                for child in p.iterdir():
                    if child.is_file():
                        out[f"{rel}/{child.name}"] = child.stat().st_mtime
        except OSError:
            pass
    return out


class FileWatcher:
    """Polls every `interval` seconds and calls `on_change(set_of_changed_paths)`."""

    def __init__(
        self,
        workspace: Path,
        on_change: Callable[[set[str]], None],
        interval: float = 1.5,
    ):
        self.workspace = workspace
        self.on_change = on_change
        self.interval = interval
        self._snapshot = _snapshot(workspace)
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def poll_once(self) -> set[str]:
        """Synchronous check — returns the set of changed paths (and updates state)."""
        new = _snapshot(self.workspace)
        changed: set[str] = set()
        for rel, mtime in new.items():
            if self._snapshot.get(rel) != mtime:
                changed.add(rel)
        for rel in self._snapshot:
            if rel not in new:
                changed.add(rel)
        self._snapshot = new
        return changed

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                changed = self.poll_once()
                if changed:
                    self.on_change(changed)
            except Exception:
                pass
            self._stop.wait(self.interval)
