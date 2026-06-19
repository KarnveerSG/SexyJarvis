"""Command-line entry point and interactive REPL."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import __version__
from .agent import Agent
from .config import load_config
from .memory import build_memory_section
from .prompts import build_system_prompt
from .session import Session
from .tools import TOOL_SCHEMAS, get_tool_schemas
from .codegraph_tools import codegraph_status
from .rtk import rtk_available
from .ui import UI
from .mentions import expand_mentions
from .cost import estimate_cost, format_cost_report
from .compact import compact_session
from .init_cmd import generate_sexyjarvis_md
from .extras import (
    archive_to_history,
    autosave_path,
    detect_test_command,
    discover_custom_commands,
    export_markdown,
    gh_pr_create,
    git_branch,
    git_diff,
    git_stash,
    git_status,
    list_history,
    retry_last_user_message,
    run_tests,
)

HELP_TEXT = """\
Slash commands:
  /help            Show this help
  /exit, /quit     Leave SexyJarvis
  /new, /clear     Start a fresh conversation (keeps system prompt)
  /model [name]    Show or change the model
  /provider [name] Show or switch provider (auto, cursor, anthropic, local)
  /models          List Cursor plan models (when using Cursor)
  /fallback [on|off] Toggle Claude API fallback when Cursor quota is hit
  /memory          Reload and show loaded instruction files
  /tools           List available agent tools
  /retries [n]     Show or set max LLM retries
  /confirm [on|off] Toggle confirmation before destructive actions
  /save [file]     Save the conversation to a JSON file
  /load <file>     Load a conversation from a JSON file
  /tokens          Rough token estimate of current context
  /voice [on|off]  Toggle spoken task-completion announcements
  /voicestyle [name]  Switch TTS voice preset (intimate, playful, bright)
  /speech [on|off] Toggle push-to-talk speech input
  /hotkey          Show the push-to-talk hotkey
  /rtk [on|off]    Toggle RTK compact shell output
  /caveman [on|off] Toggle terse caveman output style
  /verbose [on|off] Toggle detailed tool-call output
  /codegraph [on|off]  Toggle CodeGraph tools / show status
  /cost            Show cumulative token usage and estimated cost
  /compact         Summarize prior turns to free context
  /init            Generate a starter SEXYJARVIS.md from the workspace
  /undo            Revert the last file change made by the agent
  /plan [on|off]   Read-only planning mode (no writes / shell)
  /diff [staged]   Show git working-tree diff
  /commit <msg>    Stage everything and commit with message
  /history         List past saved sessions
  /resume          Reload the most recent autosaved session
  /commands        List user-defined slash commands
  /retry           Re-run the last user message
  /export [file]   Export the session as a Markdown transcript
  /bash [n]        Show shell command history; /bash <n> re-run by index
  /context         Print the assembled system prompt
  /redo            Re-apply the last undone change
  /test            Auto-detect and run the project's test suite
  /pr <title>      Create a GitHub PR (requires gh CLI)
  /branch [name]   List or switch/create a git branch
  /stash [pop|list] git stash convenience wrapper
  /grep <pattern>  Run grep directly without involving the agent
  /budget [n]      Soft token-budget warning threshold (0 = off)
Anything else is sent to the agent as a task.

@-mentions: write @path/to/file.ext in your message to auto-attach a file.

