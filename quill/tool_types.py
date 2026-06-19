"""Shared tool types."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class ToolResult:
    content: str
    is_error: bool = False
    diff: str | None = None
    lang: str | None = None  # optional syntax-highlight hint for UI rendering
