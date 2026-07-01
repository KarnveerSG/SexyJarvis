"""Tool definitions and execution for the agent.

Each tool has:
  - a JSON schema (the Anthropic `tools` format) exposed via TOOL_SCHEMAS
  - an executor in ToolRunner that returns a string result

Tools mirror the OpenHands CLI capability set: shell, file read/write/edit,
directory listing, glob, grep, plus a `finish` sentinel.
"""

from __future__ import annotations

import difflib
import fnmatch
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from .config import Config
from .tool_types import ToolResult
from .codegraph_tools import CODEGRAPH_TOOL_SCHEMAS, CodeGraphRunner
from .bash_jobs import job_output as _job_output, job_status as _job_status, start_job as _start_job
from .external_tools import external_tool_schemas, run_external_tool
from .hooks import run_hook
from .ignore import IgnoreMatcher
from .rtk import wrap_with_rtk
from .secrets import scan as _secret_scan
from .telemetry import record as _tele_record

# Image extensions handled by read_file (returned as a description; the agent
# can request the bytes if needed). Full multimodal block support requires
# passing structured content to the LLM, which we expose via the
# `image_attachments` list on Session.
_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}

# Tools that change the filesystem or run commands — gated by confirm mode.
DESTRUCTIVE_TOOLS = {"execute_bash", "write_file", "edit_file", "multi_edit", "apply_patch"}

# Dangerous shell patterns — always require confirmation, even with --yolo.
DANGEROUS_BASH_PATTERNS = [
    re.compile(r"\brm\s+(-[rRfF]+\s+)*/\s*(?:$|\s)"),    # rm -rf /
    re.compile(r"\brm\s+-[rRfF]+\s+~"),                   # rm -rf ~
    re.compile(r"\bmkfs\."),                              # mkfs
    re.compile(r"\bdd\s+.*\bof=/dev/"),                  # dd of=/dev/sdX
    re.compile(r":\(\)\s*\{.*\|.*&.*\}\s*;"),            # fork bomb
    re.compile(r"\b(shutdown|reboot|halt|poweroff)\b"),
    re.compile(r"\bformat\s+[a-zA-Z]:"),                  # windows format c:
    re.compile(r">\s*/dev/sd[a-z]"),
]


def is_dangerous_command(cmd: str) -> bool:
    """Return True if the command looks high-risk and must be confirmed."""
    return any(p.search(cmd) for p in DANGEROUS_BASH_PATTERNS)

