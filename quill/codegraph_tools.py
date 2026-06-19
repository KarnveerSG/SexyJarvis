"""CodeGraph CLI tools — pre-indexed code intelligence (https://github.com/colbymchenry/codegraph)."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from .tool_types import ToolResult

# Anthropic tool schemas mirroring the CodeGraph MCP server.
CODEGRAPH_TOOL_SCHEMAS: list[dict] = [
    {
        "name": "codegraph_explore",
        "description": (
            "PRIMARY — call FIRST for how-does-X work, architecture, flows, or before editing. "
            "Returns relevant symbol source grouped by file in one call (Read-equivalent). "
            "Natural-language question or symbol/file names. Prefer over read_file/glob/grep loops."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Question, symbol names, or file names to explore.",
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "codegraph_node",
        "description": (
            "Read a file with line numbers (like read_file) OR inspect one symbol's source + "
            "caller/callee trail. Pass file alone for file mode; symbol (+ optional file) for symbol mode."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "symbol": {"type": "string", "description": "Symbol name (symbol mode)."},
                "file": {"type": "string", "description": "File path or basename."},
                "offset": {"type": "integer", "description": "File mode: 1-based start line."},
                "limit": {"type": "integer", "description": "File mode: max lines."},
            },
        },
    },
    {
        "name": "codegraph_search",
        "description": "Find symbols by name across the indexed codebase.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Symbol name or search term."},
                "kind": {"type": "string", "description": "Optional symbol kind filter."},
                "limit": {"type": "integer", "description": "Max results (default 25)."},
            },
            "required": ["query"],
        },
    },
    {
        "name": "codegraph_callers",
        "description": (
            "Every call site of a function/method, including callback registrations. "
            "Use before changing a symbol to see blast radius."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "symbol": {"type": "string", "description": "Symbol to look up callers for."},
                "file": {"type": "string", "description": "Optional file to disambiguate overloads."},
                "limit": {"type": "integer", "description": "Max call sites (default 50)."},
            },
            "required": ["symbol"],
        },
    },
]

CODEGRAPH_GUIDANCE = """
## CodeGraph (token savings)

A `.codegraph/` index is available. **Use CodeGraph tools instead of grep/read exploration loops:**

- `codegraph_explore` — almost any "how does X work" or pre-edit survey (ONE call, source included).
- `codegraph_node` — read a file or one symbol with callers/callees; prefer over `read_file` when exploring.
- `codegraph_search` — locate a symbol by name.
- `codegraph_callers` — full call-site list before refactoring.

Trust CodeGraph output — do not re-verify with grep. After edits, check staleness banners if present.
"""


def codegraph_cli_available() -> bool:
    return shutil.which("codegraph") is not None


def codegraph_indexed(workspace: Path) -> bool:
    return (workspace / ".codegraph").is_dir()


def codegraph_status(workspace: Path) -> str:
    if not codegraph_cli_available():
        return "codegraph CLI not installed"
    if not codegraph_indexed(workspace):
        return "not indexed (run: codegraph init)"
    return "ready"


def _run_codegraph(workspace: Path, args: list[str], timeout: int = 120) -> ToolResult:
    if not codegraph_cli_available():
        return ToolResult(
            "codegraph CLI not found. Install: "
            "https://github.com/colbymchenry/codegraph — then run `codegraph init` in the workspace.",
            is_error=True,
        )
    if not codegraph_indexed(workspace):
        return ToolResult(
            "No `.codegraph/` index in workspace. Run `codegraph init` first.",
            is_error=True,
        )
    try:
        proc = subprocess.run(
            ["codegraph", *args],
            cwd=str(workspace),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return ToolResult("codegraph command timed out.", is_error=True)
    except FileNotFoundError:
        return ToolResult("codegraph executable not found.", is_error=True)

    body = (proc.stdout or "").strip()
    if proc.stderr:
        body = (body + "\n" + proc.stderr.strip()).strip()
    if not body:
        body = "(no output)"
    if len(body) > 80000:
        body = body[:80000] + "\n[...truncated...]"
    return ToolResult(body, is_error=proc.returncode != 0)


class CodeGraphRunner:
    """Executes codegraph_* tools via the local CLI."""

    def __init__(self, workspace: Path):
        self.workspace = workspace

    def explore(self, args: dict) -> ToolResult:
        query = (args.get("query") or "").strip()
        if not query:
            return ToolResult("query is required.", is_error=True)
        return _run_codegraph(self.workspace, ["explore", query])

    def node(self, args: dict) -> ToolResult:
        symbol = (args.get("symbol") or "").strip()
        file_arg = (args.get("file") or "").strip()
        if not symbol and not file_arg:
            return ToolResult("Provide symbol and/or file.", is_error=True)

        cli_args = ["node"]
        if file_arg and not symbol:
            cli_args.extend(["-f", file_arg, file_arg])
        elif symbol:
            cli_args.append(symbol)
            if file_arg:
                cli_args.extend(["-f", file_arg])
        offset = args.get("offset")
        limit = args.get("limit")
        if offset:
            cli_args.extend(["--offset", str(int(offset))])
        if limit:
            cli_args.extend(["--limit", str(int(limit))])
        return _run_codegraph(self.workspace, cli_args)

    def search(self, args: dict) -> ToolResult:
        query = (args.get("query") or "").strip()
        if not query:
            return ToolResult("query is required.", is_error=True)
        cli_args = ["query", query]
        if args.get("kind"):
            cli_args.extend(["--kind", str(args["kind"])])
        if args.get("limit"):
            cli_args.extend(["--limit", str(int(args["limit"]))])
        return _run_codegraph(self.workspace, cli_args)

    def callers(self, args: dict) -> ToolResult:
        symbol = (args.get("symbol") or "").strip()
        if not symbol:
            return ToolResult("symbol is required.", is_error=True)
        cli_args = ["callers", symbol]
        if args.get("file"):
            cli_args.extend(["--file", str(args["file"])])
        if args.get("limit"):
            cli_args.extend(["--limit", str(int(args["limit"]))])
        return _run_codegraph(self.workspace, cli_args)

    def dispatch(self, name: str, args: dict) -> ToolResult:
        handler = {
            "codegraph_explore": self.explore,
            "codegraph_node": self.node,
            "codegraph_search": self.search,
            "codegraph_callers": self.callers,
        }.get(name)
        if handler is None:
            return ToolResult(f"Unknown codegraph tool: {name}", is_error=True)
        return handler(args)
