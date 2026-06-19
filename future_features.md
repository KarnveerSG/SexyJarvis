# Quill — Future Features

Planned enhancements beyond the current MVP (single workspace, agent terminal, integrations settings).

## State & Workspace

- [ ] Full session restore: open workspaces, folder roots, pane layouts, scroll positions
- [ ] Workspace profiles saved to `~/.quill/workspaces/*.yaml`
- [ ] Drag-and-drop folders into workspace sidebar
- [ ] Git branch indicator per workspace

## Terminal & Agents

- [ ] True ConPTY pseudo-terminal (native PTY on Windows) for full TTY fidelity
- [ ] Per-pane persona system prompts (Iris, Thea, Nova, Sage, Luna, Wren)
- [ ] Streaming voice talk-back in desktop panes
- [ ] Agent task badges on workspace sidebar (in progress / done counts)
- [ ] Split pane drag-resize (react-resizable-panels)

## IDE Features

- [ ] File tree explorer docked beside terminals
- [ ] Inline diff viewer for agent file edits
- [ ] `@mentions` picker in desktop input bar
- [ ] Command palette extensions (recent files, workspace switcher)

## Settings (Coming Soon placeholders exist)

- [ ] **MCP Skills** — configure MCP servers, enable/disable tools per workspace
- [ ] **Remote Integration** — SSH remote workspaces, cloud agent runners
- [ ] Theme editor (custom accent colors)
- [ ] Keybinding editor

## Integrations

- [ ] OAuth flows for GitHub, Stripe (beyond API key paste)
- [ ] Integration health checks (ping API on save)
- [ ] Pre-built MCP wrappers for connected services

## Distribution

- [ ] Auto-update channel for desktop + CLI
- [ ] Code-signed Windows installer (MSI)
- [ ] macOS / Linux desktop builds

## Started / Partial

- [x] Multi-theme support (dark, i mode, midnight, ocean, sunset, forest)
- [x] Integrations settings panel with `~/.quill/.env` persistence
- [x] VS Code-style menu bar (File, Edit, View, …)
- [ ] MCP Skills UI shell (placeholder only)
- [ ] Remote Integration UI shell (placeholder only)
