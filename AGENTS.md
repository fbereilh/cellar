# Cellar agent guide

This file loads into every agent session in this repo, so every line costs context on every task. Keep it short.

**Rule for editing this file.** Add or grow content here only when the repo owner explicitly asks for it. Put design notes, decision records, and per-feature detail in the topic files under `docs/dev-notes/` (index below), and add a line to the index only when you create a new topic file. Correcting or removing a statement here that has become false is always allowed. `tests/unit/agents-md-budget.test.ts` fails when this file passes 40,000 characters, links a missing file, or leaves a `docs/dev-notes/` note out of the index. It also fails when `CLAUDE.md` stops importing this file.

Why the rule exists: this file grew from 5 KB to 1 MB in four months because almost every feature PR appended a paragraph of design notes here. The detail now lives in `docs/dev-notes/`.

## What Cellar is

Cellar is a local, agent-first Jupyter notebook app. One command (`cellar`) in any project folder starts:

- a SvelteKit app (Node) that serves the notebook UI, owns the notebook documents, and runs an in-process MCP server for coding agents;
- a private Jupyter server (Python sidecar) that starts one kernel per notebook in the project's own virtualenv.

The human edits in the browser while agents read, write and run cells over MCP. Both see the same live document and kernel.

The full product spec lives outside the repo at `firstmate/data/cellar-spec.md`. Read its section 3 for the versioning model. `README.md` covers install and run for users.

## Repo layout

| Path | What lives there |
| --- | --- |
| `bin/cellar.js` | The launcher and CLI (`cellar`, `cellar mcp`, `cellar harness`, `cellar ls`, `cellar cleanup`, `--version`, `--update`). Committed executable (mode 100755). |
| `src/lib/server/` | Server side. `kernel.ts` (Jupyter bridge), `notebook.ts` (live documents), `run.ts` + `run-queue.ts` (execution), `ipynb.ts` + `clean.ts` (persistence), `mcp/` (agent surface), `databricks.ts`, `chat/`, `export-py.ts`, `git.ts`, `fstree.ts`. |
| `src/lib/server/*.js` | Node-builtins-only modules the launcher imports (`venv.js`, `runtime.js`, `instances.js`, `harness.js`, `ports.js`, ...). Listed in `package.json` `files`. Read that array, never a copy of it. |
| `src/lib/*.ts` | Browser-safe pure rules shared by server and UI (`cellLanguage.ts`, `staleness.ts`, `search.ts`, `virtualization.ts`, `cellSelection.ts`, `shortcuts.svelte.ts`, `sanitizeHtml.ts`, `markdown.ts`). |
| `src/lib/*.svelte` | UI. `LiveNotebook.svelte` owns one notebook's state, `Notebook.svelte` renders it, `Cell.svelte` is one cell, `Sidebar.svelte`, `Navbar.svelte`, `FileTab.svelte`. |
| `src/routes/+page.svelte` | The app shell: tabs, sidebar, kernel controls, theme. |
| `src/routes/api/` | REST + SSE routes (`cells`, `notebooks`, `kernel`, `fs`, `events`, `databricks`, `chat`, ...). |
| `tests/unit/` | Vitest suite. This is what CI's unit job and the no-mistakes gate run. |
| `tests/e2e/` | Playwright suite against the real launcher, real kernel and real browser. Shared helpers in `harness.ts`. |
| `scripts/` | Build guard, e2e runtime provisioning, changelog generator, large-notebook generator. |
| `docs/dev-notes/` | Design notes and decision records by topic. |
| `docs/design/` | Longer design documents (kernel-per-notebook, nbdev export directives). |
| `packaging/homebrew/cellar.rb` | Canonical Homebrew formula (HEAD-only). |

## Build, run, test

```sh
npm ci                     # install
make setup                 # install + build + chmod +x bin/cellar.js + npm link
make update                # git pull + install + build
npm run build              # production build into build/
npm run check              # svelte-check type check
npm test                   # vitest unit suite (~6s)
npm run test:e2e           # Playwright e2e; builds first when the build is stale
cellar                     # run in the current folder (prod build)
cellar --dev               # run with the Vite dev server
make changelog             # regenerate CHANGELOG.md
```

