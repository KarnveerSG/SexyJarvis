"""PyInstaller entry point for a standalone quill executable."""

import importlib

for _mod in (
    "rich._unicode_data",
    "rich._unicode_data.unicode17-0-0",
    "rich._unicode_data.unicode16-0-0",
    "rich._unicode_data.unicode15-1-0",
):
    try:
        importlib.import_module(_mod)
    except ImportError:
        pass

from quill.cursor_patch import apply as _apply_cursor_patch

_apply_cursor_patch()

from quill.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