_BASE_TOOL_SCHEMAS: list[dict] = [
    {
        "name": "execute_bash",
        "description": (
            "Run a shell command in the workspace and return its stdout/stderr and exit code. "
            "Use for building, running, testing, installing, and general shell tasks. "
            "Commands run non-interactively with a timeout."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "The shell command to execute."},
                "timeout": {"type": "integer", "description": "Optional timeout in seconds."},
            },
            "required": ["command"],
        },
    },
    {
        "name": "read_file",
        "description": "Read the contents of a text file. Optionally restrict to a line range.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path (relative to workspace or absolute)."},
                "start_line": {"type": "integer", "description": "1-based first line to read (optional)."},
                "end_line": {"type": "integer", "description": "1-based last line to read (optional)."},
            },
            "required": ["path"],
        },
    },
    {
        "name": "write_file",
        "description": "Create a new file or overwrite an existing file with the given content.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path to write."},
                "content": {"type": "string", "description": "Full file content."},
            },
            "required": ["path", "content"],
        },
    },
    {
        "name": "edit_file",
        "description": (
            "Replace an exact substring in a file with new text. The old_string must occur "
            "exactly once in the file. Use this for targeted edits."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "old_string": {"type": "string", "description": "Exact text to replace (must be unique)."},
                "new_string": {"type": "string", "description": "Replacement text."},
            },
            "required": ["path", "old_string", "new_string"],
        },
    },
    {
        "name": "list_dir",
        "description": "List the entries of a directory (non-recursive).",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Directory path. Defaults to workspace root."},
            },
        },
    },
    {
        "name": "glob",
        "description": "Find files matching a glob pattern recursively (e.g. '**/*.py').",
        "input_schema": {
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "Glob pattern, e.g. **/*.js"},
            },
            "required": ["pattern"],
        },
    },
    {
        "name": "grep",
        "description": "Search file contents for a regular expression and return matching lines.",
        "input_schema": {
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "Regular expression to search for."},
                "path": {"type": "string", "description": "Directory or file to search. Defaults to workspace."},
                "glob": {"type": "string", "description": "Optional file glob filter, e.g. *.py"},
            },
            "required": ["pattern"],
        },
    },
    {
        "name": "multi_edit",
        "description": (
            "Apply multiple find/replace edits to a single file in one atomic call. "
            "Each edit must specify a unique old_string. Use this when making several "
            "related changes to the same file."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path to edit."},
                "edits": {
                    "type": "array",
                    "description": "List of {old_string, new_string} edits applied in order.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "old_string": {"type": "string"},
                            "new_string": {"type": "string"},
                            "replace_all": {"type": "boolean", "description": "Replace all occurrences (default false)."},
                        },
                        "required": ["old_string", "new_string"],
                    },
                },
            },
            "required": ["path", "edits"],
        },
    },
    {
        "name": "web_fetch",
        "description": (
            "Fetch a URL (http/https) and return its text content. HTML is stripped of "
            "scripts/styles and reduced to readable text. Use for docs lookups, "
            "reading a gist, fetching an example. Not for binary or huge pages."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "http(s) URL to fetch."},
                "max_chars": {"type": "integer", "description": "Max characters to return (default 20000)."},
            },
            "required": ["url"],
        },
    },
    {
        "name": "task_track",
        "description": (
            "Maintain a lightweight in-session todo list for the current task. "
            "Use action='add' to add items, 'update' to mark items done/in_progress, "
            "'list' to show current state. Helps keep multi-step work organized."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["add", "update", "list", "clear"]},
                "items": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "For add: list of task descriptions.",
                },
                "index": {"type": "integer", "description": "For update: 1-based task index."},
                "status": {
                    "type": "string",
                    "enum": ["pending", "in_progress", "done"],
                    "description": "For update: new status.",
                },
            },
            "required": ["action"],
        },
    },
    {
        "name": "undo_last",
        "description": (
            "Revert the last file write or edit performed by the agent in this session. "
            "Only undoes one step. Use sparingly to recover from a bad edit."
        ),
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "spawn_agent",
        "description": (
            "Run a focused sub-agent on a self-contained question and return its "
            "final answer. The sub-agent has read-only tools (read_file, list_dir, "
            "glob, grep, code_search). Use for parallel research without polluting "
            "the main context."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "prompt": {"type": "string", "description": "Self-contained task for the sub-agent."},
                "max_iterations": {"type": "integer", "description": "Iteration cap (default 12)."},
            },
            "required": ["prompt"],
        },
    },
    {
        "name": "execute_bash_async",
        "description": (
            "Start a long-running shell command in the background and return a job_id "
            "immediately. Use for dev servers, watchers, or anything that would block "
            "execute_bash beyond its timeout. Poll with bash_job_status / bash_job_output."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "command": {"type": "string"},
            },
            "required": ["command"],
        },
    },
    {
        "name": "bash_job_status",
        "description": "Check the running state of a background bash job by id.",
        "input_schema": {
            "type": "object",
            "properties": {"job_id": {"type": "string"}},
            "required": ["job_id"],
        },
    },
    {
        "name": "bash_job_output",
        "description": "Read stdout+stderr accumulated by a background bash job.",
        "input_schema": {
            "type": "object",
            "properties": {
                "job_id": {"type": "string"},
                "max_chars": {"type": "integer"},
            },
            "required": ["job_id"],
        },
    },
    {
        "name": "apply_patch",
        "description": (
            "Apply a unified diff (one or more files) to the workspace via `git apply`. "
            "The patch should reference paths relative to the workspace root. "
            "Fails if any hunk does not apply cleanly. Use when you have a precise diff "
            "rather than calling edit_file multiple times."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "patch": {"type": "string", "description": "Unified diff text."},
            },
            "required": ["patch"],
        },
    },
    {
        "name": "wait_for_file",
        "description": (
            "Block (up to `timeout` seconds) until a file exists or its mtime is "
            "newer than `since` (unix timestamp). Useful after kicking off a build "
            "or test that writes a result file."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path to watch."},
                "timeout": {"type": "integer", "description": "Max seconds to wait (default 30)."},
                "since": {"type": "number", "description": "Only return if mtime > this unix ts."},
            },
            "required": ["path"],
        },
    },
    {
        "name": "code_search",
        "description": (
            "AST-based search for Python function or class definitions matching a name. "
            "Returns file paths, line numbers, and signatures. Faster and more precise than "
            "grep for 'where is symbol X defined' questions."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Symbol name (exact match) or regex."},
                "kind": {"type": "string", "enum": ["function", "class", "any"], "description": "Optional kind filter (default: any)."},
            },
            "required": ["name"],
        },
    },
    {
        "name": "finish",
        "description": "Signal that the user's task is complete. Provide a short summary of what was done.",
        "input_schema": {
            "type": "object",
            "properties": {
                "summary": {"type": "string", "description": "Summary of the work completed."},
            },
            "required": ["summary"],
        },
    },
]

# Back-compat default (codegraph off).
TOOL_SCHEMAS: list[dict] = list(_BASE_TOOL_SCHEMAS)


def get_tool_schemas(config: Config, mcp_registry=None) -> list[dict]:
    """Return tool schemas: built-ins + CodeGraph + external + MCP."""
    schemas = list(_BASE_TOOL_SCHEMAS)
    if config.codegraph_enabled:
        schemas += CODEGRAPH_TOOL_SCHEMAS
    schemas += external_tool_schemas(config.workspace)
    if mcp_registry is not None:
        schemas += mcp_registry.tool_schemas()
    return schemas

# Directories we never descend into for glob/grep.
_IGNORE_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", ".mypy_cache", "dist", "build"}


