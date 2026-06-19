# Quill

IDE-style AI coding agent. Multi-workspace terminal desktop + CLI agent.

**Tagline:** CODE BEAUTIFUL

## Install (Windows)

```powershell
python scripts/install_quill.py
```

This installs:
- `quill` CLI on PATH (`%LOCALAPPDATA%\Programs\Quill\quill.exe`)
- **Quill** desktop IDE shortcut on your Desktop

## Run

```powershell
quill                  # terminal agent (any folder)
quill --desktop        # open desktop IDE
quill -w E:\project    # agent in workspace
quill --yolo           # skip confirmations
```

## Config

Priority: CLI flags → env → workspace `.env` → `~/.quill/.env` → `config.toml`

Legacy `~/.sexyjarvis/.env` is auto-migrated on install.

```env
CURSOR_API_KEY=crsr_...
ANTHROPIC_API_KEY=sk-ant-...
QUILL_CURSOR_MODEL=auto
LM_STUDIO_URL=http://localhost:1234/v1
```

## Provider chain

`auto` (default): **Cursor** → **Claude API** → **local LLM**

## Desktop IDE

- Rainbow color-coded workspaces
- Split terminal grid (2×2 / 3×2)
- Named AI personas per pane (Iris, Thea, Nova, Sage, Luna, Wren)
- Dark mode + **i mode** light theme
- Agent panes run `quill` REPL; shell panes run PowerShell

## Defaults (CLI)

- **Caveman ultra** — terse output
- **RTK** — compact shell output
- **CodeGraph** — when `.codegraph/` exists

## License

MIT
