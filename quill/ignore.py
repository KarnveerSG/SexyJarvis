"""Glob-pattern ignore matching for grep/glob/code_search.

Loads `.quillignore` (preferred) or falls back to `.gitignore`. Patterns
follow gitignore semantics for the subset we need: literal paths, `*` globs,
and directory suffixes. Anything fancier (negation, `**`) is treated as a
simple fnmatch.
"""

from __future__ import annotations

import fnmatch
from pathlib import Path


def _load_patterns(workspace: Path) -> list[str]:
    for name in (".quillignore", ".gitignore"):
        path = workspace / name
        if not path.is_file():
            continue
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except Exception:
            continue
        return [ln.strip() for ln in lines if ln.strip() and not ln.strip().startswith("#")]
    return []


class IgnoreMatcher:
    def __init__(self, workspace: Path):
        self.workspace = workspace
        self.patterns = _load_patterns(workspace)

    def matches(self, path: Path) -> bool:
        if not self.patterns:
            return False
        try:
            rel = path.relative_to(self.workspace).as_posix()
        except ValueError:
            rel = path.as_posix()
        name = path.name
        for pat in self.patterns:
            p = pat.rstrip("/")
            # Directory pattern matches any path inside it.
            if pat.endswith("/") and (rel == p or rel.startswith(p + "/")):
                return True
            if fnmatch.fnmatch(name, p) or fnmatch.fnmatch(rel, p):
                return True
            # Match nested occurrences (e.g. `node_modules` matches `a/node_modules/x`).
            if "/" not in p and ("/" + p + "/") in ("/" + rel + "/"):
                return True
        return False
