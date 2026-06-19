"""Best-effort secret pattern detection for file writes.

We refuse to silently write content that looks like an API key. The user
can disable this with `secret_scan = false` in config or `/secrets off`.
"""

from __future__ import annotations

import re

_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("AWS access key id", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("AWS secret access key", re.compile(r"(?i)aws(.{0,20})?(secret|access).{0,20}['\"]?[A-Za-z0-9/+=]{40}['\"]?")),
    ("GitHub personal token", re.compile(r"\bghp_[A-Za-z0-9]{36,}\b")),
    ("GitHub app token", re.compile(r"\bghs_[A-Za-z0-9]{36,}\b")),
    ("Anthropic API key", re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}\b")),
    ("OpenAI API key", re.compile(r"\bsk-[A-Za-z0-9]{20,}\b")),
    ("Slack token", re.compile(r"\bxox[abpr]-[A-Za-z0-9-]{10,}\b")),
    ("Stripe live key", re.compile(r"\bsk_live_[A-Za-z0-9]{20,}\b")),
    ("Google API key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("Private key block", re.compile(r"-----BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE KEY-----")),
]


def scan(content: str) -> list[tuple[str, str]]:
    """Return list of (label, matched_text) findings."""
    findings: list[tuple[str, str]] = []
    for label, pat in _PATTERNS:
        m = pat.search(content)
        if m:
            findings.append((label, m.group(0)[:80]))
    return findings
