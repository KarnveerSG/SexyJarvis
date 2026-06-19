"""Terminal UI helpers. Uses `rich` if available, else plain-text fallback."""

from __future__ import annotations

import queue
import sys
import threading
from typing import Optional, Callable

try:
    from rich.console import Console
    from rich.markdown import Markdown
    from rich.panel import Panel
    from rich.syntax import Syntax
    from rich.text import Text
    from rich.align import Align
    from rich.padding import Padding
    from rich.table import Table
    _HAS_RICH = True
except Exception:  # pragma: no cover
    _HAS_RICH = False


_SLASH_COMMANDS = [
    "/help", "/exit", "/quit", "/new", "/clear", "/model", "/provider",
    "/models", "/fallback", "/memory", "/tools", "/retries", "/confirm",
    "/save", "/load", "/tokens", "/voice", "/speech", "/hotkey", "/rtk",
    "/codegraph", "/cost", "/compact", "/init", "/undo", "/plan", "/diff",
    "/commit", "/history", "/resume", "/commands", "/retry", "/export",
    "/bash", "/context", "/redo", "/test", "/pr",
    "/branch", "/stash", "/grep", "/budget", "/find", "/secrets",
    "/stats", "/sandbox", "/caveman", "/verbose", "/voicestyle",
]


_TOOL_STATUS_LABELS: dict[str, str] = {
    "read_file": "reading...",
    "write_file": "writing...",
    "edit_file": "writing...",
    "multi_edit": "writing...",
    "apply_patch": "writing...",
    "execute_bash": "running...",
    "list_dir": "exploring...",
    "glob": "searching...",
    "grep": "searching...",
    "codegraph_explore": "thinking...",
    "codegraph_search": "searching...",
    "codegraph_node": "reading...",
    "codegraph_callers": "searching...",
    "finish": "finishing...",
    # Cursor SDK tool names
    "read": "reading...",
    "write": "writing...",
    "edit": "writing...",
    "shell": "running...",
    "search": "searching...",
    "glob_file_search": "searching...",
    "list_dir": "exploring...",
}


def _tool_status_label(name: str) -> str:
    key = (name or "tool").lower()
    if key.startswith("codegraph_"):
        return _TOOL_STATUS_LABELS.get(key, "thinking...")
    return _TOOL_STATUS_LABELS.get(key, "working...")


DEFAULT_THEME = {
    "user_prompt": "bold green",
    "assistant_border": "cyan",
    "tool_call": "bold yellow",
    "tool_ok_border": "green",
    "tool_err_border": "red",
    "info": "cyan",
    "success": "bold green",
    "diff_border": "blue",
    "banner": "bold cyan",
}


