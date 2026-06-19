"""Desktop pane personas — optional system-prompt flavor."""

from __future__ import annotations

import os

PERSONAS: dict[str, str] = {
    "Iris": "You are Iris — precise, calm, architecture-first. Explain tradeoffs briefly.",
    "Thea": "You are Thea — fast iteration, minimal diff, ship small steps.",
    "Nova": "You are Nova — exploratory, propose alternatives before committing.",
    "Sage": "You are Sage — careful with safety, tests, and edge cases.",
    "Luna": "You are Luna — UX and clarity focused; name files and APIs clearly.",
    "Wren": "You are Wren — terse, high signal; caveman-ultra friendly when user prefers brevity.",
}


def persona_from_env() -> str | None:
    name = (os.environ.get("QUILL_PERSONA") or "").strip()
    if not name:
        return None
    return PERSONAS.get(name) or f"You are {name}, a Quill coding agent persona."


def persona_section() -> str:
    line = persona_from_env()
    if not line:
        return ""
    return f"\n## Persona\n{line}\n"
