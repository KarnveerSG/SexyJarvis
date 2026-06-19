"""Opt-in local telemetry — JSONL of tool calls + outcomes.

Stored at `.quill/telemetry.jsonl`. Never leaves the user's machine.
Set `[telemetry] enabled = true` in config to turn on, or `/stats on`.
"""

from __future__ import annotations

import json
import time
from collections import Counter
from pathlib import Path


def _path(workspace: Path) -> Path:
    d = workspace / ".quill"
    d.mkdir(parents=True, exist_ok=True)
    return d / "telemetry.jsonl"


def record(workspace: Path, event: dict) -> None:
    line = json.dumps({"ts": time.time(), **event}, default=str)
    try:
        with _path(workspace).open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def summary(workspace: Path, limit: int = 200) -> str:
    p = _path(workspace)
    if not p.is_file():
        return "(no telemetry recorded)"
    calls: Counter[str] = Counter()
    errors: Counter[str] = Counter()
    total = 0
    try:
        lines = p.read_text(encoding="utf-8").splitlines()[-limit:]
    except Exception:
        return "(failed to read telemetry)"
    for ln in lines:
        try:
            ev = json.loads(ln)
        except Exception:
            continue
        if ev.get("kind") != "tool_call":
            continue
        total += 1
        name = ev.get("name", "?")
        calls[name] += 1
        if ev.get("is_error"):
            errors[name] += 1
    if not total:
        return "(no tool calls in window)"
    lines_out = [f"Total tool calls in last {len(lines)} events: {total}"]
    lines_out.append("By tool (call / error count):")
    for name, n in calls.most_common():
        lines_out.append(f"  {name:24s} {n:>5}   err={errors.get(name, 0)}")
    return "\n".join(lines_out)
