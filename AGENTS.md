# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Current state: MVP Step 1 — notebook document + save pipeline

Built on the Phase 0 bridge spike. Full product/tech spec lives outside the repo at `firstmate/data/cellar-spec.md` (read §3 for the versioning model); nbdev field-policy detail at `firstmate/data/nbdev-study-n8/report.md`. See `README.md` for run/verify details.

- **Two runtimes.** Node (SvelteKit) + a Python sidecar (Jupyter kernel service) in `.venv/`. Both are booted by the CLI launcher `bin/cellar.js` (one command → both servers up → browser opens, workspace = cwd). `.venv/` is gitignored; recreate it via the setup steps in `README.md`.
- **Kernel bridge = the de-risked core.** `src/lib/server/kernel.js` connects to Jupyter over REST+WebSocket using `@jupyterlab/services` (spec §2). Node 18+ global `fetch`/`WebSocket` are passed into `ServerConnection.makeSettings` — no polyfill. `execute()` emits real nbformat output objects so the same shape streams live to the browser and is persisted.
- **Kernelspec.** `python3` kernelspec must be registered into the venv (`ipykernel install --sys-prefix --name python3`), or `startNew({name:'python3'})` fails.
- **Canonical document (server-owned).** `src/lib/server/notebook.js` holds the in-memory notebook (one per workspace folder, `notebook.ipynb`), loaded on startup and persisted on every mutation. Cellar owns cell IDs — readable `cell-N` slugs from a monotonic counter, never reused/regenerated, uniqueness enforced on load (`enforceUniqueIds` re-keys missing/duplicate; it does NOT rely on nbformat's auto-rename, spec §3).
- **Persistence + clean-on-save.** `src/lib/server/ipynb.js` (de)serializes canonical doc ↔ real nbformat 4.5 with **deterministic** output (fixed key order, 1-space indent) so identical re-runs produce zero git diff. `src/lib/server/clean.js` is the nbdev field-policy port: nulls all `execution_count`, deny-by-default metadata allowlist (cell keeps only the `cellar` namespace; notebook keeps only `kernelspec` — drops `language_info`/`widgets`), normalizes `kernelspec.display_name`→`name`, scrubs `<… at 0x…>` memory addresses. Must stay **idempotent**.
- **API.** `+page.server.js` load returns the notebook; cell ops under `src/routes/api/cells/…` (`POST` add, `PATCH` source, `DELETE`, `POST …/run` streams NDJSON + persists, `…/move`, `…/clear`).
- **Cell types.** Code and **Markdown** (nbformat `cell_type`). Markdown cells carry source + no outputs/execution_count; clean-on-save + UUID ids apply the same. `addCell(afterId, cellType)` and `setCellType(id, type)` (PATCH `cell_type`); converting to markdown clears outputs.
- **UI.** `src/lib/Cell.svelte` = one cell — CodeMirror editor (language via a Compartment: python / markdown), per-cell toolbar, renders nbformat outputs. Markdown cells render to sanitized HTML (markdown-it `html:false` + DOMPurify, client-only via `browser` guard); double-click / pencil button → raw edit; Run/⌘Enter renders in place, Shift+Enter renders+advances. Type toggle is the far-right `python3`/`markdown` label. `+page.svelte` = notebook view (add code/markdown, delete/reorder, single-kernel one-run-at-a-time; markdown "run" persists source only, no kernel). Editor source autosaves via debounced `PATCH`. Dev exposes `window.cellarViews[id]`.
- **MCP agent interface.** `src/lib/server/mcp/` — the agent surface (spec §4). `service.js` = transport-independent tool logic (section tree from markdown headers, tiered/summarized outputs, visibility filtering, UUID-addressed read/write/execute); `server.js` = `McpServer` + Streamable HTTP transport on its own port (`CELLAR_MCP_PORT`, default 39587, path `/mcp`), started once from `src/hooks.server.js`. Runs **in-process** in the SvelteKit backend so it shares the live `notebook.js` doc + `kernel.js` — restarting the kernel can't drop the MCP session/document (the #1 requirement). Per-cell hide/show via `metadata.cellar.hidden_from_agent` (allowlisted, visible by default) is honored in every map/read/search/section/result. Kernel service methods `restartKernel/interruptKernel/kernelStatus` live in `kernel.js`; richer read/write (`listCells/getCell/setVisibility/moveCellTo`) in `notebook.js`.
- **Not yet built (deferred by design):** MCP `get_changes_since`/delta reads + subscribable-resource map, extract-to-`.py`, `.py` view, Databricks, git merge driver, per-output size threshold, LaTeX/math + code-block highlighting in rendered markdown, polished editing UX.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
