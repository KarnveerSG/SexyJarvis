# Quill — Feature Roadmap Plan

Cursor-ready specs for the next wave of features. Each section is self-contained:
files to touch, IPC additions, data shape, UX, acceptance test. Build top-to-bottom
or cherry-pick — they're independent unless noted.

Repo: `E:\CodingProjects\FinishedProjects\Quill`
Stack: Electron 33 + vanilla JS renderer (modules under `desktop/renderer/modules/`)
+ Python `quill` CLI agent.

Already built (don't redo): per-pane status pills, agent tray badge, task board
from `[QUILL:TASK_START/DONE]` markers, provider switcher, `/handoff` composer
formatting, MCP add/edit form (just not routed to the "skills" settings page).

---

## Tier 1 — Highest user-felt impact

### 1. Session restore

**Goal:** Quit and reopen Quill, get your workspaces / panes / open files / active
workspace / panel widths back exactly as they were.

**Files:**
- `desktop/main.js` — write `~/.quill/session.json` on `before-quit` and on every
  workspace change (debounced 2s).
- `desktop/preload.js` — expose `quill.saveSession(obj)` / `quill.loadSession()`.
- `desktop/renderer/modules/state.js` — call `loadSession` on boot, merge into
  `state.workspaces` and per-workspace meta.
- `desktop/renderer/modules/workspaces.js` — `restoreOpenFiles(ws)` after `ensureWorkspaceUI`.
- `desktop/renderer/modules/editor.js` — `restoreScrollPosition(filePath, line)`.

**Shape:**
```json
{
  "version": 1,
  "activeWorkspaceId": "ws-...",
  "agentPanelWorkspaceId": "ws-...",
  "panelWidths": { "side": 280, "agent": 360 },
  "workspaces": [
    { "id": "...", "openFiles": ["src/foo.ts"], "activeFile": "src/foo.ts",
      "scrollByFile": { "src/foo.ts": { "line": 42, "col": 0 } },
      "splitPct": 50, "layout": "grid-2x2" }
  ]
}
```

**Acceptance:**
- Open 2 workspaces, each with 3 panes + 2 open files. Quit. Relaunch. All restored.
- Crash mid-session (kill the process): on next launch, restore still works (writes
  are atomic — write to `session.json.tmp` then rename).

---

### 2. Drag-resize panels

**Goal:** User drags the boundary between sidebar/editor/agent panel and the split
persists.

**Files:**
- `desktop/renderer/index.html` — add `<div class="panel-gutter" data-target="side">`
  between `#side-panel` and `.center-panel`; same between `.center-panel` and
  `#agent-panel`.
- `desktop/renderer/styles.css` — `.panel-gutter { width: 5px; cursor: col-resize; }`
  with hover state.
- `desktop/renderer/modules/workspaces.js` — extract the existing `createSplitGutter`
  pattern from `terminals.js:191` into a shared `util.makeGutter({ onResize, persist })`.
- `desktop/renderer/modules/state.js` — `state.panelWidths = { side: 280, agent: 360 }`.

**UX:**
- Min 200px, max 50% of viewport per side.
- Double-click gutter resets to default.
- Width persisted via session restore (#1).

**Acceptance:**
- Drag sidebar from 280→400px; agent panel from 360→500px. Reload. Widths kept.

---

### 3. MCP Skills panel (make it real)

**Goal:** Replace the "Coming Soon" stub at [settings.js:68-74](../desktop/renderer/modules/settings.js) with a working MCP server + per-tool config UI.

**Backend (already exists):** `quill/mcp_client.py` connects, lists tools, calls them.

**Files:**
- `desktop/renderer/modules/settings.js` — replace `if (settingsSection === "skills")`
  block with a render that lists servers, enabled tools per server, per-workspace
  enable toggles. Reuse the form at settings.js:241 for adding new servers.
- `desktop/main.js` — IPC `mcp-list-tools`, `mcp-test-server` (ping + tool count),
  `mcp-toggle-tool({ server, tool, enabled, workspaceId })`.
- `desktop/preload.js` — expose `quill.mcpListTools()`, `quill.mcpTestServer(name)`,
  `quill.mcpToggleTool(...)`.
- `quill/mcp_client.py` — `list_tools(server_name)` returns `[{ name, description }]`;
  `test_server(name)` returns `{ ok, toolCount, error? }`.
- `~/.quill/mcp.json` — gains `enabledTools: { "<server>": ["tool1", "tool2"] }`
  and `perWorkspace: { "<wsId>": { "<server>": "enabled" | "disabled" } }`.

**UX:**
```
[+ Add server]   [Test all]
─────────────────────────────────────
▼ github       ● connected · 12 tools     [⚙] [Test] [Remove]
  [✓] create_issue       Create a new issue
  [✓] list_pull_requests List open PRs
  [ ] delete_repo        (dangerous — disabled)
  Per-workspace:  [✓ project-a]  [ ] project-b

▶ filesystem   ● connected · 5 tools     [⚙] [Test] [Remove]
```

**Acceptance:**
- Add a server via UI → restart agent → `quill` CLI sees it in tool list.
- Disable a tool → agent can't call it.
- Disable a server for one workspace → other workspace still uses it.

---

### 4. Inline diff / batch review queue

**Goal:** Every file an agent edits goes into a review queue. User clicks
Keep/Revert per file or "Keep all" / "Revert all".

**Current state:** `#inline-diff-bar` + `#batch-review-bar` exist in HTML;
`[QUILL_EDIT:path]` markers fire `editor.onWorkspaceFileChanged` but only open
the diff view — no queue, no batch state.

**Files:**
- `desktop/renderer/modules/editor.js` — new `pendingEdits` Map: `path → { before, after, paneId, ts }`. On `[QUILL_EDIT:path]`, snapshot the disk content as `before` (read from main process pre-edit snapshot — see backend), set `after` to current disk, enqueue.
- `desktop/main.js` — when agent calls `write_file`/`edit_file`, the Python tool
  emits `[QUILL_EDIT_PRE:path:<base64-of-old>]` marker BEFORE write, then
  `[QUILL_EDIT:path]` after. Main process passes both through to renderer.
- `quill/tools.py` — `write_file` / `edit_file` / `apply_patch` already emit
  `[QUILL_EDIT:...]`; add the pre-marker with the file's prior bytes (base64).
- `desktop/renderer/modules/editor.js` — wire `#batch-apply-all`, `#batch-revert-all`,
  `#diff-accept`, `#diff-reject` buttons.

**Revert** = write `before` back to disk; **Keep** = pop from queue.

**UX:**
- Bar shows `3 files changed by agent  [Keep all] [Revert all]`.
- Click count → opens a dropdown listing each path with mini Keep/Revert.
- Per-file diff bar (`#inline-diff-bar`) appears when the file is open in Monaco.

**Acceptance:**
- Ask agent to edit 3 files. Bar shows "3". Revert one. Bar shows "2". Restart
  agent — Keep-all on quit auto-keeps survivors.
- Edits across workspaces don't pollute the queue of the active workspace.

---

### 5. @mention picker in the global agent composer

**Goal:** Typing `@` in `#agent-composer-input` opens fuzzy file picker.
(Already works in per-pane composers — extract and apply to the global one.)

**Files:**
- `desktop/renderer/modules/agentPanel.js` — call the same `searchFiles` IPC
  and reuse the menu rendering from `terminals.js:398-419`. Factor that into
  `util.bindMentionMenu(input, getCwd)` so both composers share it.

**Acceptance:**
- Type `@app` in agent panel — see fuzzy list of matching files in current workspace.
- Pick one → inserts `@src/app.js ` (with trailing space). Submit → agent reads it.

---

### 6. Drag-and-drop folders → new workspace

**Goal:** Drag a folder from OS Explorer onto Quill → adds it as workspace.

**Files:**
- `desktop/renderer/modules/workspaces.js` — bind `dragover` (preventDefault),
  `drop` on `#workspace-list` and the empty state.
- `desktop/main.js` — Electron exposes `file.path` via `webUtils.getPathForFile(file)`
  (Electron 32+ requires this — `file.path` is deprecated). Add helper in preload.
- `desktop/preload.js` — `quill.getDroppedPath(file)`.

**UX:** Highlight target with dashed border on dragover.

**Acceptance:**
- Drag `C:\src\repo` onto sidebar → new workspace named "repo" appears with cwd set.

---

### 7. Cost / token spend in statusbar

**Goal:** Always-visible spend chip. `$0.12 · 4.2k tok` next to provider chip.

**Backend:** `quill/cost.py` already tallies. CLI emits totals when reporting
tokens. Renderer already parses `↳ turn used X in / Y out tokens` in
[multi-agent.js:76](../desktop/renderer/multi-agent.js:76).

**Files:**
- `quill/cli.py` — after each turn, emit `[QUILL:SPEND in_tok=… out_tok=… usd=…]`
  marker using the Cursor/Claude/local-LLM prices from `cost.py`.
- `desktop/renderer/multi-agent.js` — parse marker, accumulate per workspace,
  show in a new statusbar chip `#status-spend`.
- `desktop/renderer/index.html` — add `<span id="status-spend" class="status-chip"></span>`
  in the statusbar.
- `desktop/renderer/styles.css` — chip styling, click to open cost breakdown.

**Acceptance:**
- After 3 turns, chip shows total. Switch workspace — chip shows that workspace's total.
- Click chip → modal with per-provider breakdown for the session.

---

## Tier 2 — Real multi-agent payoff

### 8. Inter-pane handoff threading

**Goal:** When pane A `/handoff`s to pane B, pane B's input prepends a "from Hera:"
badge and the originating message is logged to a shared `.quill/handoffs.jsonl`.

**Files:**
- `quill/cli.py` — handle `/handoff <persona>\n<message>` (already parsed via
  `formatComposerWrite`). On receive in the target pane's REPL, prepend a
  formatted header and append to `.quill/handoffs.jsonl` per workspace.
- `desktop/renderer/multi-agent.js` — parse `[QUILL:HANDOFF from=Hera to=Athena id=...]`
  markers; show a small chip in target pane header that links back to the source.

**Data shape (`.quill/handoffs.jsonl`):**
```jsonl
{"id":"h1","ts":1700000000,"from":"Hera","to":"Athena","wsId":"ws1","payload":"please review src/foo.ts"}
```

**Acceptance:**
- Compose "/handoff Athena please review X" from Hera's pane → Athena's pane shows
  inbox badge. Click → reveals the payload. Reply works.

---

### 9. Per-pane model / provider selection

**Goal:** Right-click pane header → "Model…" → pick Cursor/Claude/local +
specific model. Pane spawns `quill` with that provider only.

**Files:**
- `desktop/renderer/modules/terminals.js` — extend pane header context menu
  (`showPaneContextMenu` at terminals.js:496) with a "Model…" submenu.
- `desktop/main.js` — `spawnTerm` accepts `provider` + `model` opts; passes as
  env `QUILL_PROVIDER_OVERRIDE` / `QUILL_MODEL_OVERRIDE`.
- `quill/cli.py` — honor those env vars over `.env` provider.
- State: `state.panes[paneId].provider`, `.model` — persist via session restore.

**UX:** Pane header shows `Hera · claude-sonnet-4-6` instead of just `Hera`
when overridden.

**Acceptance:**
- Set pane 1 to Cursor, pane 2 to local Ollama, pane 3 to Claude. All three
  active simultaneously. Verify via `quill --debug` log per pane.

---

### 10. Parallel task dispatch

**Goal:** Composer command `/parallel <task>` sends the same prompt to every
pane in the workspace at once; results stream back side-by-side.

**Files:**
- `desktop/renderer/modules/agentPanel.js` — detect `/parallel ` prefix; instead
  of writing to one PTY, write to every PTY in `ws.paneIds`.
- `desktop/renderer/multi-agent.js` — add a "merge view" button to the agent
  panel that shows the most recent reply from each pane in a 3-column layout.

**Acceptance:**
- 3 panes. Type `/parallel summarize this codebase`. All 3 stream replies. Merge
  view shows each persona's answer side-by-side.

---

### 11. Manager pane (agent-of-agents)

**Goal:** Mark one pane as "Manager". It runs a special system prompt: it
decomposes a user task and emits `[QUILL:DISPATCH to=Athena task=...]` markers
that the renderer forwards to the named pane via handoff.

**Files:**
- `quill/personas.py` — add `Manager` persona with system prompt that includes
  the dispatch protocol.
- `quill/cli.py` — when running with `QUILL_PERSONA=Manager`, emit dispatch
  markers instead of doing work itself.
- `desktop/renderer/multi-agent.js` — parse `[QUILL:DISPATCH to=… task=…]`,
  forward to target pane via `pty.write`.
- Pane header: when persona === "Manager", show a 👑 badge and a "Spawn worker"
  button that creates a new pane.

**Acceptance:**
- Manager pane gets "build a feature flag system". It dispatches "schema" to
  pane A, "API" to pane B, "UI" to pane C. Each pane works in parallel.
  Manager pane summarizes when all three emit `[QUILL:TASK_DONE]`.

---

## Tier 3 — Polish / quick wins

### 12. Conversation/turn rollback (`/undo`)

**Goal:** `/undo` reverts the last turn's file edits AND pops the user/assistant
messages so re-asking gets a clean retry.

**Files:**
- `quill/agent.py` — keep a per-turn snapshot of edited files in `.quill/turns/<turnId>/`.
- `quill/cli.py` — handle `/undo` command: revert files, pop last 2 messages,
  emit confirmation.

**Acceptance:**
- Agent edits 2 files. User types `/undo`. Both files restored, conversation
  history rolled back one user-assistant exchange.

---

### 13. Search-in-files (content) backed by ripgrep

**Goal:** Ctrl+Shift+F opens `#global-search`. Currently UI exists but no
ripgrep IPC.

**Files:**
- `desktop/main.js` — IPC `search-in-files({ cwd, query, glob? })` shells out
  to `rg --json` (bundled or `process.env.PATH` lookup; fallback to JS scan).
- `desktop/preload.js` — `quill.searchInFiles(opts)`.
- `desktop/renderer/app.js` — wire `#global-search-input` to call it; render
  grouped results in `#global-search-results`.

**Acceptance:**
- Search "useState" in a React repo. Results grouped by file, click jumps to
  file+line in Monaco.

---

### 14. Git branch indicator + switcher per workspace

**Goal:** Workspace sidebar row shows current branch; click to switch.

**Files:**
- `desktop/main.js` — IPC `git-branches(cwd)`, `git-checkout({ cwd, branch })`.
- `desktop/renderer/modules/workspaces.js` — append `<small class="ws-branch">`
  to each row; lazy-load via `git symbolic-ref --short HEAD`.
- Reuse `#status-branch` `<select>` logic for the switcher dropdown.

**Acceptance:**
- Two workspaces side by side, each on different branches, each shows correct
  branch name. Switch via dropdown — file tree refreshes.

---

### 15. Notifications for background agent completion

**Goal:** Agent finishes a task while user is on a different workspace →
toast or OS notification.

**Files:**
- `desktop/renderer/multi-agent.js` — listen for `[QUILL:TASK_DONE]` on any
  workspace that's not the active one; show:
  - In-app toast: "Athena finished: refactor cli.py" (clickable → switch)
  - Optional OS notification via `new Notification(...)` if user enabled.
- Settings: `notifications.backgroundCompletion` toggle.

**Acceptance:**
- Start a task in workspace A, switch to B. When A's task completes, toast
  appears and clicking it returns to A.

---

### 16. Keybinding editor (verify + complete)

**Goal:** Confirm `renderKeybindingsSettings` actually persists. If only
read-only, make it editable.

**Files:**
- `desktop/renderer/quill-features.js` — extend `renderKeybindingsSettings`:
  each row gets "Record" button → captures next keydown → writes to
  `~/.quill/keybindings.json`.
- `desktop/renderer/app.js` — on boot, load custom bindings and override the
  default action map.

**Acceptance:**
- Rebind Ctrl+P to Ctrl+T. Restart. Ctrl+T opens the palette.

---

### 17. First-run wizard

**Goal:** New users get a 3-step setup instead of `.env` editing.

**Steps:**
1. Pick primary provider (Cursor / Claude API / Local).
2. Paste API key (or detect Ollama / LM Studio).
3. Open a folder or "Try the sample repo" (clone a small example).

**Files:**
- `desktop/renderer/index.html` — extend `#onboarding` with multi-step view.
- `desktop/main.js` — IPC `write-env({ ANTHROPIC_API_KEY, CURSOR_API_KEY, ... })`
  writes to `~/.quill/.env`.
- Detect: `bootstrap.localLlmAvailable` (already exists) + Ollama ping
  `http://localhost:11434/api/tags`.

**Acceptance:**
- Fresh install (delete `~/.quill/`): wizard appears. Complete it. App works
  without any manual file editing.

---

### 18. Cowork browser controls

**Goal:** The webview at `#cowork-browser` has no back/forward/reload/devtools.

**Files:**
- `desktop/renderer/index.html` — add toolbar above the webview with the four
  buttons + URL bar.
- `desktop/renderer/cowork.js` — wire `webview.goBack()`, `goForward()`,
  `reload()`, `openDevTools()`.

**Acceptance:**
- Navigate, go back, reload, open devtools — all work in the embedded browser.

---

### 19. Periodic local-LLM health check

**Goal:** `bootstrap.localLlmAvailable` is checked once at startup. If LM Studio
crashes mid-session, the UI still shows "local: ready". Poll every 30s.

**Files:**
- `desktop/main.js` — `setInterval(() => fetch(LM_STUDIO_URL + '/models'), 30000)`;
  on state change, send `local-llm-status` to renderer.
- `desktop/renderer/multi-agent.js` — `bindProviderSwitcher` already reads
  `bootstrap.localLlmAvailable`; subscribe to updates and re-render the
  provider select.

**Acceptance:**
- Stop LM Studio while Quill is running. Within 30s the dropdown grays out
  the "local" option.

---

### 20. Theme editor (custom accent)

**Goal:** Color picker for accent + background in settings.

**Files:**
- `desktop/renderer/modules/settings.js` — appearance page gains two
  `<input type="color">` rows.
- Apply via `document.documentElement.style.setProperty('--accent', value)`.
- Persist to `~/.quill/theme.json`.

Low priority — defer until everything else ships.

---

## Build order (recommended sprints)

**Sprint 1 (week 1) — Foundations:**
- #1 Session restore
- #2 Drag-resize panels
- #6 Drag-drop folders
- #5 Global @mentions
- #7 Cost chip

**Sprint 2 (week 2) — Agent UX:**
- #4 Batch review queue
- #3 MCP Skills panel
- #15 Background completion notifications
- #13 Search-in-files

**Sprint 3 (week 3) — Multi-agent payoff:**
- #9 Per-pane model
- #8 Handoff threading
- #10 Parallel dispatch
- #11 Manager pane

**Sprint 4 (week 4) — Polish:**
- #12 `/undo` turn rollback
- #14 Git branch switcher
- #16 Keybinding editor
- #17 First-run wizard
- #18 Cowork browser controls
- #19 Local LLM health poll
- #20 Theme editor

---

## Out of scope (file separately if pursued)

- Remote Integration (#2 in settings stub) — full SSH workspaces, cloud runners.
- 3-way diff merge UI for parallel agent edits.
- Auto-update / code-signed installer.
- macOS / Linux builds.
- OAuth flows for GitHub/Stripe integrations.

---

## Shared infrastructure to add up front

Some features above share primitives. Build these helpers first to avoid duplication:

- **`desktop/renderer/modules/util.js`**
  - `makeGutter({ orientation, onResize, persist })` — used by #2 (panel gutters) and existing pane split.
  - `bindMentionMenu(input, getCwd)` — used by #5 and the existing per-pane composer.
  - `parseQuillMarkers(stream)` — central regex pass for all `[QUILL:...]` markers (currently scattered across multi-agent.js, editor.js, agentPanel.js). Returns typed events.

- **`desktop/preload.js`** — group new IPC under namespaces: `quill.mcp.*`, `quill.session.*`, `quill.git.*`, `quill.search.*`. Easier to discover.

- **Marker registry doc** at `docs/quill-markers.md` — single source of truth for
  every `[QUILL:...]` marker the Python agent emits and the renderer parses.
  Tier-1 features #4 and #7 add new markers; document them all in one place so
  drift doesn't accumulate.
