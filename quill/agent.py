"""The agentic loop: drive the LLM, execute tool calls, feed results back."""

from __future__ import annotations

import json

from .config import Config
from .llm import LLMError
from .llm_router import RoutedLLMClient, _FallbackSignal
from .session import Session
from .cost import estimate_cost
from .tools import DESTRUCTIVE_TOOLS, ToolRunner, get_tool_schemas, is_dangerous_command
from .ui import UI

_MAX_CURSOR_HISTORY = 10
_COMPACT_THRESHOLD = 24


def _summarize_args(name: str, args: dict) -> str:
    if name == "execute_bash":
        return args.get("command", "")[:200]
    if name in ("read_file", "write_file", "edit_file"):
        return str(args.get("path", ""))
    if name == "list_dir":
        return str(args.get("path", "."))
    if name in ("glob", "grep"):
        return str(args.get("pattern", ""))
    if name.startswith("codegraph_"):
        return str(args.get("query") or args.get("symbol") or args.get("file", ""))[:200]
    if name == "finish":
        return "task complete"
    return json.dumps(args)[:200]


class Agent:
    """Runs one user turn to completion (possibly many tool calls)."""

    def __init__(self, config: Config, session: Session, ui: UI, on_task_complete=None):
        self.config = config
        self.session = session
        self.ui = ui
        self.on_task_complete = on_task_complete
        self.runner = ToolRunner(config)

        def on_switch(provider: str) -> None:
            config.active_provider = provider

        def _stream_text(chunk: str) -> None:
            if ui.verbose:
                ui.stream_chunk(chunk)

        def _stream_thinking(chunk: str) -> None:
            if ui.verbose:
                ui.thinking(chunk)

        self.llm = RoutedLLMClient(
            config,
            ui,
            on_task_complete=on_task_complete,
            on_retry=ui.retry_notice,
            on_provider_switch=on_switch,
            on_text_delta=_stream_text if getattr(config, "stream", False) else None,
            on_thinking_delta=_stream_thinking if getattr(config, "stream", False) else None,
        )

    def _confirm(self, name: str, args: dict) -> bool:
        """Ask the user before a destructive action (unless confirm disabled).

        Dangerous bash commands ALWAYS require confirmation even with --yolo.
        Plan mode blocks all destructive tools outright.
        """
        if self.config.plan_mode and name in DESTRUCTIVE_TOOLS:
            self.ui.error(
                f"Plan mode is on — {name} is blocked. Disable with /plan off."
            )
            return False
        dangerous = name == "execute_bash" and is_dangerous_command(str(args.get("command", "")))
        if not dangerous and (not self.config.confirm or name not in DESTRUCTIVE_TOOLS):
            return True
        summary = _summarize_args(name, args)
        if dangerous:
            self.ui.print(
                f"\n🚨 DANGEROUS command detected: [bold red]{summary}[/bold red]",
                style="bold red",
            )
        else:
            self.ui.print(f"\n⚠  About to run [bold]{name}[/bold]: {summary}", style="yellow")
        # Inline diff preview for destructive writes.
        if name in ("write_file", "edit_file", "multi_edit", "apply_patch"):
            preview = self.runner.preview(name, args)
            if preview:
                self.ui.show_diff(preview)
        try:
            ans = input("   Proceed? [Y/n/a(lways)] ").strip().lower()
        except EOFError:
            return False
        if ans in ("a", "always") and not dangerous:
            self.config.confirm = False
            return True
        return ans in ("", "y", "yes")

    def run_turn(self, user_input: str) -> None:
        """Process a single user message, looping over tool calls until done."""
        start_in = self.session.input_tokens
        start_out = self.session.output_tokens
        self.session.add_user(user_input)

        if self.llm.uses_cursor_turns:
            try:
                self.llm.run_turn_cursor(user_input, self.session.system)
                self._trim_session_history()
                self._announce_turn_cost(start_in, start_out)
                return
            except _FallbackSignal:
                pass  # retry below on Anthropic/local tool loop

        self.ui.activity_begin()
        try:
            iterations = 0
            provider_retries = 0

            while iterations < self.config.max_iterations:
                iterations += 1
                try:
                    with self.ui.status("Thinking..."):
                        response = self.llm.complete(
                            system=self.session.system,
                            messages=self.session.messages,
                            tools=get_tool_schemas(self.config, mcp_registry=getattr(self.runner, "mcp", None)),
                        )
                except LLMError as e:
                    if provider_retries == 0 and self.llm.try_fallback_from_anthropic(e):
                        provider_retries += 1
                        iterations -= 1
                        continue
                    self.ui.error(str(e))
                    return

                # Capture token usage if the SDK returned it.
                usage = getattr(response, "usage", None)
                if usage is not None:
                    self.session.add_usage(
                        input_t=getattr(usage, "input_tokens", 0) or 0,
                        output_t=getattr(usage, "output_tokens", 0) or 0,
                        cache_r=getattr(usage, "cache_read_input_tokens", 0) or 0,
                        cache_w=getattr(usage, "cache_creation_input_tokens", 0) or 0,
                    )

                # Record the assistant message (content blocks) verbatim.
                assistant_content = []
                tool_uses = []
                text_chunks = []
                for block in response.content:
                    btype = getattr(block, "type", None)
                    if btype == "thinking":
                        thought = getattr(block, "thinking", "") or ""
                        if thought:
                            self.ui.thinking(thought)
                        assistant_content.append({"type": "thinking", "thinking": thought})
                    elif btype == "text":
                        text_chunks.append(block.text)
                        assistant_content.append({"type": "text", "text": block.text})
                    elif btype == "tool_use":
                        tool_uses.append(block)
                        assistant_content.append(
                            {
                                "type": "tool_use",
                                "id": block.id,
                                "name": block.name,
                                "input": block.input,
                            }
                        )

                self.session.add_raw("assistant", assistant_content)

                if text_chunks and not getattr(self.config, "stream", False):
                    self.ui.assistant_text("\n".join(text_chunks))
                elif text_chunks:
                    self.ui.print("")

                if not tool_uses:
                    if text_chunks and self.on_task_complete:
                        self.on_task_complete("\n".join(text_chunks))
                    self._announce_turn_cost(start_in, start_out)
                    self._maybe_compact_history()
                    return

                tool_results = []
                finished = False
                for tu in tool_uses:
                    name = tu.name
                    args = tu.input or {}
                    self.ui.tool_call(name, _summarize_args(name, args))

                    if not self._confirm(name, args):
                        tool_results.append(
                            {
                                "type": "tool_result",
                                "tool_use_id": tu.id,
                                "content": "User declined to run this action.",
                                "is_error": True,
                            }
                        )
                        continue

                    if name == "finish":
                        summary = args.get("summary", "Task complete.")
                        self.ui.rule("Task complete")
                        self.ui.info(summary)
                        if self.on_task_complete:
                            self.on_task_complete(summary)
                        tool_results.append(
                            {
                                "type": "tool_result",
                                "tool_use_id": tu.id,
                                "content": summary,
                            }
                        )
                        finished = True
                        continue

                    result = self.runner.run(name, args)
                    self.ui.tool_result(name, result.content, result.is_error, lang=result.lang)
                    if result.diff:
                        self.ui.show_diff(result.diff)
                    tool_results.append(
                        {
                            "type": "tool_result",
                            "tool_use_id": tu.id,
                            "content": result.content or "(no output)",
                            "is_error": result.is_error,
                        }
                    )

                self.session.add_raw("user", tool_results)

                if finished:
                    self._announce_turn_cost(start_in, start_out)
                    self._maybe_compact_history()
                    return

            self.ui.error(
                f"Reached max iterations ({self.config.max_iterations}). Pausing. "
                "Send another message to continue, or raise the limit with --max-iterations."
            )
            self._announce_turn_cost(start_in, start_out)
        finally:
            self.ui.activity_end()

    def _trim_session_history(self) -> None:
        if len(self.session.messages) > _MAX_CURSOR_HISTORY:
            self.session.messages = self.session.messages[-_MAX_CURSOR_HISTORY:]

    def _maybe_compact_history(self) -> None:
        if len(self.session.messages) < _COMPACT_THRESHOLD:
            return
        if self.llm.uses_cursor_turns:
            self._trim_session_history()
            return
        from .compact import compact_session

        try:
            with self.ui.status("Compacting history..."):
                ok, msg = compact_session(self.session, self.llm)
            if ok:
                self.ui.info(msg)
        except Exception:
            self._trim_session_history()

    def _announce_turn_cost(self, start_in: int, start_out: int) -> None:
        delta_in = self.session.input_tokens - start_in
        delta_out = self.session.output_tokens - start_out
        if delta_in == 0 and delta_out == 0:
            return
        cost = estimate_cost(self.config.display_model(), delta_in, delta_out)
        self.ui.info(
            f"↳ turn used {delta_in:,} in / {delta_out:,} out tokens · ~${cost:.4f}"
        )
