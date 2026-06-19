# Quill — agent instructions

## Token savings (enabled)

- **CodeGraph**: `.codegraph/` indexed. Use MCP `user-codegraph` tools (`codegraph_explore`, `codegraph_node`, `codegraph_callers`, `codegraph_search`) before read/grep loops.
- **RTK**: Prefix noisy shell commands with `rtk` (git, test, build, npm, pip).
- **Caveman**: Terse output when requested (`/caveman` or user rule).

Re-index after large structural changes: `codegraph init` or let the file watcher sync (~1s lag).