Voice: hold the configured hotkey (default Ctrl+Alt+Space) at the prompt to speak.
"""


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="sexyjarvis",
        description="SexyJarvis — an OpenHands-style interactive terminal AI coding agent.",
    )
    p.add_argument("task", nargs="*", help="Optional initial task. If omitted, starts interactive mode.")
    p.add_argument("-m", "--model", help="Model id (Cursor or Anthropic depending on provider).")
    p.add_argument(
        "--provider",
        choices=["auto", "cursor", "anthropic", "local"],
        help="LLM provider: auto (Cursor → Claude → local), cursor, anthropic, or local.",
    )
    p.add_argument("--no-fallback", action="store_true", help="Do not fall back to Anthropic when Cursor quota is hit.")
    p.add_argument("-w", "--workspace", help="Workspace directory (default: cwd).")
    p.add_argument("--max-tokens", type=int, help="Max tokens per response.")
    p.add_argument("--max-retries", type=int, help="Max automatic retries on transient LLM errors.")
    p.add_argument("--max-iterations", type=int, help="Max agent loop turns per task.")
    p.add_argument("--yolo", action="store_true", help="Skip confirmation prompts for file/shell actions.")
    p.add_argument("--no-memory", action="store_true", help="Do not load CLAUDE.md/SEXYJARVIS.md instruction files.")
    p.add_argument("--no-color", action="store_true", help="Disable colored output.")
    p.add_argument("--no-voice", action="store_true", help="Disable spoken task-completion announcements.")
    p.add_argument("--no-speech", action="store_true", help="Disable push-to-talk speech input.")
    p.add_argument("--no-rtk", action="store_true", help="Disable RTK wrapping of shell commands.")
    p.add_argument("--no-codegraph", action="store_true", help="Disable CodeGraph tools.")
    p.add_argument("--allow-secrets", action="store_true", help="Disable the secret-scan write guard.")
    p.add_argument("--no-stream", action="store_true", help="Disable streaming assistant text.")
    p.add_argument("-v", "--version", action="version", version=f"SexyJarvis {__version__}")
    return p


def _rebuild_system(cfg, session, no_memory: bool) -> list[Path]:
    mem_text, loaded = ("", [])
    if not no_memory:
        mem_text, loaded = build_memory_section(cfg.workspace)
    session.system = build_system_prompt(
        cfg.workspace,
        mem_text,
        codegraph_enabled=cfg.codegraph_enabled,
        rtk_enabled=cfg.rtk_enabled,
        caveman_enabled=cfg.caveman_enabled,
    )
    return loaded


def _make_system(cfg, no_memory: bool, ui: UI) -> tuple[str, list[Path]]:
    mem_text, loaded = ("", [])
    if not no_memory:
        mem_text, loaded = build_memory_section(cfg.workspace)
    system = build_system_prompt(
        cfg.workspace,
        mem_text,
        codegraph_enabled=cfg.codegraph_enabled,
        rtk_enabled=cfg.rtk_enabled,
        caveman_enabled=cfg.caveman_enabled,
    )
    return system, loaded


def _read_user_input(ui: UI, voice) -> str:
    if voice and voice.settings.stt_enabled:
        return ui.voice_prompt(
            voice.settings.hotkey_display,
            voice.poll_speech,
        ).strip()
    return ui.prompt().strip()


def _probe_cursor(cfg) -> str | None:
    """Verify cursor-sdk bridge + API key before REPL starts."""
    try:
        from .cursor_backend import CursorRunner

        runner = CursorRunner(cfg, ui=None)  # type: ignore[arg-type]
        runner.start()
        runner.stop()
        return None
    except ImportError:
        return "cursor-sdk not installed. pip install -e \".[cursor]\" or rebuild binary with --with cursor."
    except Exception as exc:
        msg = str(exc).strip() or type(exc).__name__
        if "missing_api_key" in msg.lower() or "cursor_api_key" in msg.lower():
            return (
                "CURSOR_API_KEY missing or invalid. Set in %USERPROFILE%\\.sexyjarvis\\.env "
                "(Cursor Dashboard → API Keys)."
            )
        return f"Cursor connection failed: {msg}"


def _validate_provider_keys(cfg) -> str | None:
    provider = cfg.resolve_initial_provider()
    if provider == "cursor":
        if not cfg.has_cursor_key:
            return (
                "Cursor requires CURSOR_API_KEY in %USERPROFILE%\\.sexyjarvis\\.env "
                "(Cursor Dashboard → API Keys). IDE login ≠ terminal key."
            )
        err = _probe_cursor(cfg)
        if err:
            return err
        return None
    if provider == "anthropic" and not cfg.has_key:
        return "Anthropic provider requires ANTHROPIC_API_KEY in env or ~/.sexyjarvis/.env."
    if provider == "local":
        from .local_llm import probe_local_url

        if not (cfg.local_base_url or probe_local_url()):
            return "Local provider needs LM Studio/Ollama running or LM_STUDIO_URL set."
    if cfg.provider == "auto" and not cfg.has_cursor_key and not cfg.has_key and not cfg.has_local:
        return (
            "No LLM configured. Add CURSOR_API_KEY and/or ANTHROPIC_API_KEY to "
            "~/.sexyjarvis/.env, or start a local LLM (LM Studio/Ollama)."
        )
    return None


def _ensure_global_config_hint(ui: UI) -> None:
    global_dir = Path.home() / ".sexyjarvis"
    sample = Path(__file__).resolve().parent / "global_env.sample"
    target = global_dir / ".env"
    if target.exists() or not sample.exists():
        return
    try:
        global_dir.mkdir(parents=True, exist_ok=True)
        target.write_text(sample.read_text(encoding="utf-8"), encoding="utf-8")
        ui.info(f"Created starter config: {target}")
    except OSError:
        pass


def run_repl(cfg, no_memory: bool, ui: UI, initial_task: str | None, voice=None) -> int:
    err = _validate_provider_keys(cfg)
    if err:
        _ensure_global_config_hint(ui)
        ui.error(err)
        return 2

    system, loaded = _make_system(cfg, no_memory, ui)
    session = Session(system=system)

    on_complete = voice.announce_task_complete if voice else None

    agent = Agent(cfg, session, ui, on_task_complete=on_complete)

    if cfg.provider == "auto" and not cfg.has_cursor_key and cfg.active_provider == "anthropic":
        ui.info(
            "No CURSOR_API_KEY — on Claude API (not Cursor plan). "
            "Add key to %USERPROFILE%\\.sexyjarvis\\.env (Cursor Dashboard → API Keys)."
        )

    # MCP servers (if configured).
    from .mcp_client import MCPRegistry, load_mcp_config

    mcp_registry: MCPRegistry | None = None
    if load_mcp_config(cfg.workspace).get("servers"):
        with ui.status("Starting MCP servers..."):
            mcp_registry = MCPRegistry(cfg.workspace)
            started = mcp_registry.start_all()
        if started:
            agent.runner.mcp = mcp_registry
            tool_count = sum(len(s.tools or []) for s in mcp_registry.servers.values())
            ui.info(f"MCP: {', '.join(started)} ({tool_count} tool(s) available).")
        else:
            ui.error("MCP: no servers started successfully.")
            mcp_registry = None

    # File watcher: reload memory + ignore + hooks when relevant files change.
    from .watcher import FileWatcher

    def _on_files_changed(paths: set[str]) -> None:
        memory_changed = any(
            p.endswith(("SEXYJARVIS.md", ".sexyjarvis.md", "CLAUDE.md", "AGENTS.md", ".cursorrules"))
            for p in paths
        )
        if memory_changed:
            loaded = _rebuild_system(cfg, session, no_memory)
            ui.info(f"📝 Reloaded instructions ({len(loaded)} file(s)).")
        if any("ignore" in p for p in paths):
            agent.runner._ignore = None  # reset; lazy reload on next use
            ui.info("📝 Reloaded .sexyjarvisignore.")
        if any("hooks.json" in p for p in paths):
            ui.info("📝 Reloaded hooks.json.")
        if any("tools.json" in p for p in paths):
            ui.info("📝 Reloaded external tools.")
        if any(p.startswith(".sexyjarvis/commands/") for p in paths):
            ui.info("📝 Custom commands changed.")

    watcher = FileWatcher(cfg.workspace, _on_files_changed)
    watcher.start()

    if voice:
        voice.start()
        if voice.settings.tts_enabled or voice.settings.stt_enabled:
            bits = []
            if voice.settings.tts_enabled:
                bits.append("spoken completion on")
            if voice.settings.stt_enabled:
                bits.append(f"speech input on ({voice.settings.hotkey_display})")
            ui.info("Voice: " + ", ".join(bits))

    ui.banner(
        cfg.display_model(),
        str(cfg.workspace),
        [p.name for p in loaded],
        provider=cfg.active_provider or cfg.resolve_initial_provider(),
        fallback=cfg.fallback_enabled,
    )
    savings_bits = []
    if cfg.rtk_enabled:
        savings_bits.append(f"RTK {'on' if rtk_available() else 'on (rtk not in PATH)'}")
    if cfg.codegraph_enabled:
        savings_bits.append(f"CodeGraph: {codegraph_status(cfg.workspace)}")
    if savings_bits:
        ui.info("Token savings: " + ", ".join(savings_bits))

    pending = initial_task

    try:
        while True:
            try:
                if pending is not None:
                    user_input = pending
                    pending = None
                    ui.print(f"[bold green]you ›[/bold green] {user_input}")
                else:
                    user_input = _read_user_input(ui, voice)
            except (EOFError, KeyboardInterrupt):
                ui.print("\nBye.")
                return 0

            if not user_input:
                continue

            if user_input.startswith("/"):
                cmd, _, rest = user_input[1:].partition(" ")
                rest = rest.strip()
                if cmd in ("exit", "quit"):
                    ui.print("Bye.")
                    return 0
                if cmd == "help":
                    ui.print(HELP_TEXT)
                    continue
                if cmd in ("new", "clear"):
                    session.clear()
                    agent.llm.reset_cursor()
                    ui.info("Conversation cleared.")
                    continue
                if cmd == "model":
                    if rest == "list":
                        for m in [
                            "claude-opus-4-20250514",
                            "claude-opus-4-1-20250805",
                            "claude-sonnet-4-20250514",
                            "claude-sonnet-4-5-20250929",
                            "claude-haiku-4-5-20251001",
                            "claude-3-5-haiku-20241022",
                        ]:
                            marker = " *" if m == cfg.display_model() else ""
                            ui.print(f"  • {m}{marker}")
                    elif rest:
                        if agent.llm.uses_cursor_turns:
                            cfg.cursor_model = rest
                            agent.llm.reset_cursor()
                        else:
                            cfg.model = rest
                        ui.info(f"Model set to {rest}")
                    else:
                        ui.info(f"Current model: {cfg.display_model()}")
                    continue
                if cmd == "provider":
                    if rest in ("auto", "cursor", "anthropic", "local"):
                        cfg.provider = rest
                        cfg.active_provider = cfg.resolve_initial_provider()
                        agent.llm.active_provider = cfg.active_provider
                        agent.llm.stop()
                        err = _validate_provider_keys(cfg)
                        if err:
                            ui.error(err)
                        else:
                            ui.info(f"Provider set to {rest} (active: {cfg.active_provider}).")
                    else:
                        ui.info(
                            f"Provider mode: {cfg.provider} | active: {cfg.active_provider} "
                            f"| model: {cfg.display_model()}"
                        )
                    continue
                if cmd == "models":
                    models = agent.llm.list_cursor_models()
                    if models:
                        for mid in models:
                            ui.print(f"  • {mid}")
                    else:
                        ui.info("No Cursor models listed (need CURSOR_API_KEY + cursor-sdk).")
                    continue
                if cmd == "fallback":
                    if rest in ("off", "false", "0", "no"):
                        cfg.fallback_enabled = False
                        ui.info("Anthropic fallback disabled.")
                    elif rest in ("on", "true", "1", "yes"):
                        cfg.fallback_enabled = True
                        ui.info("Anthropic fallback enabled.")
                    else:
                        state = "on" if cfg.fallback_enabled else "off"
                        ui.info(f"Claude API fallback is {state} (model: {cfg.fallback_model}).")
                    continue
                if cmd == "memory":
                    loaded = _rebuild_system(cfg, session, no_memory)
                    if loaded:
                        ui.info("Loaded: " + ", ".join(str(p) for p in loaded))
                    else:
                        ui.info("No instruction files found.")
                    continue
                if cmd == "tools":
                    schemas = get_tool_schemas(cfg, mcp_registry=mcp_registry)
                    if rest in ("--schema", "schema", "json"):
                        import json as _json
                        ui.print(_json.dumps(schemas, indent=2))
                    else:
                        for t in schemas:
                            ui.print(f"  • {t['name']}: {t['description']}")
                    continue
                if cmd == "retries":
                    if rest.isdigit():
                        cfg.max_retries = int(rest)
                        ui.info(f"Max retries set to {cfg.max_retries}")
                    else:
                        ui.info(f"Max retries: {cfg.max_retries}")
                    continue
                if cmd == "confirm":
                    if rest in ("off", "false", "0", "no"):
                        cfg.confirm = False
                        ui.info("Confirmation disabled (yolo).")
                    elif rest in ("on", "true", "1", "yes"):
                        cfg.confirm = True
                        ui.info("Confirmation enabled.")
                    else:
                        ui.info(f"Confirmation is {'on' if cfg.confirm else 'off'}.")
                    continue
                if cmd == "save":
                    target = Path(rest or "sexyjarvis_session.json")
                    if not target.is_absolute():
                        target = cfg.workspace / target
                    session.save(target)
                    ui.info(f"Saved to {target}")
                    continue
                if cmd == "load":
                    if not rest:
                        ui.error("Usage: /load <file>")
                        continue
                    target = Path(rest)
                    if not target.is_absolute():
                        target = cfg.workspace / target
                    try:
                        loaded_sess = Session.load(target)
                        session.messages = loaded_sess.messages
                        if loaded_sess.system:
                            session.system = loaded_sess.system
                        ui.info(f"Loaded {len(session.messages)} messages from {target}")
                    except Exception as e:
                        ui.error(f"Could not load: {e}")
                    continue
                if cmd == "tokens":
                    ui.info(f"~{session.estimate_tokens():,} tokens in context (rough estimate).")
                    continue
                if cmd == "voice" and voice:
                    if rest in ("off", "false", "0", "no"):
                        voice.settings.tts_enabled = False
                        ui.info("Spoken completion disabled.")
                    elif rest in ("on", "true", "1", "yes"):
                        voice.settings.tts_enabled = True
                        ui.info("Spoken completion enabled.")
                    else:
                        ui.info(f"Spoken completion is {'on' if voice.settings.tts_enabled else 'off'}.")
                    continue
                if cmd == "speech" and voice:
                    if rest in ("off", "false", "0", "no"):
                        voice.settings.stt_enabled = False
                        voice.stop()
                        ui.info("Speech input disabled.")
                    elif rest in ("on", "true", "1", "yes"):
                        voice.settings.stt_enabled = True
                        voice.start()
                        ui.info(f"Speech input enabled ({voice.settings.hotkey_display}).")
                    else:
                        state = "on" if voice.settings.stt_enabled else "off"
                        ui.info(f"Speech input is {state}.")
                    continue
                if cmd == "hotkey" and voice:
                    ui.info(f"Push-to-talk hotkey: {voice.settings.hotkey_display}")
                    if voice.settings.voicetype_settings_path:
                        ui.info(f"VoiceType settings: {voice.settings.voicetype_settings_path}")
                    continue
                if cmd == "voicestyle":
                    if not voice:
                        ui.error("Voice unavailable. pip install edge-tts and ensure TTS is enabled.")
                        continue
                    from .voice.styles import current_voice_style, list_voice_styles

                    if not rest or rest == "list":
                        active = current_voice_style(voice.settings)
                        ui.info(f"Current: {active.label} ({active.id})")
                        for i, style in enumerate(list_voice_styles(), 1):
                            mark = " *" if style.id == active.id else ""
                            ui.print(
                                f"  {i}. {style.id:8}  {style.label}  "
                                f"— {style.voice}, {style.rate}, {style.pitch}{mark}"
                            )
                        ui.info("Switch: /voicestyle intimate | playful | bright")
                        continue
                    quiet = rest.endswith(" quiet")
                    name = rest[:-6].strip() if quiet else rest
                    try:
                        label = voice.apply_voice_style(name, preview=not quiet)
                    except ValueError as exc:
                        ui.error(str(exc))
                        continue
                    ui.info(f"Voice style: {label}")
                    continue
                if cmd == "rtk":
                    if rest in ("off", "false", "0", "no"):
                        cfg.rtk_enabled = False
                        ui.info("RTK wrapping disabled.")
                    elif rest in ("on", "true", "1", "yes"):
                        cfg.rtk_enabled = True
                        ui.info(f"RTK wrapping enabled ({'rtk found' if rtk_available() else 'install rtk for effect'}).")
                    else:
                        ui.info(f"RTK is {'on' if cfg.rtk_enabled else 'off'} ({'installed' if rtk_available() else 'not in PATH'}).")
                    _rebuild_system(cfg, session, no_memory)
                    continue
                if cmd == "caveman":
                    if rest in ("off", "false", "0", "no"):
                        cfg.caveman_enabled = False
                        ui.info("Caveman mode disabled — normal prose.")
                    elif rest in ("on", "true", "1", "yes"):
                        cfg.caveman_enabled = True
                        ui.info("Caveman mode enabled — terse output.")
                    else:
                        ui.info(f"Caveman mode is {'on' if cfg.caveman_enabled else 'off'}.")
                    _rebuild_system(cfg, session, no_memory)
                    continue
                if cmd == "verbose":
                    if rest in ("off", "false", "0", "no"):
                        cfg.verbose_tools = False
                        ui.verbose = False
                        ui.info("Verbose tool output disabled — simple status lines.")
                    elif rest in ("on", "true", "1", "yes"):
                        cfg.verbose_tools = True
                        ui.verbose = True
                        ui.info("Verbose tool output enabled.")
                    else:
                        ui.info(f"Verbose tool output is {'on' if cfg.verbose_tools else 'off'}.")
                    continue
                if cmd == "codegraph":
                    if rest in ("off", "false", "0", "no"):
                        cfg.codegraph_enabled = False
                        ui.info("CodeGraph tools disabled.")
                    elif rest in ("on", "true", "1", "yes"):
                        cfg.codegraph_enabled = True
                        ui.info(f"CodeGraph tools enabled ({codegraph_status(cfg.workspace)}).")
                    else:
                        ui.info(f"CodeGraph: {codegraph_status(cfg.workspace)} ({'tools on' if cfg.codegraph_enabled else 'tools off'}).")
                    _rebuild_system(cfg, session, no_memory)
                    continue
                if cmd == "cost":
                    ui.print(format_cost_report(cfg.display_model(), session))
                    continue
                if cmd == "compact":
                    with ui.status("Compacting conversation..."):
                        ok, msg = compact_session(session, agent.llm)
                    (ui.info if ok else ui.error)(msg)
                    continue
                if cmd == "init":
                    overwrite = rest.lower() in ("force", "overwrite", "--force", "-f")
                    path, created, msg = generate_sexyjarvis_md(cfg.workspace, overwrite=overwrite)
                    (ui.info if created else ui.error)(msg)
                    if created:
                        loaded = _rebuild_system(cfg, session, no_memory)
                        ui.info(f"Reloaded instructions: {', '.join(p.name for p in loaded)}")
                    continue
                if cmd == "undo":
                    result = agent.runner.run("undo_last", {})
                    (ui.error if result.is_error else ui.info)(result.content)
                    if result.diff:
                        ui.show_diff(result.diff)
                    continue
                if cmd == "plan":
                    if rest in ("on", "true", "1", "yes"):
                        cfg.plan_mode = True
                        ui.info("Plan mode enabled — writes & shell blocked.")
                    elif rest in ("off", "false", "0", "no"):
                        cfg.plan_mode = False
                        ui.info("Plan mode disabled.")
                    else:
                        ui.info(f"Plan mode is {'on' if cfg.plan_mode else 'off'}.")
                    continue
                if cmd == "diff":
                    staged = rest.lower() == "staged"
                    ok, out = git_diff(cfg.workspace, staged=staged)
                    if not ok:
                        ui.error(out)
                    elif not out.strip():
                        ui.info("(no changes)")
                    else:
                        ui.show_diff(out)
                    continue
                if cmd == "commit":
                    if not rest:
                        ui.error("Usage: /commit <message>")
                        continue
                    import subprocess as _sp
                    try:
                        _sp.run(["git", "add", "-A"], cwd=str(cfg.workspace), check=True, capture_output=True)
                        proc = _sp.run(
                            ["git", "commit", "-m", rest],
                            cwd=str(cfg.workspace),
                            capture_output=True,
                            text=True,
                        )
                        out = (proc.stdout or "") + (proc.stderr or "")
                        if proc.returncode == 0:
                            ui.success(out.strip() or f"Committed: {rest}")
                        else:
                            ui.error(out.strip() or "git commit failed")
                    except Exception as exc:
                        ui.error(f"Commit failed: {exc}")
                    continue
                if cmd == "history":
                    items = list_history(cfg.workspace)
                    if not items:
                        ui.info("(no archived sessions)")
                    else:
                        for p, n, first in items[:20]:
                            ui.print(f"  {p.name}  ({n} msgs)  {first}")
                    continue
                if cmd == "resume":
                    ap = autosave_path(cfg.workspace)
                    if not ap.is_file():
                        ui.error("No autosave found.")
                        continue
                    try:
                        loaded_sess = Session.load(ap)
                        session.messages = loaded_sess.messages
                        if loaded_sess.system:
                            session.system = loaded_sess.system
                        ui.info(f"Resumed {len(session.messages)} messages from {ap}")
                    except Exception as exc:
                        ui.error(f"Resume failed: {exc}")
                    continue
                if cmd == "commands":
                    customs = discover_custom_commands(cfg.workspace)
                    if not customs:
                        ui.info("No user commands. Add .md files under .sexyjarvis/commands/.")
                    else:
                        for name, c in sorted(customs.items()):
                            ui.print(f"  /{name}  — {c.path}")
                    continue
                if cmd == "retry":
                    last = retry_last_user_message(session)
                    if last is None:
                        ui.error("No prior user message to retry.")
                    else:
                        pending = last
                    continue
                if cmd == "export":
                    target = Path(rest or f"sexyjarvis_session_{int(__import__('time').time())}.md")
                    if not target.is_absolute():
                        target = cfg.workspace / target
                    export_markdown(session, target)
                    ui.info(f"Exported transcript to {target}")
                    continue
                if cmd == "bash":
                    hist = agent.runner.bash_history
                    if rest.isdigit():
                        idx = int(rest)
                        if not (1 <= idx <= len(hist)):
                            ui.error(f"Invalid index {idx} (have {len(hist)} entries).")
                        else:
                            cmd_text = hist[idx - 1]["cmd"]
                            ui.info(f"Re-running: {cmd_text}")
                            res = agent.runner.run("execute_bash", {"command": cmd_text})
                            (ui.error if res.is_error else ui.print)(res.content)
                    elif not hist:
                        ui.info("(no shell commands run yet)")
                    else:
                        for i, h in enumerate(hist[-30:], start=max(1, len(hist) - 29)):
                            tag = "ok " if h["exit_code"] == 0 else "ERR"
                            ui.print(f"  {i:>3}. [{tag}] {h['cmd'][:140]}")
                    continue
                if cmd == "context":
                    ui.rule("system prompt")
                    ui.print(session.system or "(empty)")
                    ui.rule("end")
                    ui.info(f"~{len(session.system):,} chars (~{len(session.system)//4:,} tokens)")
                    continue
                if cmd == "redo":
                    ok, msg = agent.runner.redo_last()
                    (ui.info if ok else ui.error)(msg)
                    continue
                if cmd == "test":
                    detected = detect_test_command(cfg.workspace)
                    if not detected:
                        ui.error("No test runner detected (looked for pytest, npm, cargo, go).")
                        continue
                    ui.info(f"Running: {detected}")
                    with ui.status("Running tests..."):
                        code, used, output = run_tests(cfg.workspace)
                    (ui.success if code == 0 else ui.error)(
                        f"exit={code}" + ("  (all tests passed)" if code == 0 else "")
                    )
                    ui.print(output)
                    continue
                if cmd == "pr":
                    if not rest:
                        ui.error("Usage: /pr <title>")
                        continue
                    body = "Created via SexyJarvis."
                    ui.info(f"Creating PR: {rest}")
                    code, output = gh_pr_create(cfg.workspace, rest, body)
                    (ui.success if code == 0 else ui.error)(output or f"exit={code}")
                    continue
                if cmd == "branch":
                    ok, out = git_branch(cfg.workspace, rest.strip())
                    (ui.info if ok else ui.error)(out or "(no output)")
                    continue
                if cmd == "stash":
                    parts = rest.split(None, 1)
                    action = parts[0] if parts else "push"
                    message = parts[1] if len(parts) > 1 else ""
                    ok, out = git_stash(cfg.workspace, action=action, message=message)
                    (ui.info if ok else ui.error)(out or "(no output)")
                    continue
                if cmd == "grep":
                    if not rest:
                        ui.error("Usage: /grep <regex>")
                        continue
                    res = agent.runner.run("grep", {"pattern": rest})
                    (ui.error if res.is_error else ui.print)(res.content)
                    continue
                if cmd == "find":
                    if not rest:
                        ui.error("Usage: /find <regex>")
                        continue
                    res = agent.runner.run("grep", {"pattern": rest})
                    if res.is_error or not res.content.strip() or res.content == "(no matches)":
                        ui.info("(no matches)")
                        continue
                    lines = res.content.splitlines()[:30]
                    for i, ln in enumerate(lines, 1):
                        ui.print(f"  {i:>2}. {ln}")
                    try:
                        pick = ui._raw_prompt("open which? (number, blank to cancel) › ").strip()
                    except (EOFError, KeyboardInterrupt):
                        continue
                    if not pick.isdigit() or not (1 <= int(pick) <= len(lines)):
                        continue
                    target_line = lines[int(pick) - 1]
                    # Format "path:lineno: text"
                    parts = target_line.split(":", 2)
                    if len(parts) >= 2 and parts[1].isdigit():
                        fpath, lineno = parts[0], int(parts[1])
                        start = max(1, lineno - 5)
                        end = lineno + 10
                        rres = agent.runner.run(
                            "read_file",
                            {"path": fpath, "start_line": start, "end_line": end},
                        )
                        ui.tool_result(f"{fpath}:{lineno}", rres.content, rres.is_error, lang=rres.lang)
                    continue
                if cmd == "stats":
                    from .telemetry import summary as _tele_summary
                    if rest in ("on", "true", "1", "yes"):
                        cfg.telemetry = True
                        ui.info("Telemetry enabled (local-only, .sexyjarvis/telemetry.jsonl).")
                    elif rest in ("off", "false", "0", "no"):
                        cfg.telemetry = False
                        ui.info("Telemetry disabled.")
                    else:
                        ui.print(_tele_summary(cfg.workspace))
                    continue
                if cmd == "sandbox":
                    if rest in ("off", "none", "false", "0", ""):
                        if not rest:
                            ui.info(f"Sandbox: {cfg.sandbox or 'off'}")
                        else:
                            cfg.sandbox = ""
                            ui.info("Sandbox disabled.")
                    elif rest.startswith("docker:"):
                        cfg.sandbox = rest
                        ui.info(f"Sandbox set to {rest} — execute_bash will run inside docker.")
                    else:
                        ui.error("Usage: /sandbox docker:<image> | off")
                    continue
                if cmd == "secrets":
                    if rest in ("on", "true", "1", "yes"):
                        cfg.secret_scan = True
                        ui.info("Secret scanning enabled.")
                    elif rest in ("off", "false", "0", "no"):
                        cfg.secret_scan = False
                        ui.info("Secret scanning disabled.")
                    else:
                        ui.info(f"Secret scan is {'on' if cfg.secret_scan else 'off'}.")
                    continue
                if cmd == "budget":
                    if rest.isdigit():
                        cfg.token_budget = int(rest)
                        ui.info(f"Token budget set to {cfg.token_budget:,} (0 = off).")
                    elif rest in ("off", "0", "false"):
                        cfg.token_budget = 0
                        ui.info("Token budget disabled.")
                    else:
                        used = session.input_tokens + session.output_tokens
                        if cfg.token_budget:
                            ui.info(
                                f"Budget: {used:,} / {cfg.token_budget:,} tokens "
                                f"({100 * used / cfg.token_budget:.0f}% used)."
                            )
                        else:
                            ui.info(f"Budget off. Used so far: {used:,} tokens.")
                    continue
                # Custom user-defined command?
                customs = discover_custom_commands(cfg.workspace)
                if cmd in customs:
                    user_input = customs[cmd].render(rest)
                    ui.info(f"Running custom command /{cmd}")
                    # Fall through to agent.run_turn by setting pending and re-entering
                    pending = user_input
                    continue
                import difflib as _difflib
                known = [
                    "help", "exit", "quit", "new", "clear", "model", "provider",
                    "models", "fallback", "memory", "tools", "retries", "confirm",
                    "save", "load", "tokens", "voice", "voicestyle", "speech", "hotkey", "rtk",
                    "caveman", "verbose", "codegraph", "cost", "compact", "init", "undo", "plan", "diff",
                    "commit", "history", "resume", "commands", "retry", "export",
                    "bash", "context", "redo", "test", "pr",
                    "branch", "stash", "grep", "budget", "find", "secrets",
                    "stats", "sandbox",
                ]
                known.extend(customs.keys())
                suggestion = _difflib.get_close_matches(cmd, known, n=1, cutoff=0.6)
                hint = f" Did you mean /{suggestion[0]}?" if suggestion else ""
                ui.error(f"Unknown command: /{cmd}.{hint} Type /help.")
                continue

            # Expand @file mentions before sending.
            user_input, attached = expand_mentions(user_input, cfg.workspace)
            if attached:
                ui.info(f"Attached {len(attached)} file(s): " + ", ".join(p.name for p in attached))

            try:
                session.turns += 1
                agent.run_turn(user_input)
                # Autosave session after each turn.
                try:
                    session.save(autosave_path(cfg.workspace))
                except Exception:
                    pass
                # Token budget warning.
                if cfg.token_budget:
                    used = session.input_tokens + session.output_tokens
                    if used >= cfg.token_budget:
                        ui.error(
                            f"⚠ token budget reached: {used:,} / {cfg.token_budget:,}. "
                            "Run /compact to summarize, /budget 0 to disable."
                        )
            except KeyboardInterrupt:
                if session.cleanup_incomplete_turn():
                    ui.print("\n[interrupted] Turn cancelled (incomplete tool call removed).")
                else:
                    ui.print("\n[interrupted] Turn cancelled. Returning to prompt.")
                continue
            except Exception as e:  # noqa: BLE001
                ui.error(f"Unexpected error: {e}")
                continue
    finally:
        try:
            try:
                archive_to_history(cfg.workspace, session)
            except Exception:
                pass
            try:
                watcher.stop()
            except Exception:
                pass
            try:
                if mcp_registry is not None:
                    mcp_registry.stop_all()
            except Exception:
                pass
            try:
                agent.llm.stop()
            except (KeyboardInterrupt, Exception):
                pass
            if voice:
                try:
                    voice.stop()
                except Exception:
                    pass
        except KeyboardInterrupt:
            pass


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    overrides = {
        "model": args.model,
        "max_tokens": args.max_tokens,
        "max_retries": args.max_retries,
        "max_iterations": args.max_iterations,
        "confirm": (False if args.yolo else None),
        "provider": args.provider,
        "fallback_enabled": (False if args.no_fallback else None),
        "rtk_enabled": (False if args.no_rtk else None),
        "codegraph_enabled": (False if args.no_codegraph else None),
    }
    cfg = load_config(workspace=args.workspace, overrides=overrides)
    if args.allow_secrets:
        cfg.secret_scan = False
    if args.no_stream:
        cfg.stream = False

    if args.model:
        if cfg.active_provider == "cursor":
            cfg.cursor_model = args.model
        else:
            cfg.model = args.model

    ui = UI(color=not args.no_color, theme=cfg.theme, verbose=cfg.verbose_tools)

    voice_overrides = {
        "tts_enabled": False if args.no_voice else None,
        "stt_enabled": False if args.no_speech else None,
    }
    try:
        from .voice import VoiceStack

        voice = VoiceStack.try_create(
            workspace=cfg.workspace,
            overrides=voice_overrides,
            on_info=ui.info,
            on_error=ui.error,
        )
    except Exception as exc:  # noqa: BLE001
        ui.error(f"Voice features unavailable: {exc}")
        voice = None

    initial_task = " ".join(args.task).strip() or None
    try:
        return run_repl(cfg, args.no_memory, ui, initial_task, voice=voice)
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
