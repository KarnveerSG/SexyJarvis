"""Cost estimation for Anthropic models.

Prices are USD per 1M tokens (input/output). These are approximate; update as
Anthropic publishes new tiers. Unknown models fall back to Sonnet pricing.
"""

from __future__ import annotations

# Per 1M tokens: (input, output, cache_read, cache_write)
_PRICING: dict[str, tuple[float, float, float, float]] = {
    "claude-opus-4": (15.0, 75.0, 1.50, 18.75),
    "claude-opus-3": (15.0, 75.0, 1.50, 18.75),
    "claude-sonnet-4": (3.0, 15.0, 0.30, 3.75),
    "claude-sonnet-3-5": (3.0, 15.0, 0.30, 3.75),
    "claude-sonnet-3-7": (3.0, 15.0, 0.30, 3.75),
    "claude-haiku-4": (1.0, 5.0, 0.10, 1.25),
    "claude-haiku-3-5": (0.80, 4.0, 0.08, 1.00),
    "claude-haiku-3": (0.25, 1.25, 0.03, 0.30),
}

_DEFAULT = _PRICING["claude-sonnet-4"]


def _lookup(model: str) -> tuple[float, float, float, float]:
    m = (model or "").lower()
    # Find best prefix match.
    best = ""
    for key in _PRICING:
        if m.startswith(key) and len(key) > len(best):
            best = key
    return _PRICING.get(best, _DEFAULT)


def estimate_cost(
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_read: int = 0,
    cache_write: int = 0,
) -> float:
    """Return estimated USD cost for the given usage."""
    p_in, p_out, p_cr, p_cw = _lookup(model)
    return (
        input_tokens / 1_000_000 * p_in
        + output_tokens / 1_000_000 * p_out
        + cache_read / 1_000_000 * p_cr
        + cache_write / 1_000_000 * p_cw
    )


def format_cost_report(model: str, session) -> str:
    cost = estimate_cost(
        model,
        session.input_tokens,
        session.output_tokens,
        session.cache_read_tokens,
        session.cache_write_tokens,
    )
    lines = [
        f"Model: {model}",
        f"Turns:       {session.turns}",
        f"Input:       {session.input_tokens:,} tokens",
        f"Output:      {session.output_tokens:,} tokens",
    ]
    if session.cache_read_tokens or session.cache_write_tokens:
        lines.append(f"Cache read:  {session.cache_read_tokens:,} tokens")
        lines.append(f"Cache write: {session.cache_write_tokens:,} tokens")
    lines.append(f"Est. cost:   ${cost:,.4f} USD")
    return "\n".join(lines)
