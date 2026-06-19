"""LLM client wrapper around the Anthropic Messages API with retry/backoff.

This is the layer that implements the user-requested feature: automatically
retry a query if it fails for any transient reason.
"""

from __future__ import annotations

import random
import time
from typing import Any, Callable

try:
    import anthropic
    from anthropic import Anthropic
except Exception:  # pragma: no cover
    anthropic = None  # type: ignore
    Anthropic = None  # type: ignore

from .config import Config


class LLMError(RuntimeError):
    """Raised when the LLM call ultimately fails after retries."""


# Exceptions that are worth retrying (transient). We match by class name so the
# module still imports even if the SDK isn't installed yet.
_RETRYABLE_NAMES = {
    "APIConnectionError",
    "APITimeoutError",
    "RateLimitError",
    "InternalServerError",
    "APIStatusError",
    "OverloadedError",
    "ServiceUnavailableError",
}

# HTTP status codes considered transient.
_RETRYABLE_STATUS = {408, 409, 425, 429, 500, 502, 503, 504, 529}


def _is_retryable(exc: Exception) -> bool:
    name = type(exc).__name__
    if name in _RETRYABLE_NAMES:
        # For APIStatusError, only retry transient status codes.
        status = getattr(exc, "status_code", None)
        if status is not None and status not in _RETRYABLE_STATUS:
            return False
        return True
    status = getattr(exc, "status_code", None)
    if isinstance(status, int) and status in _RETRYABLE_STATUS:
        return True
    return False


class LLMClient:
    """Thin wrapper that owns the Anthropic client and the retry policy."""

    def __init__(self, config: Config, on_retry: Callable[[int, int, Exception, float], None] | None = None, on_text_delta: Callable[[str], None] | None = None, on_thinking_delta: Callable[[str], None] | None = None):
        if anthropic is None or Anthropic is None:
            raise LLMError(
                "The 'anthropic' package is not installed. Run: pip install anthropic"
            )
        if not config.has_key:
            raise LLMError(
                "No API key found. Set ANTHROPIC_API_KEY (env, .env, or config.toml)."
            )
        self.config = config
        self.on_retry = on_retry
        self.on_text_delta = on_text_delta
        self.on_thinking_delta = on_thinking_delta
        kwargs: dict[str, Any] = {"api_key": config.api_key, "max_retries": 0}
        if config.base_url:
            kwargs["base_url"] = config.base_url
        self.client = Anthropic(**kwargs)

    def complete(
        self,
        system: str,
        messages: list[dict],
        tools: list[dict] | None = None,
    ) -> Any:
        """Call messages.create with retry. Returns the raw Message object."""
        attempt = 0
        last_exc: Exception | None = None
        max_retries = max(0, self.config.max_retries)

        # Convert the system string into a cacheable block so repeat turns
        # hit Anthropic's prompt cache. Caching a ~1k+ token system prompt
        # pays back on the second turn onwards.
        system_blocks = system
        if system and len(system) > 1024:
            system_blocks = [
                {
                    "type": "text",
                    "text": system,
                    "cache_control": {"type": "ephemeral"},
                }
            ]

        while attempt <= max_retries:
            try:
                create_kwargs: dict[str, Any] = {
                    "model": self.config.model,
                    "max_tokens": self.config.max_tokens,
                    "system": system_blocks,
                    "messages": messages,
                    "tools": tools or [],
                }
                if getattr(self.config, "thinking_budget", 0) > 0:
                    create_kwargs["thinking"] = {
                        "type": "enabled",
                        "budget_tokens": int(self.config.thinking_budget),
                    }
                if getattr(self.config, "stream", False) and self.on_text_delta is not None:
                    with self.client.messages.stream(**create_kwargs) as stream:
                        for event in stream:
                            etype = getattr(event, "type", None)
                            if etype == "content_block_delta":
                                delta = getattr(event, "delta", None)
                                dtype = getattr(delta, "type", None)
                                if dtype == "thinking_delta":
                                    chunk = getattr(delta, "thinking", "") or ""
                                    if chunk and self.on_thinking_delta:
                                        self.on_thinking_delta(chunk)
                                elif dtype == "text_delta":
                                    chunk = getattr(delta, "text", "") or ""
                                    if chunk and self.on_text_delta:
                                        self.on_text_delta(chunk)
                            elif etype == "text":
                                chunk = str(getattr(event, "text", "") or "")
                                if chunk and self.on_text_delta:
                                    self.on_text_delta(chunk)
                        return stream.get_final_message()
                return self.client.messages.create(**create_kwargs)
            except Exception as exc:  # noqa: BLE001 — we classify below
                last_exc = exc
                if type(exc).__name__ == "APIConnectionError":
                    break  # dead endpoint — fall back immediately, no 5x backoff
                retryable = _is_retryable(exc)
                if not retryable or attempt >= max_retries:
                    break
                attempt += 1
                # Exponential backoff with jitter.
                delay = self.config.retry_base_delay * (2 ** (attempt - 1))
                delay = min(delay, 30.0) + random.uniform(0, 0.5)
                if self.on_retry:
                    self.on_retry(attempt, max_retries, exc, delay)
                time.sleep(delay)

        raise LLMError(f"LLM request failed after {attempt} retr{'y' if attempt == 1 else 'ies'}: {last_exc}") from last_exc
