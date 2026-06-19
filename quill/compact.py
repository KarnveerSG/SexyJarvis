"""Conversation compaction: summarize prior turns and replace them with a
single condensed message, freeing context for a long-running session.
"""

from __future__ import annotations

import json

_COMPACT_SYSTEM = (
    "Compaction assistant. Summarize prior agent conversation in caveman ultra: "
    "fragments, bullets, no filler. Capture: goals, tried, files touched, TODOs, key errors."
)


def _messages_to_text(messages: list[dict]) -> str:
    """Flatten the Anthropic message list to plain text for the summarizer."""
    lines: list[str] = []
    for msg in messages:
        role = msg.get("role", "?")
        content = msg.get("content", "")
        if isinstance(content, str):
            lines.append(f"[{role}] {content}")
            continue
        if isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                btype = block.get("type")
                if btype == "text":
                    lines.append(f"[{role}/text] {block.get('text', '')}")
                elif btype == "tool_use":
                    name = block.get("name", "")
                    args = json.dumps(block.get("input", {}), default=str)[:400]
                    lines.append(f"[{role}/tool_use] {name}({args})")
                elif btype == "tool_result":
                    raw = block.get("content", "")
                    if isinstance(raw, list):
                        raw = " ".join(b.get("text", "") for b in raw if isinstance(b, dict))
                    lines.append(f"[{role}/tool_result] {str(raw)[:600]}")
    return "\n".join(lines)


def compact_session(session, llm) -> tuple[bool, str]:
    """Summarize session.messages into one user/assistant pair.

    `llm` must be a RoutedLLMClient (or anything with .complete()).
    Returns (success, status_message).
    """
    if len(session.messages) < 4:
        return False, "Not enough history to compact."

    transcript = _messages_to_text(session.messages)
    if not transcript.strip():
        return False, "Nothing to compact."

    try:
        response = llm.complete(
            system=_COMPACT_SYSTEM,
            messages=[{"role": "user", "content": f"Conversation transcript to summarize:\n\n{transcript}"}],
            tools=[],
        )
    except Exception as exc:  # noqa: BLE001
        return False, f"Compaction failed: {exc}"

    summary = ""
    for block in getattr(response, "content", []) or []:
        if getattr(block, "type", None) == "text":
            summary += block.text
    summary = summary.strip()
    if not summary:
        return False, "Compaction produced no summary."

    prior_count = len(session.messages)
    session.messages = [
        {"role": "user", "content": "[Compacted prior conversation]"},
        {"role": "assistant", "content": f"Summary of prior work:\n\n{summary}"},
    ]
    return True, f"Compacted {prior_count} messages into a summary ({len(summary)} chars)."
