"""Conversation session state and save/load."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Session:
    """Holds the running message history sent to the model."""

    messages: list[dict] = field(default_factory=list)
    system: str = ""
    # Cumulative token usage across all turns in this session.
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    turns: int = 0

    def add_usage(self, input_t: int = 0, output_t: int = 0, cache_r: int = 0, cache_w: int = 0):
        self.input_tokens += int(input_t or 0)
        self.output_tokens += int(output_t or 0)
        self.cache_read_tokens += int(cache_r or 0)
        self.cache_write_tokens += int(cache_w or 0)

    def add_user(self, text: str):
        self.messages.append({"role": "user", "content": text})

    def add_raw(self, role: str, content):
        self.messages.append({"role": role, "content": content})

    def clear(self):
        self.messages = []

    def estimate_tokens(self) -> int:
        """Very rough token estimate (~4 chars/token) for display only."""
        blob = self.system + json.dumps(self.messages, default=str)
        return len(blob) // 4

    def save(self, path: Path):
        data = {
            "saved_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "system": self.system,
            "messages": self.messages,
        }
        path.write_text(json.dumps(data, indent=2, default=str), encoding="utf-8")

    @classmethod
    def load(cls, path: Path) -> "Session":
        data = json.loads(path.read_text(encoding="utf-8"))
        s = cls()
        s.system = data.get("system", "")
        s.messages = data.get("messages", [])
        return s

    def cleanup_incomplete_turn(self) -> bool:
        """Pop a trailing assistant message with tool_use blocks but no tool results.

        Returns True if a dangling assistant message was removed (e.g. after Ctrl-C
        during tool execution).
        """
        if not self.messages:
            return False
        last = self.messages[-1]
        if last.get("role") != "assistant":
            return False
        content = last.get("content")
        if not isinstance(content, list):
            return False
        has_tool_use = any(
            isinstance(block, dict) and block.get("type") == "tool_use"
            for block in content
        )
        if has_tool_use:
            self.messages.pop()
            return True
        return False