Requirements: Node `>=18` (CI pins 20), and `uv` on PATH. Cellar creates and installs into venvs only through `uv` and fails fast without it.

Testing rules:

- Never run a bare `npx playwright test`. Use `npm run test:e2e` or `npx playwright test <spec>`. The build guard runs from Playwright's `globalSetup` (`tests/e2e/global-setup.ts`), so both forms rebuild a stale build.
- Do not edit anything under `src/` while an e2e run is in flight. The build turns stale mid-run and every later spec fails with `production build is STALE`.
- e2e runs at `workers: 2` (`CELLAR_E2E_WORKERS`). Do not raise it and do not add `retries`.
- A few e2e failures in specs you did not touch are usually machine load. Re-run that spec file alone first. A real regression fails the same test every time.
- Every e2e spec that opens a notebook must settle before it probes: `await expect(openBtn.or(<cell locator>)).toBeVisible()` before any `isVisible()` check. Open sidebar sections through `harness.ts`'s `openSidebarSection`, and remove workspaces with `removeWorkspace(ws)`.
- `npm test` must run where `node_modules` exists. `.no-mistakes.yaml` runs `npm ci --prefer-offline` first for that reason.

Detail: [testing](docs/dev-notes/testing.md).

## Hard rules

These bind every change. The reasoning behind each lives in the linked note.

**Repo and process**

- Never hand-edit `CHANGELOG.md`. git-cliff generates it (`make changelog`).
- No bare `@word` in a commit message, PR title or PR body, and no bare `#number` in a commit subject or PR title. See `CONTRIBUTING.md` "Conventions".
- Keep `bin/cellar.js` executable (git mode 100755).

**Data safety**

- The `.ipynb` is the user's primary data. Writes are atomic (`atomic-write.ts`: temp file in the same folder, fsync, rename) and serialized per path (`write-lock.ts`). Persist stays synchronous.
- Clean-on-save is deterministic and idempotent. Keys are sorted like Python `json.dumps(sort_keys=True, indent=1, ensure_ascii=False)`. Cell and notebook metadata use deny-by-default allowlists in `clean.ts`. Widen a list only per key, on purpose. Opening a notebook never writes it.
- Runtime-only metadata (`lastRun`, `editedAt`, `importBindings`) is stripped on write AND on read through `clean.ts`'s `stripRuntimeMeta`. A run stamp may only come from an in-process run.
- `fstree.ts`'s `resolveInWorkspace` is the only authority for file paths. Do not widen it. Code roots outside the workspace grant a kernel cwd, never file access.
- Every `nb` argument resolves to an absolute path (`resolveNb` in `kernel.ts`, `resolveNotebookPath`). Maps are keyed by absolute path, and cell ids repeat across notebooks.
- Refuse, never degrade. When Cellar cannot do the thing a setting claims (an unusable code root, a raw or chat cell in a `.py` notebook, a mismatched export target), refuse with a reason. Never silently fall back to a different behavior.
- Report only what was observed. A message or status may not claim a cause, success or state that the code did not verify. Most of the per-feature notes exist because a message once said more than it knew.

**Kernel**

- Pass the global `WebSocket` to `ServerConnection.makeSettings` only when it exists. On Node below 22, omit the key so `@jupyterlab/services` falls back to `ws`.
- No two `requestExecute` calls on one kernel at once. Every `execute()` takes the per-kernel exec lock.
- The run watchdog probes on silence and never aborts on silence alone. Only a probe verdict may abort.
- Interrupt escalates: signal, grace window, then force-settle the watched runs. The signal may never gate the escalation.
- Set `kernel.commsOverSubshells = Disabled` before any comm opens.
- Kernel status broadcasts are deduped and coalesced. Do not publish on every busy/idle flip.

Detail: [kernel](docs/dev-notes/kernel.md), [runs and live sync](docs/dev-notes/runs-and-live-sync.md).

