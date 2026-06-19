"""Cursor SDK backend — run turns through your Cursor plan models."""

from __future__ import annotations

from typing import Callable

from .config import Config
from .cursor_patch import apply as _apply_cursor_windows_patch, close_with_timeout

_apply_cursor_windows_patch()


class CursorBackendError(RuntimeError):
    """Cursor agent run failed."""


class CursorQuotaError(CursorBackendError):
    """Cursor plan quota / rate limit — caller may fall back to Anthropic."""


def is_cursor_quota_error(exc: Exception) -> bool:
    name = type(exc).__name__
    if name in ("RateLimitError", "PermissionDeniedError"):
        return True
    msg = str(exc).lower()
    needles = (
        "rate limit",
        "usage limit",
        "quota",
        "out of tokens",
        "token limit",
        "billing",
        "spend limit",
        "too many requests",
    )
    return any(n in msg for n in needles)


def _resolve_model(cursor_model: str) -> str:
    model = (cursor_model or "auto").strip()
    if model.lower() == "auto":
        return "composer-2.5"
    return model


class CursorRunner:
    """Delegates a user turn to a persistent local Cursor agent (Cursor plan billing)."""

    def __init__(
        self,
        config: Config,
        ui,
        on_task_complete: Callable[[str], None] | None = None,
    ):
        self.config = config
        self.ui = ui
        self.on_task_complete = on_task_complete
        self._agent = None
        self._system_sent = False

    def available(self) -> bool:
        try:
            import cursor_sdk  # noqa: F401
            return bool(self.config.cursor_api_key)
        except ImportError:
            return False

    def start(self) -> None:
        if self._agent is not None:
            return
        if not self.config.cursor_api_key:
            raise CursorBackendError(
                "CURSOR_API_KEY missing. Add to %USERPROFILE%\\.quill\\.env "
                "(Cursor Dashboard → API Keys)."
            )
        try:
            from cursor_sdk import Agent, LocalAgentOptions
        except ImportError as exc:
            raise CursorBackendError(
                "Cursor provider requires cursor-sdk. Rebuild with: "
                "python scripts/build_binary.py --install --with cursor"
            ) from exc

        create_kwargs: dict = {
            "api_key": self.config.cursor_api_key,
            "model": _resolve_model(self.config.cursor_model),
            "local": LocalAgentOptions(cwd=str(self.config.workspace)),
        }

        try:
            self._agent = Agent.create(**create_kwargs)
        except Exception as exc:
            if is_cursor_quota_error(exc):
                raise CursorQuotaError(str(exc)) from exc
            raise CursorBackendError(f"Could not start Cursor agent: {exc}") from exc

    def stop(self) -> None:
        agent = self._agent
        self._agent = None
        self._system_sent = False
        if agent is not None:
            close_with_timeout(agent.close)

    def reset(self) -> None:
        self.stop()
        self.start()

    def list_models(self) -> list[str]:
        try:
            from cursor_sdk import Cursor
        except ImportError:
            return []
        if not self.config.cursor_api_key:
            return []
        try:
            models = Cursor.models.list(api_key=self.config.cursor_api_key)
            return [m.id for m in models if getattr(m, "id", None)]
        except Exception:
            return []

    def run_turn(self, user_input: str, system: str) -> None:
        if self._agent is None:
            self.start()

        prompt = user_input
        if system and not self._system_sent:
            prompt = f"{system}\n\n---\n\nUser task: {user_input}"
            self._system_sent = True

        run = None
        self.ui.activity_begin()
        try:
            run = self._agent.send(prompt)
            summary_parts: list[str] = []
            assistant_parts: list[str] = []
            stream = getattr(self.config, "stream", True)
            verbose = getattr(self.ui, "verbose", False)

            for message in run.messages():
                mtype = getattr(message, "type", None)
                if mtype == "assistant":
                    text = _extract_assistant_text(message)
                    if text:
                        assistant_parts.append(text)
                        if stream and verbose:
                            self.ui.stream_chunk(text)
                elif mtype == "tool_call":
                    name = getattr(message, "name", "tool")
                    args = getattr(message, "args", {}) or {}
                    preview = str(args)[:200]
                    self.ui.tool_call(name, preview)

            if assistant_parts:
                full_text = "".join(assistant_parts)
                summary_parts.append(full_text)
                if stream and verbose:
                    self.ui.print("")
                elif verbose:
                    self.ui.assistant_text(full_text)

            result = run.wait()
            if getattr(result, "status", None) == "error":
                raise CursorBackendError(getattr(result, "result", None) or "Cursor run failed.")

            final = (getattr(result, "result", None) or "").strip()
            if not final and summary_parts:
                final = summary_parts[-1].strip()
            if final:
                self.ui.rule("Task complete")
                self.ui.info(final)
                if self.on_task_complete:
                    self.on_task_complete(final)

        except KeyboardInterrupt:
            if run is not None:
                try:
                    run.cancel()
                except Exception:
                    pass
            raise
        except Exception as exc:
            if is_cursor_quota_error(exc):
                raise CursorQuotaError(str(exc)) from exc
            raise CursorBackendError(str(exc)) from exc
        finally:
            self.ui.activity_end()


def _extract_assistant_text(message) -> str:
    chunks: list[str] = []
    msg = getattr(message, "message", None)
    content = getattr(msg, "content", None) if msg is not None else None
    if not content:
        return getattr(message, "text", "") or ""
    for block in content:
        btype = getattr(block, "type", None)
        if btype == "text":
            chunks.append(getattr(block, "text", ""))
    return "\n".join(c for c in chunks if c).strip()
