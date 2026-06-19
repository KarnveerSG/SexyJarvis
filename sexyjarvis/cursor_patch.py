"""Windows fixes for cursor-sdk local bridge discovery."""

from __future__ import annotations

import codecs
import os
import sys
import time
from collections.abc import Mapping
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import subprocess


def close_with_timeout(fn, timeout: float = 1.5) -> None:
    """Run *fn* in a daemon thread; never block exit longer than *timeout*."""
    import threading

    done = threading.Event()

    def _run() -> None:
        try:
            fn()
        except (KeyboardInterrupt, Exception):
            pass
        finally:
            done.set()

    threading.Thread(target=_run, daemon=True).start()
    try:
        done.wait(timeout=timeout)
    except KeyboardInterrupt:
        pass


def _patch_graceful_shutdown() -> None:
    try:
        import cursor_sdk._client as client_mod
    except ImportError:
        return
    if getattr(client_mod, "_sexyjarvis_shutdown_patched", False):
        return

    original = client_mod.close_default_client

    def _quiet_close() -> None:
        close_with_timeout(original, timeout=1.5)

    client_mod.close_default_client = _quiet_close  # type: ignore[method-assign]
    client_mod._sexyjarvis_shutdown_patched = True


def apply() -> None:
    _patch_graceful_shutdown()
    if sys.platform != "win32":
        return
    try:
        import cursor_sdk._bridge as bridge_mod
    except ImportError:
        return
    if getattr(bridge_mod, "_sexyjarvis_patched", False):
        return

    def _read_discovery_windows(process: "subprocess.Popen[str]", timeout: float) -> Mapping[str, object]:
        from cursor_sdk.errors import CursorSDKError

        if process.stderr is None:
            raise CursorSDKError("Bridge process stderr is unavailable")

        stderr_fd = process.stderr.fileno()
        was_blocking = os.get_blocking(stderr_fd)
        os.set_blocking(stderr_fd, False)
        try:
            decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
            deadline = time.monotonic() + timeout
            stderr_lines: list[str] = []
            pending = ""

            def drain_available() -> Mapping[str, object] | None:
                nonlocal pending
                while True:
                    try:
                        chunk = os.read(stderr_fd, 8192)
                    except BlockingIOError:
                        return None
                    if not chunk:
                        final_text = decoder.decode(b"", final=True)
                        if final_text:
                            pending += final_text
                        if pending:
                            line = pending
                            pending = ""
                            stderr_lines.append(line)
                            return bridge_mod.parse_discovery_line(line)
                        return None
                    pending += decoder.decode(chunk)
                    while "\n" in pending:
                        line, pending = pending.split("\n", 1)
                        line += "\n"
                        stderr_lines.append(line)
                        discovery = bridge_mod.parse_discovery_line(line)
                        if discovery is not None:
                            return discovery

            while time.monotonic() < deadline:
                discovery = drain_available()
                if discovery is not None:
                    return discovery
                exit_code = process.poll()
                if exit_code is not None:
                    discovery = drain_available()
                    if discovery is not None:
                        return discovery
                    raise CursorSDKError(
                        f"Bridge exited before discovery with status {exit_code}: "
                        + "".join(stderr_lines)
                        + pending
                    )
                time.sleep(0.05)
            raise CursorSDKError("Timed out waiting for bridge discovery")
        finally:
            os.set_blocking(stderr_fd, was_blocking)

    bridge_mod._read_discovery = _read_discovery_windows  # type: ignore[method-assign]
    bridge_mod._sexyjarvis_patched = True
