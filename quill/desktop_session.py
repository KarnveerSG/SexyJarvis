"""Desktop IDE session persistence — flush on shutdown, resume on reopen."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

from .extras import autosave_path, session_dir
from .session import Session


def desktop_resume_path(workspace: Path) -> Path:
    return session_dir(workspace) / "desktop_resume.json"


def is_named_workspace_env() -> bool:
    return os.environ.get("QUILL_NAMED_WORKSPACE", "0") == "1"


def try_resume_session(session: Session, workspace: Path) -> bool:
    """Load autosaved session for a named desktop workspace. Returns True if resumed."""
    if not is_named_workspace_env():
        return False
    ap = autosave_path(workspace)
    if not ap.is_file():
        return False
    try:
        loaded = Session.load(ap)
    except Exception:
        return False
    if not loaded.messages:
        return False
    session.messages = loaded.messages
    if loaded.system:
        session.system = loaded.system
    return True


def flush_desktop_session(session: Session, workspace: Path, *, named: bool | None = None) -> None:
    """Persist or discard agent context when the desktop IDE closes."""
    if named is None:
        named = is_named_workspace_env()

    session.cleanup_incomplete_turn()
    ap = autosave_path(workspace)
    resume = desktop_resume_path(workspace)

    if not named:
        for path in (ap, resume):
            try:
                if path.is_file():
                    path.unlink()
            except OSError:
                pass
        return

    if not session.messages:
        try:
            if resume.is_file():
                resume.unlink()
        except OSError:
            pass
        return

    session.save(ap)
    last_user = ""
    for msg in reversed(session.messages):
        if msg.get("role") != "user":
            continue
        content = msg.get("content", "")
        if isinstance(content, str) and content.strip():
            last_user = content.strip()[:240]
            break

    payload = {
        "saved_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "workspace_id": os.environ.get("QUILL_WORKSPACE_ID", ""),
        "message_count": len(session.messages),
        "last_user": last_user,
        "autosave": ap.name,
    }
    try:
        resume.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    except OSError:
        pass


def install_desktop_shutdown_handlers(session: Session, workspace: Path) -> None:
    """Register signal handlers so abrupt desktop close still flushes session state."""
    if os.environ.get("QUILL_DESKTOP") != "1":
        return

    import signal

    named = is_named_workspace_env()

    def _handler(_signum=None, _frame=None) -> None:
        flush_desktop_session(session, workspace, named=named)
        raise SystemExit(0)

    for sig_name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        sig = getattr(signal, sig_name, None)
        if sig is None:
            continue
        try:
            signal.signal(sig, _handler)
        except (ValueError, OSError):
            pass
