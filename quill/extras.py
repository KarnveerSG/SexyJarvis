"""Extra slash-command helpers: history, diff, commit, custom commands, autosave."""

from __future__ import annotations

import json
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path


# ---- session autosave / history ----------------------------------------
def session_dir(workspace: Path) -> Path:
    d = workspace / ".quill"
    d.mkdir(parents=True, exist_ok=True)
    return d


def history_dir(workspace: Path) -> Path:
    d = session_dir(workspace) / "history"
    d.mkdir(parents=True, exist_ok=True)
    return d


def autosave_path(workspace: Path) -> Path:
    return session_dir(workspace) / "last_session.json"


def archive_to_history(workspace: Path, session) -> Path | None:
    """Copy current session into history/ with a timestamped filename."""
    if not session.messages:
        return None
    stamp = time.strftime("%Y%m%d-%H%M%S")
    target = history_dir(workspace) / f"session-{stamp}.json"
    session.save(target)
    return target


def list_history(workspace: Path) -> list[tuple[Path, int, str]]:
    """Return (path, message_count, first_user_message) for each archived session."""
    out: list[tuple[Path, int, str]] = []
    for p in sorted(history_dir(workspace).glob("session-*.json"), reverse=True):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            msgs = data.get("messages", [])
            first = ""
            for m in msgs:
                if m.get("role") == "user":
                    c = m.get("content")
                    if isinstance(c, str):
                        first = c[:80]
                    break
            out.append((p, len(msgs), first))
        except Exception:
            continue
    return out


# ---- git diff / commit --------------------------------------------------
def git_diff(workspace: Path, staged: bool = False) -> tuple[bool, str]:
    args = ["git", "diff"]
    if staged:
        args.append("--cached")
    try:
        proc = subprocess.run(args, cwd=str(workspace), capture_output=True, text=True, timeout=15)
    except Exception as exc:
        return False, f"git diff failed: {exc}"
    if proc.returncode != 0:
        return False, proc.stderr or "git diff failed"
    return True, proc.stdout


def git_branch(workspace: Path, name: str = "") -> tuple[bool, str]:
    """If name is empty, list branches; otherwise checkout (create if missing)."""
    if not name:
        try:
            proc = subprocess.run(
                ["git", "branch", "--show-current"], cwd=str(workspace),
                capture_output=True, text=True, timeout=10,
            )
            current = proc.stdout.strip()
            proc2 = subprocess.run(
                ["git", "branch"], cwd=str(workspace),
                capture_output=True, text=True, timeout=10,
            )
            return True, f"On: {current}\n{proc2.stdout}"
        except Exception as exc:
            return False, f"git branch failed: {exc}"
    # Try checkout existing, fall back to create.
    try:
        proc = subprocess.run(
            ["git", "checkout", name], cwd=str(workspace),
            capture_output=True, text=True, timeout=15,
        )
        if proc.returncode == 0:
            return True, proc.stdout.strip() or proc.stderr.strip() or f"Switched to {name}"
        proc = subprocess.run(
            ["git", "checkout", "-b", name], cwd=str(workspace),
            capture_output=True, text=True, timeout=15,
        )
        if proc.returncode == 0:
            return True, proc.stdout.strip() or proc.stderr.strip() or f"Created {name}"
        return False, proc.stderr.strip() or "git checkout failed"
    except Exception as exc:
        return False, f"git branch failed: {exc}"


def git_stash(workspace: Path, action: str = "push", message: str = "") -> tuple[bool, str]:
    args = ["git", "stash"]
    if action == "push":
        if message:
            args += ["push", "-m", message]
    elif action in ("pop", "list", "drop", "apply"):
        args.append(action)
    else:
        return False, f"Unknown stash action: {action}"
    try:
        proc = subprocess.run(args, cwd=str(workspace), capture_output=True, text=True, timeout=15)
        return proc.returncode == 0, (proc.stdout + proc.stderr).strip()
    except Exception as exc:
        return False, f"git stash failed: {exc}"


def git_status(workspace: Path) -> tuple[bool, str]:
    try:
        proc = subprocess.run(
            ["git", "status", "--short"], cwd=str(workspace),
            capture_output=True, text=True, timeout=10,
        )
    except Exception as exc:
        return False, f"git status failed: {exc}"
    if proc.returncode != 0:
        return False, proc.stderr or "git status failed"
    return True, proc.stdout