**UI**

- A `Cell` instance is disposable: windowing destroys and rebuilds it. Per-cell state that must outlive a scroll belongs in `LiveNotebook`, never in Cell-local `$state`. Never decide anything by walking the DOM for cells.
- Every scroll-to-cell, reveal or focus path goes through `LiveNotebook`'s `ensureCellMounted`. Do not add a second one.
- Focus follows the selection. Selection changes go through `selectAndFocus`/`selectAndAct`.
- All keyboard shortcuts are entries in `src/lib/shortcuts.svelte.ts` plus an action in `LiveNotebook`'s `actions` map. Nothing else binds a notebook key.
- Every rendered HTML from markdown or kernel output goes through `src/lib/sanitizeHtml.ts`. Import DOMPurify nowhere else.
- Rich `text/html` output renders in a sandboxed iframe with `allow-scripts` and never `allow-same-origin`.
- Editor theming is one static extension (`editorTheme.ts`) driven by CSS variables. Do not reintroduce a theme `Compartment`.
- Notebook surface colors are the `--cellar-surface-*` tokens. Git decoration colors are fixed palettes in `app.css`, not daisyUI tokens.
- Each notebook row sits inside a `<svelte:boundary>` so one bad output costs one cell, not the page.

Detail: [notebook UI](docs/dev-notes/notebook-ui.md), [virtualization](docs/dev-notes/virtualization.md), [keyboard and selection](docs/dev-notes/keyboard-and-selection.md).

**Cell types and languages**

- On disk a cell is nbformat `code`, `markdown` or `raw`. `sql` and `chat` are logical types: a `code` cell tagged `metadata.cellar.language`. `nbCellType` in `cellLanguage.ts` is the only logical-to-nbformat mapping.
- The notebook language (Python, Mojo, Rust) is notebook metadata. There is no per-cell `mojo` type. Absence means Python.
- Python-only engines (dataflow probe, staleness, import routing) ask `isPythonCodeCell` / `hasPythonDataflow`, never a negated list of other languages.
- Every run entry point refuses a non-code cell. Bulk runs skip chat cells and say so.
- A chat run never touches the kernel. The claude CLI argv is frozen per capability shape, and never uses the permissions-bypass flag.

Detail: [notebook document](docs/dev-notes/notebook-document.md), [notebook languages](docs/dev-notes/notebook-languages.md), [chat cells](docs/dev-notes/chat-cells.md), [staleness and SQL](docs/dev-notes/staleness-and-sql.md).

**Agents and MCP**

- `hidden_from_agent` is read through the single predicate `isHiddenFromAgent` in `src/lib/agentVisibility.ts`. Every read, search, digest and result honors it.
- `ran_this_session` comes from the session epoch on `lastRun`, never from whether a cell has outputs.
- Tool descriptions and `INSTRUCTIONS` cost tokens in every agent session. Keep them short, but never cut an honesty claim. Several descriptions have length tests.
- Agent writes target the session's pinned notebook, then the user's active notebook. Agent-opened notebooks never steal the user's focus.

Detail: [MCP](docs/dev-notes/mcp.md), [agent connection](docs/dev-notes/agent-connection.md).

**Databricks**

- Auth is the Databricks SDK's own profile auth. Never shell out to the `databricks` CLI.
- Agents may restore or connect a session, never start, stop or restart compute, and never drive the browser sign-in.
- Connecting a cluster leaves the Databricks runtime advertisement off and does not restart the kernel.

Detail: [Databricks](docs/dev-notes/databricks.md).

## Topic index

