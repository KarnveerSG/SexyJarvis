"""LLM routing: Cursor plan → Claude API → local LLM fallback."""

from __future__ import annotations

from typing import Callable

from .config import Config
from .cursor_backend import CursorBackendError, CursorQuotaError, CursorRunner, is_cursor_quota_error
from .llm import LLMClient, LLMError
from .local_llm import LocalLLMClient


class RoutedLLMClient:
    """Picks Cursor, Anthropic, or local LLM per config; auto-falls back on failures."""

    def __init__(
        self,
        config: Config,
        ui,
        on_task_complete: Callable[[str], None] | None = None,
        on_retry: Callable | None = None,
        on_provider_switch: Callable[[str], None] | None = None,
        on_text_delta: Callable[[str], None] | None = None,
        on_thinking_delta: Callable[[str], None] | None = None,
    ):
        self.config = config
        self.ui = ui
        self.on_task_complete = on_task_complete
        self.on_retry = on_retry
        self.on_provider_switch = on_provider_switch
        self.on_text_delta = on_text_delta
        self.on_thinking_delta = on_thinking_delta
        self._anthropic: LLMClient | None = None
        self._local: LocalLLMClient | None = None
        self._cursor: CursorRunner | None = None
        self.active_provider = config.resolve_initial_provider()

    @property
    def uses_cursor_turns(self) -> bool:
        return self.active_provider == "cursor"

    def _ensure_anthropic(self) -> LLMClient:
        if self._anthropic is None:
            if self.config.fallback_model:
                self.config.model = self.config.fallback_model
            self._anthropic = LLMClient(
                self.config,
                on_retry=self.on_retry,
                on_text_delta=self.on_text_delta,
                on_thinking_delta=self.on_thinking_delta,
            )
        return self._anthropic

    def _ensure_local(self) -> LocalLLMClient:
        if self._local is None:
            self._local = LocalLLMClient(self.config, on_retry=self.on_retry, on_text_delta=self.on_text_delta)
        return self._local

    def _ensure_cursor(self) -> CursorRunner:
        if self._cursor is None:
            self._cursor = CursorRunner(self.config, self.ui, on_task_complete=self.on_task_complete)
        return self._cursor

    def switch_provider(self, provider: str, *, reason: str | None = None) -> None:
        provider = provider.lower()
        if provider not in ("cursor", "anthropic", "local"):
            return
        if provider == self.active_provider:
            return
        self.active_provider = provider
        self.config.active_provider = provider
        if provider == "anthropic" and self.config.fallback_model:
            self.config.model = self.config.fallback_model
        if self.on_provider_switch:
            self.on_provider_switch(provider)
        if reason:
            self.ui.info(reason)

    def try_fallback_to_local(self, reason: str) -> bool:
        if not self.config.fallback_enabled:
            return False
        if self.active_provider == "local":
            return False
        try:
            self._ensure_local()
        except LLMError as exc:
            self.ui.error(str(exc))
            return False
        self.switch_provider(
            "local",
            reason=f"{reason} — switched to local LLM ({self.config.local_model} @ {self._local.base_url}).",
        )
        return True

    def try_fallback_from_cursor(self, exc: Exception) -> bool:
        if not self.config.fallback_enabled or self.active_provider != "cursor":
            return False
        detail = str(exc).strip() or type(exc).__name__
        if self.config.has_key:
            self.switch_provider(
                "anthropic",
                reason=f"Cursor failed ({detail}) — trying Claude via Anthropic API ({self.config.fallback_model}).",
            )
            return True
        return self.try_fallback_to_local(f"Cursor failed ({detail})")

    def try_fallback_from_anthropic(self, exc: Exception) -> bool:
        if not self.config.fallback_enabled or self.active_provider != "anthropic":
            return False
        detail = str(exc).strip() or type(exc).__name__
        return self.try_fallback_to_local(f"Claude failed ({detail})")

    # Back-compat for tests / older call sites.
    def try_fallback_to_anthropic(self, exc: Exception) -> bool:
        if not self.config.fallback_enabled or self.active_provider != "cursor":
            return False
        if not is_cursor_quota_error(exc) and not isinstance(exc, CursorQuotaError):
            return False
        if not self.config.has_key:
            self.ui.error(
                "Cursor quota/rate limit hit, but no ANTHROPIC_API_KEY for fallback. "
                "Add a key to ~/.quill/.env or disable cursor provider."
            )
            return False
        self.switch_provider(
            "anthropic",
            reason=(
                "Cursor plan limit reached — switched to Claude via Anthropic API "
                f"({self.config.fallback_model})."
            ),
        )
        return True

    def complete(self, system: str, messages: list[dict], tools: list[dict] | None = None):
        if self.active_provider == "cursor":
            raise LLMError("Cursor provider handles full turns via run_turn_cursor(), not complete().")
        if self.active_provider == "local":
            return self._ensure_local().complete(system=system, messages=messages, tools=tools)
        return self._ensure_anthropic().complete(system=system, messages=messages, tools=tools)

    def run_turn_cursor(self, user_input: str, system: str) -> None:
        try:
            self._ensure_cursor().run_turn(user_input, system)
        except (CursorQuotaError, CursorBackendError) as exc:
            if self.try_fallback_from_cursor(exc):
                raise _FallbackSignal() from exc
            raise LLMError(str(exc)) from exc

    def reset_cursor(self) -> None:
        if self._cursor:
            self._cursor.reset()

    def stop(self) -> None:
        if self._cursor:
            self._cursor.stop()
            self._cursor = None

    def list_cursor_models(self) -> list[str]:
        try:
            runner = CursorRunner(self.config, self.ui)
            return runner.list_models()
        except Exception:
            return []


class _FallbackSignal(Exception):
    """Internal: provider turn failed; caller should retry on the next provider."""
