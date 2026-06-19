"""OpenAI-compatible local LLM client (LM Studio, Ollama, etc.)."""

from __future__ import annotations

import json
import random
import time
import uuid
from dataclasses import dataclass
from typing import Any, Callable
from urllib.error import URLError
from urllib.request import Request, urlopen

from .config import Config
from .llm import LLMError, _is_retryable


@dataclass
class _TextBlock:
    type: str
    text: str


@dataclass
class _ToolUseBlock:
    type: str
    id: str
    name: str
    input: dict


@dataclass
class _Usage:
    input_tokens: int = 0
    output_tokens: int = 0


@dataclass
class _Message:
    content: list[Any]
    stop_reason: str | None
    usage: _Usage | None = None


def probe_local_url(timeout: float = 0.8) -> str | None:
    """Return the first reachable OpenAI-compatible local base URL."""
    for base in ("http://localhost:1234/v1", "http://localhost:11434/v1"):
        try:
            req = Request(f"{base.rstrip('/')}/models", method="GET")
            with urlopen(req, timeout=timeout) as resp:
                if 200 <= resp.status < 300:
                    return base
        except (OSError, URLError, TimeoutError, ValueError):
            continue
    return None


def _anthropic_tools_to_openai(tools: list[dict] | None) -> list[dict]:
    out: list[dict] = []
    for tool in tools or []:
        out.append(
            {
                "type": "function",
                "function": {
                    "name": tool.get("name", ""),
                    "description": tool.get("description", ""),
                    "parameters": tool.get("input_schema") or {"type": "object", "properties": {}},
                },
            }
        )
    return out


def _anthropic_messages_to_openai(messages: list[dict]) -> list[dict]:
    out: list[dict] = []
    for msg in messages:
        role = msg.get("role")
        content = msg.get("content")
        if role == "user" and isinstance(content, str):
            out.append({"role": "user", "content": content})
            continue
        if role == "assistant" and isinstance(content, list):
            text_parts: list[str] = []
            tool_calls: list[dict] = []
            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "text":
                    text_parts.append(str(block.get("text", "")))
                elif block.get("type") == "tool_use":
                    tool_calls.append(
                        {
                            "id": block.get("id") or f"call_{uuid.uuid4().hex[:12]}",
                            "type": "function",
                            "function": {
                                "name": block.get("name", ""),
                                "arguments": json.dumps(block.get("input") or {}),
                            },
                        }
                    )
            assistant: dict[str, Any] = {"role": "assistant"}
            if text_parts:
                assistant["content"] = "\n".join(text_parts)
            if tool_calls:
                assistant["tool_calls"] = tool_calls
            if assistant.get("content") is None and not tool_calls:
                assistant["content"] = ""
            out.append(assistant)
            continue
        if role == "user" and isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_result":
                    out.append(
                        {
                            "role": "tool",
                            "tool_call_id": block.get("tool_use_id", ""),
                            "content": str(block.get("content", "")),
                        }
                    )
            continue
        if isinstance(content, str):
            out.append({"role": role, "content": content})
    return out


def _openai_response_to_message(data: dict) -> _Message:
    choice = (data.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    blocks: list[Any] = []
    text = message.get("content")
    if text:
        blocks.append(_TextBlock(type="text", text=str(text)))
    for call in message.get("tool_calls") or []:
        fn = call.get("function") or {}
        raw_args = fn.get("arguments") or "{}"
        try:
            args = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
        except json.JSONDecodeError:
            args = {"raw": raw_args}
        blocks.append(
            _ToolUseBlock(
                type="tool_use",
                id=call.get("id") or f"call_{uuid.uuid4().hex[:12]}",
                name=fn.get("name", ""),
                input=args if isinstance(args, dict) else {},
            )
        )
    usage_raw = data.get("usage") or {}
    usage = _Usage(
        input_tokens=int(usage_raw.get("prompt_tokens") or 0),
        output_tokens=int(usage_raw.get("completion_tokens") or 0),
    )
    finish = choice.get("finish_reason")
    stop_reason = "tool_use" if finish == "tool_calls" else ("end_turn" if finish == "stop" else finish)
    return _Message(content=blocks, stop_reason=stop_reason, usage=usage)


class LocalLLMClient:
    """Chat-completions client for LM Studio / Ollama-style local servers."""

    def __init__(
        self,
        config: Config,
        on_retry: Callable[[int, int, Exception, float], None] | None = None,
        on_text_delta: Callable[[str], None] | None = None,
    ):
        base = (config.local_base_url or "").rstrip("/")
        if not base:
            base = probe_local_url() or ""
        if not base:
            raise LLMError(
                "No local LLM found. Start LM Studio/Ollama or set LM_STUDIO_URL / QUILL_LOCAL_URL."
            )
        self.config = config
        self.base_url = base
        self.on_retry = on_retry
        self.on_text_delta = on_text_delta

    def complete(
        self,
        system: str,
        messages: list[dict],
        tools: list[dict] | None = None,
    ) -> _Message:
        attempt = 0
        last_exc: Exception | None = None
        max_retries = max(0, self.config.max_retries)
        payload = {
            "model": self.config.local_model,
            "max_tokens": self.config.max_tokens,
            "messages": ([{"role": "system", "content": system}] if system else [])
            + _anthropic_messages_to_openai(messages),
            "tools": _anthropic_tools_to_openai(tools) or None,
        }
        payload = {k: v for k, v in payload.items() if v is not None}
        body = json.dumps(payload).encode("utf-8")
        url = f"{self.base_url.rstrip('/')}/chat/completions"

        while attempt <= max_retries:
            try:
                req = Request(
                    url,
                    data=body,
                    method="POST",
                    headers={"Content-Type": "application/json"},
                )
                with urlopen(req, timeout=max(30, self.config.bash_timeout)) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                return _openai_response_to_message(data)
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                retryable = _is_retryable(exc) or isinstance(exc, (OSError, URLError, TimeoutError))
                if not retryable or attempt >= max_retries:
                    break
                attempt += 1
                delay = min(self.config.retry_base_delay * (2 ** (attempt - 1)), 30.0) + random.uniform(0, 0.5)
                if self.on_retry:
                    self.on_retry(attempt, max_retries, exc, delay)
                time.sleep(delay)

        raise LLMError(
            f"Local LLM request failed after {attempt} retr{'y' if attempt == 1 else 'ies'}: {last_exc}"
        ) from last_exc
