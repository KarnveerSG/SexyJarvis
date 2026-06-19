"""Minimal MCP (Model Context Protocol) stdio client.

Reads `.quill/mcp.json`:

    {
      "servers": {
        "github": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"]},
        "fs":     {"command": "uvx", "args": ["mcp-server-filesystem", "/tmp"]}
      }
    }

For each server, we spawn the subprocess, perform the MCP `initialize` handshake,
call `tools/list`, and surface each tool as `mcp_<server>_<tool>` in our tool
catalogue. Tool calls are dispatched back over the same stdio pipe via
`tools/call`. This is intentionally a tiny subset of the protocol — enough to
plug in real community MCP servers.
"""

from __future__ import annotations

import json
import subprocess
import threading
import time
from pathlib import Path
from typing import Any


def _config_path(workspace: Path) -> Path:
    return workspace / ".quill" / "mcp.json"


def load_mcp_config(workspace: Path) -> dict:
    path = _config_path(workspace)
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


class _StdioServer:
    """One MCP server subprocess speaking JSON-RPC 2.0 over stdio."""

    def __init__(self, name: str, command: str, args: list[str], env: dict | None = None, cwd: Path | None = None):
        self.name = name
        self.command = command
        self.args = args
        self.env = env
        self.cwd = cwd
        self.proc: subprocess.Popen | None = None
        self.tools: list[dict] = []
        self._id = 0
        self._lock = threading.Lock()

    def _next_id(self) -> int:
        self._id += 1
        return self._id

    def start(self, init_timeout: float = 8.0) -> bool:
        try:
            self.proc = subprocess.Popen(
                [self.command, *self.args],
                cwd=str(self.cwd) if self.cwd else None,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, bufsize=1, env=self.env,
            )
        except Exception:
            return False
        try:
            self._request(
                "initialize",
                {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "Quill", "version": "1.0"},
                },
                timeout=init_timeout,
            )
            self._notify("notifications/initialized", {})
            resp = self._request("tools/list", {}, timeout=init_timeout)
            self.tools = (resp or {}).get("tools", []) if isinstance(resp, dict) else []
            return True
        except Exception:
            self.stop()
            return False

    def _send(self, message: dict) -> None:
        if not self.proc or not self.proc.stdin:
            raise RuntimeError("server not running")
        line = json.dumps(message) + "\n"
        self.proc.stdin.write(line)
        self.proc.stdin.flush()

    def _read_response(self, want_id: int, timeout: float) -> Any:
        if not self.proc or not self.proc.stdout:
            raise RuntimeError("server not running")
        deadline = time.time() + timeout
        while time.time() < deadline:
            line = self.proc.stdout.readline()
            if not line:
                time.sleep(0.05)
                continue
            try:
                msg = json.loads(line)
            except Exception:
                continue
            if msg.get("id") == want_id:
                if "error" in msg:
                    raise RuntimeError(str(msg["error"]))
                return msg.get("result")
        raise TimeoutError(f"No response for id={want_id}")

    def _request(self, method: str, params: dict, timeout: float = 30.0) -> Any:
        with self._lock:
            mid = self._next_id()
            self._send({"jsonrpc": "2.0", "id": mid, "method": method, "params": params})
            return self._read_response(mid, timeout)

    def _notify(self, method: str, params: dict) -> None:
        with self._lock:
            self._send({"jsonrpc": "2.0", "method": method, "params": params})

    def call_tool(self, tool_name: str, arguments: dict, timeout: float = 60.0) -> tuple[bool, str]:
        try:
            result = self._request(
                "tools/call",
                {"name": tool_name, "arguments": arguments or {}},
                timeout=timeout,
            )
        except Exception as exc:
            return False, f"MCP call failed: {exc}"
        # Result is {content: [{type: text, text: ...}], isError?: bool}
        if not isinstance(result, dict):
            return True, json.dumps(result)
        is_error = bool(result.get("isError"))
        chunks = result.get("content") or []
        text_parts: list[str] = []
        for c in chunks:
            if not isinstance(c, dict):
                continue
            t = c.get("type")
            if t == "text":
                text_parts.append(str(c.get("text", "")))
            else:
                text_parts.append(json.dumps(c)[:500])
        return not is_error, "\n".join(text_parts).strip() or "(empty result)"

    def stop(self) -> None:
        if self.proc:
            try:
                self.proc.terminate()
            except Exception:
                pass
            self.proc = None


class MCPRegistry:
    """Spawns + tracks all configured MCP servers; exposes tool schemas."""

    def __init__(self, workspace: Path):
        self.workspace = workspace
        self.servers: dict[str, _StdioServer] = {}

    def start_all(self) -> list[str]:
        """Start every configured server. Returns list of started server names."""
        cfg = load_mcp_config(self.workspace).get("servers") or {}
        started: list[str] = []
        for name, spec in cfg.items():
            if not isinstance(spec, dict):
                continue
            command = spec.get("command")
            args = spec.get("args") or []
            env = spec.get("env")
            if not command:
                continue
            srv = _StdioServer(name, command, list(args), env=env, cwd=self.workspace)
            if srv.start():
                self.servers[name] = srv
                started.append(name)
        return started

    def stop_all(self) -> None:
        for s in self.servers.values():
            s.stop()
        self.servers.clear()

    def tool_schemas(self) -> list[dict]:
        schemas: list[dict] = []
        for sname, srv in self.servers.items():
            for tool in srv.tools or []:
                if not isinstance(tool, dict):
                    continue
                tname = tool.get("name", "")
                schemas.append(
                    {
                        "name": f"mcp_{sname}_{tname}",
                        "description": f"[mcp:{sname}] {tool.get('description', '')}",
                        "input_schema": tool.get("inputSchema") or {"type": "object", "properties": {}},
                    }
                )
        return schemas

    def call(self, full_name: str, args: dict) -> tuple[bool, str]:
        # full_name = mcp_<server>_<tool>
        if not full_name.startswith("mcp_"):
            return False, f"Not an MCP tool: {full_name}"
        rest = full_name[4:]
        for sname in self.servers:
            prefix = sname + "_"
            if rest.startswith(prefix):
                tname = rest[len(prefix):]
                ok, content = self.servers[sname].call_tool(tname, args)
                return ok, content
        return False, f"Unknown MCP server in {full_name}"