class ToolRunner:
    """Executes tool calls against the workspace."""

    def __init__(self, config: Config):
        self.config = config
        self.workspace = config.workspace
        self._codegraph = CodeGraphRunner(config.workspace) if config.codegraph_enabled else None
        # (path, prior_text_or_None_if_did_not_exist) — capped history for /undo.
        self._undo_stack: list[tuple[Path, str | None]] = []
        self._redo_stack: list[tuple[Path, str | None]] = []
        self._undo_limit = 20
        # In-session task tracker (list of {"text": str, "status": str}).
        self._tasks: list[dict] = []
        # Bash history: list of {"cmd": str, "exit_code": int, "ts": float}.
        self.bash_history: list[dict] = []
        # Ignore matcher (loaded lazily on first use).
        self._ignore: IgnoreMatcher | None = None
        # MCP registry, attached by the CLI after start_all().
        self.mcp = None

    def preview(self, name: str, args: dict) -> str | None:
        """Return a diff/preview string for a destructive call, or None."""
        try:
            if name == "write_file":
                path = self._resolve(args["path"])
                new = args.get("content", "")
                old = path.read_text(encoding="utf-8", errors="replace") if path.is_file() else ""
                return self._unified_diff(old, new, path)
            if name == "edit_file":
                path = self._resolve(args["path"])
                if not path.is_file():
                    return None
                old = path.read_text(encoding="utf-8", errors="replace")
                if args.get("old_string") not in old:
                    return None
                new = old.replace(args["old_string"], args.get("new_string", ""), 1)
                return self._unified_diff(old, new, path)
            if name == "multi_edit":
                path = self._resolve(args["path"])
                if not path.is_file():
                    return None
                old = path.read_text(encoding="utf-8", errors="replace")
                text = old
                for ed in args.get("edits") or []:
                    o = ed.get("old_string", "")
                    n = ed.get("new_string", "")
                    if not o or o not in text:
                        return None
                    text = text.replace(o, n) if ed.get("replace_all") else text.replace(o, n, 1)
                return self._unified_diff(old, text, path)
            if name == "apply_patch":
                return args.get("patch", "")
        except Exception:
            return None
        return None

    def _ignore_matcher(self) -> IgnoreMatcher:
        if self._ignore is None:
            self._ignore = IgnoreMatcher(self.workspace)
        return self._ignore

    def _push_undo(self, path: Path, prior: str | None) -> None:
        self._undo_stack.append((path, prior))
        if len(self._undo_stack) > self._undo_limit:
            self._undo_stack.pop(0)
        # A fresh write invalidates the redo stack.
        self._redo_stack.clear()

    def undo_last(self) -> tuple[bool, str]:
        if not self._undo_stack:
            return False, "Nothing to undo."
        # Skip any turn sentinels at the top.
        while self._undo_stack and self._undo_stack[-1][0] is None:
            self._undo_stack.pop()
        if not self._undo_stack:
            return False, "Nothing to undo."
        path, prior = self._undo_stack.pop()
        current = path.read_text(encoding="utf-8", errors="replace") if path.is_file() else None
        self._redo_stack.append((path, current))
        try:
            if prior is None:
                if path.is_file():
                    path.unlink()
                return True, f"Reverted creation of {path}."
            path.write_text(prior, encoding="utf-8")
            return True, f"Reverted last change to {path}."
        except Exception as exc:
            return False, f"Undo failed: {exc}"

    def mark_turn(self) -> None:
        """Insert a sentinel so undo_turn() can revert an entire turn."""
        # None-path entries are turn boundaries.
        self._undo_stack.append((None, None))
        if len(self._undo_stack) > self._undo_limit:
            self._undo_stack.pop(0)

    def undo_turn(self) -> tuple[bool, str, int]:
        """Revert every edit above the most recent turn sentinel.

        Returns (ok, message, files_reverted).
        """
        # Drop any trailing sentinels first (empty turn at top).
        while self._undo_stack and self._undo_stack[-1][0] is None:
            self._undo_stack.pop()
        if not self._undo_stack:
            return False, "Nothing to undo.", 0
        reverted = 0
        errors: list[str] = []
        while self._undo_stack:
            path, prior = self._undo_stack[-1]
            if path is None:
                self._undo_stack.pop()
                break
            self._undo_stack.pop()
            current = path.read_text(encoding="utf-8", errors="replace") if path.is_file() else None
            self._redo_stack.append((path, current))
            try:
                if prior is None:
                    if path.is_file():
                        path.unlink()
                else:
                    path.write_text(prior, encoding="utf-8")
                reverted += 1
            except Exception as exc:
                errors.append(f"{path}: {exc}")
        if errors:
            return False, "Undo turn had errors: " + "; ".join(errors), reverted
        return True, f"Reverted {reverted} file change(s) from the last turn.", reverted

    def redo_last(self) -> tuple[bool, str]:
        if not self._redo_stack:
            return False, "Nothing to redo."
        path, after = self._redo_stack.pop()
        prior = path.read_text(encoding="utf-8", errors="replace") if path.is_file() else None
        self._undo_stack.append((path, prior))
        try:
            if after is None:
                if path.is_file():
                    path.unlink()
                return True, f"Re-applied deletion of {path}."
            path.write_text(after, encoding="utf-8")
            return True, f"Re-applied change to {path}."
        except Exception as exc:
            return False, f"Redo failed: {exc}"

    # ---- path helpers -------------------------------------------------
    def _resolve(self, path: str) -> Path:
        p = Path(path)
        if not p.is_absolute():
            p = self.workspace / p
        return p

    def _emit_quill_edit(self, path: Path) -> None:
        if not os.environ.get("QUILL_DESKTOP"):
            return
        try:
            target = path.relative_to(self.workspace).as_posix()
        except ValueError:
            target = str(path)
        print(f"[QUILL_EDIT:{target}]", file=sys.stderr, flush=True)

    def _emit_quill_tool(self, name: str, detail: str = "") -> None:
        if not os.environ.get("QUILL_DESKTOP"):
            return
        safe = str(detail or "").replace("\n", " ").replace(":", " ")[:160]
        print(f"[QUILL_TOOL:{name}:{safe}]", file=sys.stderr, flush=True)

    def _emit_quill_tasks(self) -> None:
        if not os.environ.get("QUILL_DESKTOP"):
            return
        import json
        payload = json.dumps(self._tasks, separators=(",", ":"))
        print(f"[QUILL_TASK:{payload}]", file=sys.stderr, flush=True)

    def _emit_task_start(self, task_id: str, title: str) -> None:
        if not os.environ.get("QUILL_DESKTOP"):
            return
        safe_title = str(title or "").replace("\n", " ").replace("]", "")[:200]
        print(f"[QUILL:TASK_START {task_id} {safe_title}]", file=sys.stderr, flush=True)

    def _emit_task_done(self, task_id: str) -> None:
        if not os.environ.get("QUILL_DESKTOP"):
            return
        print(f"[QUILL:TASK_DONE {task_id}]", file=sys.stderr, flush=True)

    def _emit_quill_browser(self, url: str) -> None:
        if not os.environ.get("QUILL_DESKTOP"):
            return
        safe = str(url or "").replace("\n", " ").strip()[:500]
        print(f"[QUILL_BROWSER:{safe}]", file=sys.stderr, flush=True)

    def _unified_diff(self, old: str, new: str, path: Path) -> str | None:
        if old == new:
            return None
        rel = path.relative_to(self.workspace) if path.is_relative_to(self.workspace) else path
        lines = difflib.unified_diff(
            old.splitlines(keepends=True),
            new.splitlines(keepends=True),
            fromfile=str(rel),
            tofile=str(rel),
        )
        return "".join(lines) or None

    def _is_ignored(self, path: Path) -> bool:
        if any(part in _IGNORE_DIRS for part in path.parts):
            return True
        return self._ignore_matcher().matches(path)

    # ---- dispatch -----------------------------------------------------
    def run(self, name: str, args: dict) -> ToolResult:
        detail = ""
        if isinstance(args, dict):
            detail = str(args.get("path") or args.get("file_path") or args.get("command") or "")[:160]
        self._emit_quill_tool(name, detail)
        # Pre-hook: a non-zero exit blocks the call.
        pre = run_hook("pre", name, args or {}, self.workspace)
        if pre is not None:
            code, output = pre
            if code != 0:
                return ToolResult(
                    f"[pre-hook for {name} blocked the call: exit={code}]\n{output}",
                    is_error=True,
                )

        if name.startswith("codegraph_"):
            if self._codegraph is None:
                result = ToolResult("CodeGraph tools are disabled.", is_error=True)
            else:
                result = self._codegraph.dispatch(name, args)
        elif name.startswith("ext_"):
            result = run_external_tool(name, args or {}, self.workspace, timeout=self.config.bash_timeout)
        elif name.startswith("mcp_"):
            if self.mcp is None:
                result = ToolResult("MCP is not initialized.", is_error=True)
            else:
                ok, content = self.mcp.call(name, args or {})
                result = ToolResult(content, is_error=not ok)
        else:
            handler = getattr(self, f"_tool_{name}", None)
            if handler is None:
                result = ToolResult(f"Unknown tool: {name}", is_error=True)
            else:
                try:
                    result = handler(args)
                except Exception as exc:  # noqa: BLE001
                    result = ToolResult(f"Tool '{name}' raised an error: {exc}", is_error=True)

        # Post-hook: appended to the tool result content, never blocks.
        post = run_hook("post", name, args or {}, self.workspace)
        if post is not None:
            code, output = post
            if output:
                result.content = (result.content or "") + f"\n[post-hook exit={code}]\n{output}"
        # Telemetry: local-only, opt-in.
        if getattr(self.config, "telemetry", False):
            _tele_record(self.workspace, {
                "kind": "tool_call",
                "name": name,
                "is_error": bool(result.is_error),
                "size": len(result.content or ""),
            })
        return result

    # ---- individual tools --------------------------------------------
    def _tool_execute_bash(self, args: dict) -> ToolResult:
        command = args.get("command", "")
        timeout = int(args.get("timeout") or self.config.bash_timeout)
        if not command.strip():
            return ToolResult("No command provided.", is_error=True)
        run_cmd = wrap_with_rtk(command, enabled=self.config.rtk_enabled)
        sandbox = getattr(self.config, "sandbox", "") or ""
        if sandbox.startswith("docker:"):
            image = sandbox.split(":", 1)[1].strip() or "alpine:latest"
            # Mount workspace at /work; escape with single quotes.
            inner = run_cmd.replace("'", "'\\''")
            run_cmd = (
                f"docker run --rm -v \"{self.workspace}\":/work -w /work "
                f"{image} sh -c '{inner}'"
            )
        try:
            proc = subprocess.run(
                run_cmd,
                shell=True,
                cwd=str(self.workspace),
                capture_output=True,
                text=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            return ToolResult(f"Command timed out after {timeout}s.", is_error=True)
        out = proc.stdout or ""
        err = proc.stderr or ""
        body = ""
        if out:
            body += out
        if err:
            body += ("\n[stderr]\n" if out else "") + err
        body = body.strip() or "(no output)"
        # Truncate very large output.
        if len(body) > 20000:
            body = body[:20000] + "\n[...output truncated...]"
        result = f"exit_code={proc.returncode}\n{body}"
        if run_cmd != command.strip():
            result = f"[rtk] {run_cmd}\n{result}"
        self.bash_history.append(
            {"cmd": command, "exit_code": proc.returncode, "ts": time.time()}
        )
        if len(self.bash_history) > 200:
            self.bash_history = self.bash_history[-200:]
        return ToolResult(result, is_error=proc.returncode != 0)

    def _tool_read_file(self, args: dict) -> ToolResult:
        path = self._resolve(args["path"])
        if not path.is_file():
            return ToolResult(f"File not found: {path}", is_error=True)
        if path.suffix.lower() in _IMAGE_EXTS:
            size = path.stat().st_size
            return ToolResult(
                f"[image] {path} ({size:,} bytes, {path.suffix[1:].lower()}). "
                "Use a multimodal-capable model to view it; "
                "read_file does not inline image bytes (size-prohibitive)."
            )
        text = path.read_text(encoding="utf-8", errors="replace")
        lines = text.splitlines()
        start = args.get("start_line")
        end = args.get("end_line")
        if start or end:
            s = max(1, int(start or 1))
            e = min(len(lines), int(end or len(lines)))
            chosen = lines[s - 1 : e]
            numbered = "\n".join(f"{i + s}\t{ln}" for i, ln in enumerate(chosen))
            return ToolResult(numbered or "(empty range)")
        if len(text) > 60000:
            text = text[:60000] + "\n[...truncated...]"
        ext = path.suffix.lower().lstrip(".")
        lang_map = {
            "py": "python", "js": "javascript", "ts": "typescript",
            "tsx": "tsx", "jsx": "jsx", "rs": "rust", "go": "go",
            "java": "java", "rb": "ruby", "sh": "bash", "md": "markdown",
            "html": "html", "css": "css", "json": "json", "yaml": "yaml",
            "yml": "yaml", "toml": "toml", "xml": "xml", "sql": "sql",
            "cs": "csharp", "cpp": "cpp", "c": "c", "h": "c",
        }
        return ToolResult(text, lang=lang_map.get(ext))

    def _tool_write_file(self, args: dict) -> ToolResult:
        path = self._resolve(args["path"])
        content = args.get("content", "")
        if self.config.secret_scan:
            findings = _secret_scan(content)
            if findings:
                items = "; ".join(f"{lbl} ({m})" for lbl, m in findings)
                return ToolResult(
                    f"Write blocked: content matches secret pattern(s): {items}. "
                    "Disable with /secrets off or set secret_scan=false in config.",
                    is_error=True,
                )
        existed = path.is_file()
        old = path.read_text(encoding="utf-8", errors="replace") if existed else ""
        self._push_undo(path, old if existed else None)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        self._emit_quill_edit(path)
        verb = "Overwrote" if existed else "Created"
        diff_note = ""
        if existed and old != content:
            diff_note = f" ({len(old.splitlines())} -> {len(content.splitlines())} lines)"
        diff = self._unified_diff(old, content, path)
        return ToolResult(f"{verb} {path}{diff_note}.", diff=diff)

    def _tool_edit_file(self, args: dict) -> ToolResult:
        path = self._resolve(args["path"])
        if not path.is_file():
            return ToolResult(f"File not found: {path}", is_error=True)
        old_string = args["old_string"]
        new_string = args["new_string"]
        text = path.read_text(encoding="utf-8", errors="replace")
        count = text.count(old_string)
        if count == 0:
            return ToolResult("old_string not found in file. Read the file and try again.", is_error=True)
        if count > 1:
            return ToolResult(
                f"old_string is not unique ({count} occurrences). Provide more surrounding context.",
                is_error=True,
            )
        new_text = text.replace(old_string, new_string, 1)
        self._push_undo(path, text)
        path.write_text(new_text, encoding="utf-8")
        self._emit_quill_edit(path)
        diff = self._unified_diff(text, new_text, path)
        return ToolResult(f"Edited {path}.", diff=diff)

    def _tool_multi_edit(self, args: dict) -> ToolResult:
        path = self._resolve(args["path"])
        if not path.is_file():
            return ToolResult(f"File not found: {path}", is_error=True)
        edits = args.get("edits") or []
        if not isinstance(edits, list) or not edits:
            return ToolResult("multi_edit requires a non-empty 'edits' list.", is_error=True)
        original = path.read_text(encoding="utf-8", errors="replace")
        text = original
        applied = 0
        for i, ed in enumerate(edits, 1):
            old_s = ed.get("old_string", "")
            new_s = ed.get("new_string", "")
            replace_all = bool(ed.get("replace_all"))
            if not old_s:
                return ToolResult(f"Edit #{i}: old_string is empty.", is_error=True)
            count = text.count(old_s)
            if count == 0:
                return ToolResult(
                    f"Edit #{i}: old_string not found (after previous edits). Aborted; file unchanged.",
                    is_error=True,
                )
            if count > 1 and not replace_all:
                return ToolResult(
                    f"Edit #{i}: old_string is not unique ({count} occurrences). "
                    "Set replace_all=true or provide more context.",
                    is_error=True,
                )
            text = text.replace(old_s, new_s) if replace_all else text.replace(old_s, new_s, 1)
            applied += 1
        if text == original:
            return ToolResult("multi_edit: no changes (input matched output).")
        if self.config.secret_scan:
            findings = _secret_scan(text)
            if findings:
                items = "; ".join(f"{lbl}" for lbl, _ in findings)
                return ToolResult(
                    f"multi_edit blocked: resulting file would contain secret pattern(s): {items}.",
                    is_error=True,
                )
        self._push_undo(path, original)
        path.write_text(text, encoding="utf-8")
        self._emit_quill_edit(path)
        diff = self._unified_diff(original, text, path)
        return ToolResult(f"Applied {applied} edits to {path}.", diff=diff)

    def _tool_web_fetch(self, args: dict) -> ToolResult:
        url = args.get("url", "").strip()
        max_chars = int(args.get("max_chars") or 20000)
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https"):
            return ToolResult("web_fetch only supports http/https URLs.", is_error=True)
        try:
            req = Request(url, headers={"User-Agent": "Quill/1.0 (+terminal-agent)"})
            with urlopen(req, timeout=20) as resp:
                ctype = resp.headers.get("Content-Type", "")
                raw = resp.read(2_000_000)
        except Exception as exc:
            return ToolResult(f"Fetch failed: {exc}", is_error=True)
        try:
            text = raw.decode("utf-8", errors="replace")
        except Exception:
            text = raw.decode("latin-1", errors="replace")
        if "html" in ctype.lower() or text.lstrip().lower().startswith("<!doctype html") or "<html" in text[:200].lower():
            text = _html_to_text(text)
        text = text.strip()
        if len(text) > max_chars:
            text = text[:max_chars] + "\n[...truncated...]"
        self._emit_quill_browser(url)
        header = f"[{url}] ({len(raw)} bytes, {ctype or 'unknown'})\n"
        return ToolResult(header + text)

    def _tool_task_track(self, args: dict) -> ToolResult:
        action = args.get("action", "list")
        if action == "add":
            items = args.get("items") or []
            if not items:
                return ToolResult("No items to add.", is_error=True)
            for it in items:
                self._tasks.append({"text": str(it), "status": "pending"})
                tid = str(len(self._tasks))
                self._emit_task_start(tid, str(it))
            self._emit_quill_tasks()
            return ToolResult(_render_tasks(self._tasks))
        if action == "update":
            idx = int(args.get("index", 0))
            status = args.get("status", "done")
            if not (1 <= idx <= len(self._tasks)):
                return ToolResult(f"Invalid index {idx} (have {len(self._tasks)} tasks).", is_error=True)
            self._tasks[idx - 1]["status"] = status
            if status == "done":
                self._emit_task_done(str(idx))
            self._emit_quill_tasks()
            return ToolResult(_render_tasks(self._tasks))
        if action == "clear":
            self._tasks = []
            self._emit_quill_tasks()
            return ToolResult("Task list cleared.")
        # list (default)
        if not self._tasks:
            return ToolResult("(no tasks)")
        self._emit_quill_tasks()
        return ToolResult(_render_tasks(self._tasks))

    def _tool_undo_last(self, _args: dict) -> ToolResult:
        ok, msg = self.undo_last()
        return ToolResult(msg, is_error=not ok)

    def _tool_list_dir(self, args: dict) -> ToolResult:
        path = self._resolve(args.get("path") or ".")
        if not path.is_dir():
            return ToolResult(f"Not a directory: {path}", is_error=True)
        entries = []
        for entry in sorted(path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
            suffix = "/" if entry.is_dir() else ""
            entries.append(entry.name + suffix)
        return ToolResult("\n".join(entries) or "(empty directory)")

    def _tool_glob(self, args: dict) -> ToolResult:
        pattern = args["pattern"]
        matches: list[str] = []
        for full in sorted(self.workspace.glob(pattern)):
            if not full.is_file() or self._is_ignored(full):
                continue
            rel = full.relative_to(self.workspace).as_posix()
            matches.append(rel)
            if len(matches) > 500:
                break
        if not matches:
            return ToolResult("(no matches)")
        return ToolResult("\n".join(matches[:500]))

    def _tool_grep(self, args: dict) -> ToolResult:
        pattern = args["pattern"]
        try:
            regex = re.compile(pattern)
        except re.error as e:
            return ToolResult(f"Invalid regex: {e}", is_error=True)
        glob_filter = args.get("glob")
        base = self._resolve(args.get("path") or ".")
        results: list[str] = []

        def search_file(fp: Path):
            try:
                for i, line in enumerate(fp.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
                    if regex.search(line):
                        rel = fp.relative_to(self.workspace).as_posix() if str(fp).startswith(str(self.workspace)) else str(fp)
                        results.append(f"{rel}:{i}: {line.strip()[:300]}")
                        if len(results) > 300:
                            return
            except Exception:
                pass

        if base.is_file():
            search_file(base)
        else:
            for root, dirs, files in os.walk(base):
                dirs[:] = [d for d in dirs if d not in _IGNORE_DIRS]
                for fname in files:
                    if glob_filter and not fnmatch.fnmatch(fname, glob_filter):
                        continue
                    search_file(Path(root) / fname)
                    if len(results) > 300:
                        break
                if len(results) > 300:
                    break
        if not results:
            return ToolResult("(no matches)")
        return ToolResult("\n".join(results[:300]))

    def _tool_spawn_agent(self, args: dict) -> ToolResult:
        prompt_text = args.get("prompt", "").strip()
        if not prompt_text:
            return ToolResult("spawn_agent requires a prompt.", is_error=True)
        from copy import replace as _copy_replace  # py 3.13; fall back below
        from dataclasses import replace as _dc_replace
        max_iter = int(args.get("max_iterations") or 12)
        # Build a constrained child Config: no stream, no plan_mode, no destructive
        # tools, low iteration cap. We deliberately keep the same model + api key.
        try:
            child_cfg = _dc_replace(
                self.config,
                max_iterations=max_iter,
                stream=False,
                confirm=False,
                plan_mode=True,  # blocks destructive tools entirely
            )
        except Exception:
            return ToolResult("Could not clone config for sub-agent.", is_error=True)
        # Lazy import to avoid cycles.
        from .agent import Agent
        from .session import Session
        from .prompts import build_system_prompt
        from .ui import UI

        system = build_system_prompt(
            child_cfg.workspace, "",
            codegraph_enabled=child_cfg.codegraph_enabled,
            rtk_enabled=child_cfg.rtk_enabled,
            caveman_enabled=getattr(child_cfg, "caveman_enabled", True),
        )
        sub_session = Session(system=system)
        # Silent UI: a degenerate UI that swallows output.
        class _SilentUI(UI):
            def assistant_text(self, *a, **kw): pass
            def tool_call(self, *a, **kw): pass
            def tool_result(self, *a, **kw): pass
            def show_diff(self, *a, **kw): pass
            def stream_chunk(self, *a, **kw): pass
            def info(self, *a, **kw): pass
            def error(self, *a, **kw): pass
            def print(self, *a, **kw): pass
            def rule(self, *a, **kw): pass
            def status(self, msg):  # context manager
                class _N:
                    def __enter__(self): return self
                    def __exit__(self, *a): return False
                return _N()
        silent = _SilentUI(color=False)
        try:
            sub_agent = Agent(child_cfg, sub_session, silent)
            sub_agent.run_turn(prompt_text)
        except Exception as exc:
            return ToolResult(f"Sub-agent crashed: {exc}", is_error=True)
        # Pull last assistant text as the sub-agent's answer.
        final_text = ""
        for msg in reversed(sub_session.messages):
            if msg.get("role") == "assistant":
                content = msg.get("content")
                if isinstance(content, list):
                    final_text = "\n".join(
                        b.get("text", "") for b in content
                        if isinstance(b, dict) and b.get("type") == "text"
                    ).strip()
                    if final_text:
                        break
        if not final_text:
            final_text = "(sub-agent finished without a final text answer)"
        return ToolResult(f"[sub-agent answer]\n{final_text}")

    def _tool_execute_bash_async(self, args: dict) -> ToolResult:
        command = args.get("command", "").strip()
        if not command:
            return ToolResult("No command provided.", is_error=True)
        run_cmd = wrap_with_rtk(command, enabled=self.config.rtk_enabled)
        job_id = _start_job(run_cmd, self.workspace)
        return ToolResult(f"Started background job: {job_id}\ncmd: {run_cmd}")

    def _tool_bash_job_status(self, args: dict) -> ToolResult:
        status = _job_status(args.get("job_id", ""))
        if status is None:
            return ToolResult("Unknown job id.", is_error=True)
        return ToolResult(json.dumps(status, indent=2))

    def _tool_bash_job_output(self, args: dict) -> ToolResult:
        max_chars = int(args.get("max_chars") or 20000)
        out = _job_output(args.get("job_id", ""), max_chars=max_chars)
        if out is None:
            return ToolResult("Unknown job id.", is_error=True)
        state = "running" if out["running"] else f"finished (exit={out['exit_code']})"
        return ToolResult(f"[{state}]\n{out['output']}", is_error=(out["exit_code"] not in (0, None)))

    def _tool_apply_patch(self, args: dict) -> ToolResult:
        patch = args.get("patch", "")
        if not patch.strip():
            return ToolResult("Empty patch.", is_error=True)
        # Use a temp file so git apply can read it; we feed via stdin for simplicity.
        try:
            proc = subprocess.run(
                ["git", "apply", "--whitespace=nowarn", "-"],
                cwd=str(self.workspace),
                input=patch,
                capture_output=True,
                text=True,
                timeout=60,
            )
        except FileNotFoundError:
            return ToolResult("git not found; cannot apply patch.", is_error=True)
        except Exception as exc:
            return ToolResult(f"git apply failed: {exc}", is_error=True)
        if proc.returncode != 0:
            return ToolResult(
                f"git apply rejected the patch:\n{proc.stderr or proc.stdout}",
                is_error=True,
            )
        return ToolResult("Patch applied cleanly.", diff=patch)

    def _tool_wait_for_file(self, args: dict) -> ToolResult:
        path = self._resolve(args["path"])
        timeout = int(args.get("timeout") or 30)
        since = float(args.get("since") or 0)
        deadline = time.time() + timeout
        while time.time() < deadline:
            if path.is_file():
                try:
                    mtime = path.stat().st_mtime
                except OSError:
                    mtime = 0
                if since <= 0 or mtime > since:
                    return ToolResult(f"{path} ready (mtime={mtime:.0f}).")
            time.sleep(0.25)
        return ToolResult(f"Timed out after {timeout}s waiting for {path}.", is_error=True)

    def _tool_code_search(self, args: dict) -> ToolResult:
        import ast as _ast
        name = args.get("name", "").strip()
        if not name:
            return ToolResult("Provide a 'name' to search.", is_error=True)
        kind = args.get("kind", "any")
        try:
            name_re = re.compile(name)
        except re.error as e:
            return ToolResult(f"Invalid regex: {e}", is_error=True)
        results: list[str] = []
        for py in self.workspace.rglob("*.py"):
            if self._is_ignored(py):
                continue
            try:
                tree = _ast.parse(py.read_text(encoding="utf-8", errors="replace"))
            except Exception:
                continue
            for node in _ast.walk(tree):
                if isinstance(node, (_ast.FunctionDef, _ast.AsyncFunctionDef)):
                    node_kind = "function"
                elif isinstance(node, _ast.ClassDef):
                    node_kind = "class"
                else:
                    continue
                if kind != "any" and node_kind != kind:
                    continue
                if not name_re.search(node.name):
                    continue
                rel = py.relative_to(self.workspace).as_posix()
                if node_kind == "class":
                    sig = f"class {node.name}"
                else:
                    args_list = [a.arg for a in node.args.args]
                    sig = f"def {node.name}({', '.join(args_list)})"
                results.append(f"{rel}:{node.lineno}: {sig}")
                if len(results) >= 200:
                    break
            if len(results) >= 200:
                break
        if not results:
            return ToolResult("(no matches)")
        return ToolResult("\n".join(results))

    def _tool_finish(self, args: dict) -> ToolResult:
        return ToolResult(args.get("summary", "Task complete."))


# ---- helpers ------------------------------------------------------------
_HTML_TAG = re.compile(r"<[^>]+>")
_HTML_SCRIPT_STYLE = re.compile(r"<(script|style)[^>]*>.*?</\1>", re.IGNORECASE | re.DOTALL)
_WS = re.compile(r"\n\s*\n\s*\n+")


def _html_to_text(html: str) -> str:
    """Tiny HTML stripper. Not a full parser — good enough for docs pages."""
    no_scripts = _HTML_SCRIPT_STYLE.sub("", html)
    no_tags = _HTML_TAG.sub("\n", no_scripts)
    # Common entity unescape (stdlib).
    try:
        import html as _html_mod

        no_tags = _html_mod.unescape(no_tags)
    except Exception:
        pass
    # Collapse excess blank lines.
    no_tags = _WS.sub("\n\n", no_tags)
    return "\n".join(ln.rstrip() for ln in no_tags.splitlines() if ln.strip())


def _render_tasks(tasks: list[dict]) -> str:
    icons = {"pending": "[ ]", "in_progress": "[~]", "done": "[x]"}
    lines = []
    for i, t in enumerate(tasks, 1):
        lines.append(f"  {i}. {icons.get(t['status'], '[?]')} {t['text']}")
    return "\n".join(lines)
