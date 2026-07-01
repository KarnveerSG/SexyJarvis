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
QUILL_PROVIDER=auto
LM_STUDIO_URL=http://localhost:1234/v1
```

## Provider chain

`auto` (default): **Cursor** → **Claude API** → **local LLM**

Status bar provider dropdown switches `QUILL_PROVIDER` and persists to `~/.quill/.env`. On launch, Quill pings LM Studio (`:1234`) and Ollama (`:11434`) and shows **Local LLM: ready (model)** when available.

## Desktop IDE (v0.3)

### Workspaces & agents
- **Multi-workspace** — switch workspace without killing background agents; PTYs stay alive in main process
- **Running agents tray** (◎) — count badge + click-to-jump between active workspaces
- **Workspace dots** — green = agent running, red = idle/stopped
- **Task board** (☑ panel) — `.quill/tasks.json` per workspace; agents emit `[QUILL:TASK_START]` / `[QUILL:TASK_DONE]`

### Terminal grid
- Up to **9 panes** (3×3); 1 full, 2 split, 3–4 in 2×2
- **Per-pane status pill** — idle / thinking / editing / waiting / error from `[QUILL_TOOL:…]` markers
- **Handoff** — `/handoff <persona>` or agent composer **Send to pane** delegate
- Unique Greek goddess persona per pane (Hera, Artemis, Athena, Demeter, Aphrodite, Hestia, Persephone, Hecate, Nike)

### Agent panel
- Independent workspace selector; chat/composer without switching center view
- `@` file mentions in composer; structured stream to chat

### Command palette (`Ctrl+P`)
- `>` commands — settings, new pane, toggle provider, focus pane N, run last task
- `@` symbols & files
- `#` workspaces
- `:` go-to-line (e.g. `:42`)
- plain text — fuzzy file search

### Editor & SCM
- Monaco editor + inline diff hooks (`[QUILL_EDIT:path]`)
- Git status scoped to workspace folder (monorepo-safe)

### Settings
- Dark + **i mode** light theme
- MCP server config per workspace
- Keybinding overrides → `~/.quill/keybindings.json`

### Stability
- PTY shutdown race fixed; graceful quit kills all terminals and closes GPU/network connections

## Capabilities

Living inventory of everything Quill can do. Updated per release.

### Shell / Layout
- Electron desktop app + Python `quill` CLI
- Menubar (File / Edit / View / Help), custom titlebar
- Activity bar: Explorer · SCM · Search · Agent · Running-agents tray · Task board · Settings
- Command palette (Ctrl+P): `>` commands, `@` symbols/files, `#` workspaces, `:` goto-line, plain fuzzy
- Dark theme + light "i mode"
- **Drag-resize** sidebar and agent panels (double-click gutter to reset; widths persisted)

### Workspaces
- Multi-workspace, concurrent, agents persist across switches
- Workspace list with dot indicator (green=running, red=idle)
- Add / open / rename / close workspaces
- Sync export / import
- Explorer file tree, folder roots
- **Drag-and-drop** an OS folder onto the sidebar → new workspace
- **Session restore**: open editor tabs restored per workspace on relaunch and switch

### Editor
- Monaco editor with tabs, dirty indicator
- Inline diff view (Edit / Diff tabs)
- Save (Ctrl+S)
- Symbol/goto-line via command palette
- LSP provider hooks
- Git gutter decorations
- Multi-file **batch review queue**: every agent-edited file collects in a bar with `Apply all` / `Revert all`; per-file Keep / Revert on the inline diff bar

### Terminals (multi-pane grid)
- Up to 9 xterm panes; layouts 1 / 2 split / 2×2 / 3×3
- Unique Greek-goddess persona per pane
- Per-pane status pill (idle / thinking / editing / waiting / error) from `[QUILL_TOOL:…]`
- Per-pane composer with `@file` mentions
- `/handoff <persona>` between panes; "Send to pane" delegate
- Split gutter resize; PTYs survive workspace switches; graceful shutdown

### Agent Panel
- Chat + composer, independent workspace selector
- `@file` mention picker in global composer
- Structured event stream
- Toggle (Ctrl+L), minimize / expand / hide

### Agent Engine (CLI)
- Provider chain: Cursor → Claude API → local LLM (LM Studio / Ollama)
- Provider dropdown in statusbar
- Local LLM auto-detect (LM Studio :1234, Ollama :11434)
- Tools: read/write/edit/apply_patch, bash jobs, external tools
- MCP client backend (per-workspace `.quill/mcp.json`)
- CodeGraph tools when `.codegraph/` present
- Caveman-ultra terse output, RTK compact shell output
- Personas, memory, hooks, telemetry, ignore rules, session, watcher
- `--yolo` skip-confirmations