# ---- custom commands ----------------------------------------------------
@dataclass
class CustomCommand:
    name: str
    path: Path
    body: str

    def render(self, args: str) -> str:
        if "{args}" in self.body or "$ARGUMENTS" in self.body:
            return self.body.replace("{args}", args).replace("$ARGUMENTS", args)
        if args:
            return f"{self.body}\n\nArguments: {args}"
        return self.body


def export_markdown(session, target: Path) -> Path:
    """Write a readable markdown transcript of the session."""
    lines: list[str] = [f"# Quill session — {time.strftime('%Y-%m-%d %H:%M:%S')}", ""]
    for msg in session.messages:
        role = msg.get("role", "?")
        content = msg.get("content")
        lines.append(f"## {role}")
        lines.append("")
        if isinstance(content, str):
            lines.append(content)
        elif isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                btype = block.get("type")
                if btype == "text":
                    lines.append(block.get("text", ""))
                elif btype == "tool_use":
                    name = block.get("name", "")
                    args = block.get("input", {})
                    lines.append(f"**tool_use** `{name}` `{json.dumps(args, default=str)[:400]}`")
                elif btype == "tool_result":
                    raw = block.get("content", "")
                    if isinstance(raw, list):
                        raw = " ".join(b.get("text", "") for b in raw if isinstance(b, dict))
                    lines.append("```")
                    lines.append(str(raw)[:2000])
                    lines.append("```")
        lines.append("")
    target.write_text("\n".join(lines), encoding="utf-8")
    return target


def detect_test_command(workspace: Path) -> str | None:
    """Pick a sensible test command for the project."""
    if (workspace / "pytest.ini").is_file() or (workspace / "pyproject.toml").is_file() or (workspace / "tests").is_dir():
        return "python -m pytest -q"
    if (workspace / "package.json").is_file():
        try:
            data = json.loads((workspace / "package.json").read_text(encoding="utf-8"))
            scripts = data.get("scripts") or {}
            if "test" in scripts:
                return "npm test --silent"
        except Exception:
            pass
    if (workspace / "Cargo.toml").is_file():
        return "cargo test"
    if (workspace / "go.mod").is_file():
        return "go test ./..."
    return None


def run_tests(workspace: Path, timeout: int = 300) -> tuple[int, str, str]:
    """Run the detected test command. Returns (exit_code, command, output)."""
    cmd = detect_test_command(workspace)
    if not cmd:
        return -1, "", "No test runner detected for this project."
    try:
        proc = subprocess.run(
            cmd, shell=True, cwd=str(workspace),
            capture_output=True, text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return 124, cmd, f"Test command timed out after {timeout}s."
    out = (proc.stdout or "") + ("\n[stderr]\n" + proc.stderr if proc.stderr else "")
    if len(out) > 20000:
        out = out[:20000] + "\n[...truncated...]"
    return proc.returncode, cmd, out


def gh_pr_create(workspace: Path, title: str, body: str) -> tuple[int, str]:
    """Run `gh pr create` with the supplied title/body."""
    try:
        proc = subprocess.run(
            ["gh", "pr", "create", "--title", title, "--body", body],
            cwd=str(workspace), capture_output=True, text=True, timeout=60,
        )
    except FileNotFoundError:
        return 127, "gh CLI not found. Install from https://cli.github.com/."
    except Exception as exc:
        return 1, f"gh pr create failed: {exc}"
    out = (proc.stdout or "") + (proc.stderr or "")
    return proc.returncode, out.strip()


def retry_last_user_message(session) -> str | None:
    """Pop messages back to the most recent user message and return its text.

    Returns the user's text (so the caller can resubmit) or None if no
    suitable user message is found.
    """
    # Walk back to find the last user text message.
    for i in range(len(session.messages) - 1, -1, -1):
        msg = session.messages[i]
        if msg.get("role") != "user":
            continue
        content = msg.get("content")
        if isinstance(content, str):
            # Drop this message and everything after.
            session.messages = session.messages[:i]
            return content
    return None


def discover_custom_commands(workspace: Path) -> dict[str, CustomCommand]:
    """Find .quill/commands/*.md (and ~/.quill/commands/) as user commands."""
    out: dict[str, CustomCommand] = {}
    for root in (workspace / ".quill" / "commands", Path.home() / ".quill" / "commands"):
        if not root.is_dir():
            continue
        for p in root.glob("*.md"):
            name = p.stem.lower()
            try:
                body = p.read_text(encoding="utf-8").strip()
            except Exception:
                continue
            if name and body and name not in out:
                out[name] = CustomCommand(name=name, path=p, body=body)
    return out