| Note | Covers |
| --- | --- |
| [launcher-and-runtime](docs/dev-notes/launcher-and-runtime.md) | Two runtimes, venv binding via `uv`, kernelspec, sidecar cwd, runtime venv control, stable ports, single instance per folder, reaping, `cellar ls` / `cleanup`. |
| [agent-connection](docs/dev-notes/agent-connection.md) | `cellar mcp` stdio bridge, `runtime.json`, re-attach after restart, harness config writers (`.mcp.json`, Codex TOML), the allow-list. |
| [kernel](docs/dev-notes/kernel.md) | Kernel bridge, run watchdog, reconnect ladder, restart handshake, interrupt escalation, `%restart_python`, Tab completion and docs tooltip, `func?` pager output, kernel lifecycle and memory. |
| [runs-and-live-sync](docs/dev-notes/runs-and-live-sync.md) | `run.ts` core, per-notebook run queue, queue snapshots, SSE live sync, follow-running-cell, edit flush, elapsed clock, streamed deltas, terminal output reduction. |
| [testing](docs/dev-notes/testing.md) | no-mistakes test step, e2e build guard, workers, CI sharding, runtime gate, flake triage, spec helper rules. |
| [release-and-conventions](docs/dev-notes/release-and-conventions.md) | Packaging, self-update, Homebrew formula, changelog generation, commit and PR text rules. |
| [code-roots](docs/dev-notes/code-roots.md) | Notebook code roots, git worktree roots, path namespaces, agent config in adopted worktrees, the root bar. |
| [notebook-document](docs/dev-notes/notebook-document.md) | Server-owned documents, persistence and clean-on-save, API, cell types, imports cell, inherited cell kind, jupytext `.py` notebooks, hide code, display settings. |
| [checkpoints](docs/dev-notes/checkpoints.md) | Checkpoint store, the two tiers, output sidecars, restore and undo. |
| [notebook-ui](docs/dev-notes/notebook-ui.md) | Cell UI, copy input/output, collapse, folding, directive highlighting, KaTeX, rendered links, row toggles, code block extraction, layout tokens, render error boundary. |
| [mcp](docs/dev-notes/mcp.md) | MCP tools, live vs persisted run status, images, ergonomics rules, per-session notebooks, user-activity digest, run tools and the queue. |
| [databricks](docs/dev-notes/databricks.md) | Connect and auth, re-auth, liveness and reconnect, panel states, logout, upload, default profile, Spark progress, `dbutils.widgets`, runtime toggle. |
| [export](docs/dev-notes/export.md) | nbdev `.py` and `.mojo` module export, export target and base, hazards, nbdev metadata protection, HTML export. |
| [staleness-and-sql](docs/dev-notes/staleness-and-sql.md) | Dataflow probe, staleness rules, import-binding exemption, bulk runs, notebook toolbar, SQL result binding. |
| [chat-cells](docs/dev-notes/chat-cells.md) | Chat cells, claude CLI engine, workspace reads confinement, tool lines, account slots, custom instructions. |
| [notebook-languages](docs/dev-notes/notebook-languages.md) | Python, Mojo (`%%mojo`, declaration carry-over, `.mojo` export), Rust on Evcxr. |
| [outputs](docs/dev-notes/outputs.md) | DataFrame grid, HTML-to-grid parsing, HTML table styling, ipywidgets. |
| [shell-and-sidebar](docs/dev-notes/shell-and-sidebar.md) | App shell, foreign-action refresh, navbar, sidebar sections, kernel cards, shell backend, sidebar Git section. |
| [file-tabs-and-tree](docs/dev-notes/file-tabs-and-tree.md) | File tabs, markdown and HTML previews, external edit sync, file tree, git decorations and blame, file management, drag moves, tab session and reordering. |
| [search](docs/dev-notes/search.md) | Search engine, find bar, in-place highlights, Ctrl/Cmd+F. |
| [keyboard-and-selection](docs/dev-notes/keyboard-and-selection.md) | Modal keyboard, shortcut registry, cut/copy/paste/undo, multi-cell selection, bulk ops. |
| [virtualization](docs/dev-notes/virtualization.md) | Windowed cell rendering, pinning, jump paths, scroll settling, print safety. |
| [deferred](docs/dev-notes/deferred.md) | Features deliberately not built yet. |

Also see `docs/design/kernel-per-notebook.md` and `docs/design/nbdev-export-directives.md`.