### Cost & Telemetry
- **Statusbar spend chip** — `$X.XX · Nk tok` per active workspace, updates on every `↳ turn used …` marker
- **Breakdown modal** — click chip → per-workspace table (in / out / turns / est. cost) with grand total
- Rough pricing: $3/M in, $15/M out (Claude/Cursor); local = $0

### Source Control
- Git status scoped to workspace root (monorepo-safe)
- Stage all / commit from side panel
- Statusbar branch dropdown
- **Per-workspace branch switcher** — click the branch badge on any workspace row for a checkout menu
- SCM badge count

### Search
- Fuzzy filename search in side panel
- **Content search** across workspace (Ctrl+Shift+F) via `git grep` with recursive JS fallback
- Click a result → opens file at line

### Task Board
- `.quill/tasks.json` per workspace
- Auto tasks from `[QUILL:TASK_START] / [QUILL:TASK_DONE]` markers
- Running-agents tray (◎) with count badge, click-to-jump

### Settings
- Appearance (dark / light)
- **MCP** — per-workspace `.quill/mcp.json` editor (add / test / remove servers)
- **MCP Skills** — per-workspace enable/disable toggle per configured server
- **Keyboard** — Record-key capture editor, reset to defaults, saved to `~/.quill/keybindings.json`
- Integrations panel with connect status
- **First-run wizard** — 3 steps (provider → API key or LLM detection → open folder)

### Agent control
- **`/undo`** command palette entry reverts pending agent edits via `git checkout --` and signals the agent PTY
- **Per-pane provider override** — right-click a pane → pick `auto` / `anthropic` / `cursor` / `local`; pane respawns with `QUILL_PROVIDER_OVERRIDE`
- **Background completion notifications** — toast and (opt-in) OS notification on `[QUILL:TASK_DONE]` from a non-active workspace
- **Prompt library** — save composer prompts to `~/.quill/prompts.json`, quick-insert into the composer with `{{file}}` placeholder expansion

### Conversation & prompts
- **History browser** — save current chat as a snapshot to `~/.quill/history/<wsId>/`, restore or delete past snapshots
- **Prompt library** — quick-insert with `{{file}}` placeholder; saved prompts also appear as `>` entries in the command palette

### Editor split view
- Toggle the `⧉` button to open a side-by-side second Monaco pane (scratch copy) — useful for viewing two regions of the same file

### Recent workspaces
- File menu → **Reopen Recent…** — modal with the last 8 opened folders

### Workspace rules
- Workspace header **Rules** button opens `.quill/rules.md` editor; agent picks it up on next turn

### Debugger (DAP-lite)
- Activity bar **▶ Debug** panel with per-workspace `launch.json` configs
- Run / stop a program; stdout/stderr stream to a docked output pane at the bottom of the editor
- Breakpoint gutter — click a Monaco line-number to toggle; breakpoints persist per workspace
- Breakpoint list panel with "Go" to jump to file:line
- **Scope**: this is not a full DAP client — no stepping, frames, variable inspection. It launches, streams, and records breakpoints. A real DAP adapter can be layered on top of the same UI later.

### Semantic search
- Global search modal now has **Text | Semantic** modes
- Semantic mode indexes workspace text files and ranks with **BM25** (no external embedding model required)
- Cache invalidates after 5 min or on `semanticIndexClear`
- Results include per-file BM25 score

### Multi-agent handoff threading
- Renderer emits `[QUILL:HANDOFF from=X to=Y id=Z]` markers when the composer targets a non-primary pane
- Target pane header shows an unread **✉ N** badge, click → inbox modal
- Handoff audit log written to each workspace's `.quill/handoffs.jsonl`

### CLI `/undo`
- `/undo` (or `/undo turn`) reverts every file edit from the last turn AND pops the last user + assistant messages from the session
- `/undo file` keeps the old behavior of reverting only the most recent single file edit

### Embedded browser (Cowork)
- Back / forward / reload / DevTools controls
- URL bar (Enter to navigate; bare text falls back to Google search)
- Open externally

### Integrations / Misc
- Cowork webview panel
- Multi-agent event-stream parser
- Onboarding modal

## Defaults (CLI)

- **Caveman ultra** — terse output
- **RTK** — compact shell output
- **CodeGraph** — when `.codegraph/` exists

## License

MIT