class UI:
    def __init__(self, color: bool = True, theme: dict | None = None, verbose: bool = False):
        self.console = Console(highlight=False, force_terminal=True) if (_HAS_RICH and color) else None
        self._spinner_active = False
        self.verbose = verbose
        self.theme = {**DEFAULT_THEME, **(theme or {})}
        self._activity_label: str | None = None
        self._pt_session = None
        try:
            from prompt_toolkit import PromptSession
            from prompt_toolkit.completion import WordCompleter
            from prompt_toolkit.history import InMemoryHistory
            self._pt_session = PromptSession(
                history=InMemoryHistory(),
                completer=WordCompleter(_SLASH_COMMANDS, match_middle=False, sentence=False),
                complete_while_typing=False,
            )
        except Exception:
            self._pt_session = None

    # ---- generic -----------------------------------------------------
    def print(self, text: str = "", style: str | None = None):
        if self.console:
            self.console.print(text, style=style)
        else:
            print(text)

    def rule(self, title: str = ""):
        if self.console:
            self.console.rule(title)
        else:
            print(f"---- {title} ----" if title else "-" * 40)

    def banner(self, model: str, workspace: str, memory_files: list[str], provider: str = "", fallback: bool = True):
        art = r"""
  ____        _ _ _     
 |  _ \ _   _| | | | __
 | |_) | | | | | | |/ /
 |  __/| |_| | | |   < 
 |_|    \__,_|_|_|_|\_\
          CODE BEAUTIFUL
""".rstrip("\n")
        mem = ", ".join(memory_files) if memory_files else "none"
        fb = "Cursor → Claude → local" if fallback else "off"
        info = (
            f"🤖 Provider: {provider or 'auto'}\n"
            f"📊 Model: {model}\n"
            f"🔄 Fallback chain: {fb}\n"
            f"📁 Workspace: {workspace}\n"
            f"📝 Instruction files: {mem}\n"
            f"💡 Type [bold]/help[/bold] for commands"
        )
        if self.console:
            self.console.print(Text(art, style="bold cyan"))
            panel = Panel(
                Padding(info, (0, 2)), 
                border_style="cyan", 
                title="[bold cyan]Quill[/bold cyan]",
                title_align="center",
                expand=True
            )
            self.console.print(panel)
        else:
            print(art)
            print(info)
            print()

    # ---- activity status (single in-place line) --------------------
    def activity_begin(self) -> None:
        self._activity_label = None

    def activity_end(self) -> None:
        if self._activity_label is None:
            return
        if self.console:
            self.console.print()
        else:
            print()
        self._activity_label = None

    def _set_activity(self, label: str) -> None:
        if label == self._activity_label:
            return
        self._activity_label = label
        if self.console:
            self.console.print(f"[dim]{label}[/dim]", end="\r", highlight=False)
        else:
            print(f"\r{label}", end="", flush=True)

    # ---- conversation rendering -------------------------------------
    def stream_chunk(self, chunk: str):
        """Print a streaming text delta in-place (no panel/markdown)."""
        if self.console:
            self.console.print(chunk, end="", highlight=False, soft_wrap=True)
        else:
            print(chunk, end="", flush=True)

    def assistant_text(self, text: str, is_thinking: bool = False):
        if not text.strip():
            return
        if self.console:
            style = "dim" if is_thinking else "default"
            title = "🤔 Thinking" if is_thinking else "✨ Quill"
            self.console.print(
                Panel(
                    Markdown(text),
                    border_style="blue" if is_thinking else "cyan",
                    title=f"[bold]{title}[/bold]",
                    title_align="left",
                    padding=(0, 2)
                )
            )
        else:
            prefix = "[Thinking]" if is_thinking else "[Quill]"
            print(f"\n{prefix}\n{text}\n")

    def thinking(self, text: str):
        if not self.verbose:
            self._set_activity("thinking...")
            return
        if self.console:
            self.console.print(f"[blue dim]💭 {text}[/blue dim]")
        else:
            print(f"... {text}")

    def tool_call(self, name: str, summary: str):
        if not self.verbose:
            self._set_activity(_tool_status_label(name))
            return
        icons = {
            "execute_bash": "🔧",
            "read_file": "📖",
            "write_file": "✍️",
            "edit_file": "✏️",
            "list_dir": "📂",
            "glob": "🔍",
            "grep": "🔎",
            "finish": "✅",
        }
        icon = icons.get(name, "⚙️")
        label = f"{icon} {name}"
        if self.console:
            # Truncate long summaries for cleaner display
            display_summary = summary[:120] + ("..." if len(summary) > 120 else "")
            self.console.print(f"[bold yellow]{label}[/bold yellow] [dim white]{display_summary}[/dim white]")
        else:
            print(f"{label}  {summary}")

    def tool_result(self, name: str, content: str, is_error: bool, lang: str | None = None):
        if not self.verbose and not is_error:
            return
        preview = content if len(content) <= 1200 else content[:1200] + "\n[...truncated]"
        if self.console:
            # Syntax highlighting: explicit lang wins over heuristics.
            syntax_lang = lang
            if syntax_lang is None:
                if "Error" in content or is_error:
                    syntax_lang = "text"
                elif content.strip().startswith("{") or content.strip().startswith("["):
                    syntax_lang = "json"
                elif content.strip().startswith("<"):
                    syntax_lang = "html"
                elif "def " in content or "class " in content:
                    syntax_lang = "python"
            
            border_style = "red" if is_error else "green"
            title_icon = "❌" if is_error else "✓"
            
            if syntax_lang:
                content_panel = Syntax(preview, syntax_lang, theme="monokai", line_numbers=False)
            else:
                content_panel = preview
            
            self.console.print(
                Panel(
                    content_panel,
                    border_style=border_style,
                    title=f"[bold]{title_icon} {name}[/bold]",
                    title_align="left",
                    padding=(0, 1)
                )
            )
        else:
            tag = "ERROR" if is_error else "OK"
            print(f"  [{name} {tag}]\n  " + preview.replace("\n", "\n  ") + "\n")

    def show_diff(self, diff: str):
        if not diff or not diff.strip():
            return
        if self.console:
            self.console.print(
                Panel(Syntax(diff, "diff", theme="monokai", line_numbers=False), title="Diff", border_style="blue")
            )
        else:
            print(diff)

    def retry_notice(self, attempt: int, total: int, exc: Exception, delay: float):
        exc_name = type(exc).__name__
        msg = f"⚠️  LLM call failed ({exc_name}). Retry {attempt}/{total} in {delay:.1f}s..."
        if self.console:
            self.console.print(f"[bold yellow]{msg}[/bold yellow]")
        else:
            print(msg, file=sys.stderr)

    def error(self, text: str):
        if self.console:
            try:
                self.console.print(Panel(f"❌ {text}", border_style="red", title="[bold red]Error[/bold red]", title_align="left", padding=(0, 2)))
            except Exception:
                print(f"Error: {text}", file=sys.stderr)
        else:
            print(f"Error: {text}", file=sys.stderr)

    def info(self, text: str):
        if self.console:
            self.console.print(f"[cyan]ℹ️  {text}[/cyan]")
        else:
            print(text)
    
    def success(self, text: str):
        if self.console:
            self.console.print(f"[bold green]✅ {text}[/bold green]")
        else:
            print(text)

    def status(self, message: str):
        """Context manager for a spinner while the model thinks."""
        if self.console:
            return self.console.status(f"[cyan]⏳ {message}[/cyan]", spinner="dots12")
        return _NullStatus()

    def prompt(self) -> str:
        line = self._raw_prompt("you › ")
        # `:edit` opens $EDITOR for a longer message.
        if line.strip() == ":edit":
            return self._open_editor()
        # Trailing backslash continues onto the next line.
        if line.endswith("\\"):
            buf = [line.rstrip("\\")]
            while True:
                cont = self._raw_prompt("... › ")
                if cont.endswith("\\"):
                    buf.append(cont.rstrip("\\"))
                else:
                    buf.append(cont)
                    break
            return "\n".join(buf)
        return line

    def _raw_prompt(self, label: str) -> str:
        if self._pt_session is not None:
            try:
                return self._pt_session.prompt(label)
            except (EOFError, KeyboardInterrupt):
                raise
            except Exception:
                pass
        if self.console:
            self.console.print(f"[bold green]{label}[/bold green]", end="", highlight=False)
            return input()
        return input(label)

    def _open_editor(self) -> str:
        import os, tempfile, subprocess
        editor = os.environ.get("EDITOR") or ("notepad" if os.name == "nt" else "vi")
        with tempfile.NamedTemporaryFile(mode="w", suffix=".sjmsg.md", delete=False) as tf:
            tf.write("# Write your message below. Save & close to send.\n")
            path = tf.name
        try:
            subprocess.run([editor, path])
            with open(path, "r", encoding="utf-8") as f:
                text = f.read()
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass
        return "\n".join(
            ln for ln in text.splitlines() if not ln.startswith("# ")
        ).strip()

    def voice_prompt(
        self,
        hotkey_hint: str,
        poll_speech: Optional[Callable[[], Optional[str]]] = None,
    ) -> str:
        """Wait for typed input or a push-to-talk transcription with timeout."""
        if self.console:
            self.console.print("[bold green]you › [/bold green]", end="", highlight=False)
        else:
            print("you › ", end="", flush=True)

        result_queue: queue.Queue[tuple[str, str]] = queue.Queue()
        reader_thread_started = threading.Event()

        def read_line() -> None:
            reader_thread_started.set()
            try:
                line = input()
                result_queue.put(("text", line))
            except EOFError:
                result_queue.put(("eof", ""))
            except Exception:
                result_queue.put(("error", ""))

        thread = threading.Thread(target=read_line, daemon=True)
        thread.start()
        reader_thread_started.wait(timeout=1.0)

        while thread.is_alive():
            try:
                kind, data = result_queue.get(timeout=0.08)
                if kind == "eof":
                    raise EOFError
                if kind == "error":
                    raise RuntimeError("Failed to read input")
                return data
            except queue.Empty:
                if poll_speech is not None:
                    try:
                        spoken = poll_speech()
                        if spoken:
                            if self.console:
                                self.console.print(f"[cyan]🎤 {spoken}[/cyan]")
                            else:
                                print(spoken)
                            return spoken
                    except Exception:
                        pass  # Continue polling
                continue
        
        # Thread exited; check for result
        try:
            kind, data = result_queue.get(timeout=0.1)
            if kind == "eof":
                raise EOFError
            if kind == "error":
                raise RuntimeError("Failed to read input")
            return data
        except queue.Empty:
            raise EOFError


class _NullStatus:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False
