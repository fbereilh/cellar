# Cellar — MVP Step 1 (notebook document + save pipeline)

Built on the Phase 0 bridge spike (SvelteKit ↔ Jupyter kernel ↔ browser, which
works as-is — `@jupyterlab/services` in Node over Jupyter's REST+WebSocket, no
fallback needed). Step 1 turns the single cell into a real **notebook document**
with a **git-friendly clean-on-save pipeline**.

You run one command in a folder; a browser opens the notebook (a real
`notebook.ipynb` in that folder). Add/run/reorder/delete code cells; outputs
stream live and persist. The file is a real Jupyter notebook that opens in
vanilla Jupyter, and re-running with identical results produces **no git diff**.

Deferred to later steps: MCP/agent interface, extract-to-`.py`, `.py` view,
Databricks, the git merge driver, polished editing UX (see `data/cellar-spec.md`).

## Architecture (as built)

```
Browser (Svelte UI)                     +page.svelte shell → LiveNotebook → Cell.svelte
  - one CodeMirror editor per cell; add / run / reorder / delete
  │  ▲
  │  │  /api/notebooks (open live doc / set active), /api/cells… (add,
  │  │  PATCH source, delete, move, clear) — each carries the target `nb` path
  │  │  POST /api/cells/:id/run   (NDJSON: outputs stream back live)
  ▼  │
SvelteKit app (Node) — owns the notebook document(s)
  - src/lib/server/notebook.js  in-memory docs keyed by path (default + any
                                opened .ipynb), stable cell IDs, load/save
  - src/lib/server/clean.js     clean-on-save field policy (nbdev port)
  - src/lib/server/ipynb.js     deterministic nbformat 4.5 (de)serialization
  - src/lib/server/kernel.js    kernel client via @jupyterlab/services
  │  ▲                                    │
  │  │ Jupyter REST + WebSocket           ▼  writes each doc to its own .ipynb
  ▼  │                                  real .ipynb (opens in vanilla Jupyter)
Jupyter kernel service (Python sidecar) headless jupyter_server, one kernel
  │  ▲
  ▼  │  ZMQ
ipykernel (Python 3)
```

**Clean-on-save** (spec §3, nbdev port): every save nulls all `execution_count`,
keeps outputs, strips all metadata except an allowlist (cell: the `cellar`
namespace; notebook: `kernelspec` — drops `language_info`/`widgets`), normalizes
`kernelspec.display_name`, and scrubs `<… at 0x…>` memory addresses. Idempotent.

## Requirements

- Node 18+ (built/tested on Node 26; uses global `fetch`/`WebSocket`)
- Python 3.9+
- [`uv`](https://docs.astral.sh/uv/) on your `PATH` — Cellar uses it for **all**
  virtualenv creation and package installs (`uv venv`, `uv pip install`). It is
  a hard requirement; if it is missing, `cellar` fails fast with an install
  hint rather than falling back to `python -m venv`/`pip`. `uv` discovers or
  downloads a suitable CPython itself, so you do not need a system `python3` for
  the created venvs.

## Install

Cellar ships as an npm package. From a clone:

```sh
npm install
npm run build     # emits the adapter-node production server into build/
npm link          # makes `cellar` available on your PATH (or: npx .)
```

`npm run build` also runs automatically on `npm pack`/`npm publish`
(`prepack`/`prepublishOnly`).

### Quick start / updating (Makefile)

A root `Makefile` wraps the commands above. Run `make` (no target) to list them.

```sh
make setup     # first-time install: npm install + build + chmod +x bin/cellar.js + npm link
make update    # pull the latest, reinstall deps, and rebuild
```

`make setup` links `cellar` onto your PATH once; that link persists across
rebuilds, so `make update` (pull → install → build) is all you need to move the
already-linked `cellar` to the new version. See `make run` / `make dev` to run.

## Run it

From **any project directory** you want to open as the workspace:

```sh
cellar                    # opens the current directory
cellar ../other-repo      # or: cellar --workspace ../other-repo
```

That single command:

1. **Resolves the project's Python venv** — first match wins:
   `--venv`/`$CELLAR_VENV` → active `$VIRTUAL_ENV` → `<workspace>/.venv` → else
   **create** `<workspace>/.venv` (with `uv`). It ensures `ipykernel` is present
   there, installing it if missing. The kernel then runs in **that** interpreter.
2. Ensures Cellar's own private Jupyter host env (`~/.cellar/host-venv`, holding
   the heavy `jupyter-server`), created and cached on first run — so your project
   `.venv` only ever gets the lightweight `ipykernel`.
3. Starts the Jupyter sidecar (host env, kernel bound to the project python via a
   per-run kernelspec) and the SvelteKit server, then opens the browser. The
   app, Jupyter, and MCP ports are all allocated dynamically, so multiple
   `cellar` instances in different repos run side by side. The resolved app +
   MCP URLs are printed on startup.

**One instance per folder.** Rerunning `cellar` in a folder that already has a
live instance does **not** start a rival server - two servers would each persist
`notebook.ipynb` from independent in-memory docs and silently clobber each
other's edits. Instead the second launch attaches to the running one (opens the
browser to it and exits). Ownership is claimed atomically via a
`.cellar/instance.lock` file, so even a rapid double-launch can't start two.
Pass `--new` (alias `--force`) to deliberately start a second, independent
instance for the same folder (power-user escape hatch).

Creating a `.venv` or installing `ipykernel` into your project **prompts for
confirmation** on a TTY (printing exactly what will run); reusing an existing
venv that already has `ipykernel` is silent.

Flags:

| Flag | Effect |
|---|---|
| `[path]` / `--workspace <dir>` | Open another directory without `cd`-ing |
| `--venv <dir>` (or `$CELLAR_VENV`) | Use this venv verbatim (created if missing) |
| `--python <path>` | Escape hatch: bind an arbitrary interpreter, no create/install |
| `--yes` / `-y` | Auto-approve venv create / ipykernel install (implied when non-interactive / `$CI`) |
| `--dev` | Run the Vite dev server instead of the production build |
| `--no-mcp-config` | Do not write/merge `<workspace>/.mcp.json` (see [Zero-config agent connection](#zero-config-agent-connection-cellar-mcp)) |
| `--new` / `--force` | Start a second, independent instance in a folder that already has a live one (normally a relaunch attaches to the running instance) |

There is also a `cellar mcp` subcommand (the stdio ↔ HTTP MCP bridge) — see
[Zero-config agent connection](#zero-config-agent-connection-cellar-mcp).

You can also switch or create the bound venv at runtime from **Settings → Python
environment** in the app; it re-resolves/creates via `uv` and rebinds the kernel.

Ctrl-C stops both servers.

## Agent interface (MCP)

Cellar exposes an **MCP server** (the agent interface, spec §4) in-process in the
backend, over Streamable HTTP:

```
http://127.0.0.1:<mcpPort>/mcp      # port printed on startup; the launcher
                                    # allocates a free one per instance and
                                    # passes it via CELLAR_MCP_PORT
```

Because it shares the live notebook document + kernel with the UI and is
independent of the kernel connection, **restarting the kernel never drops the
MCP session or the document**. Connect any MCP client (e.g. the MCP Inspector,
or `@modelcontextprotocol/sdk`'s `StreamableHTTPClientTransport`) to that URL.

An **agent-driven run reflects live in any already-open browser tab** — the
running indicator and streaming outputs appear with no reload, pushed over a
Server-Sent Events stream (`src/lib/server/events.js` → `/api/events`). Runs
from another browser tab sync the same way. **Structural changes sync live too**:
an agent adding, editing, deleting, moving, or retyping a cell patches the open
notebook in place, and `create_notebook` opens the new notebook in a tab with no
reload. A remote edit to a cell you are actively typing in never clobbers your
input — it surfaces a "Changed on server" affordance with a Load button instead.

### Zero-config agent connection (`cellar mcp`)

The HTTP port changes every launch, so a URL in agent config goes stale. Instead
point the agent at the **stdio command `cellar mcp`**, which never carries a port:

- On launch, `cellar` writes `<workspace>/.cellar/runtime.json` (the live
  `{ mcpPort, appPort, pid }`, ephemeral — gitignored, removed on shutdown) and
  writes/merges `<workspace>/.mcp.json` with a `cellar` stdio server entry. So
  **just run `cellar`, then an agent opened in that repo (e.g. Claude Code)
  auto-connects** via the written `.mcp.json` — no config editing, ever. The
  merge preserves any other servers you already have; pass `--no-mcp-config` to
  opt out of writing it.
- To register once by hand (any project): `claude mcp add cellar -- cellar mcp`.
- `cellar mcp` discovers the running instance from `.cellar/runtime.json`,
  verifies it is alive, and transparently bridges stdio ↔ the live HTTP `/mcp`
  server. With no running cellar in the directory it fails fast with a clear
  error and non-zero exit (it never launches a headless instance).

On connect the server hands the agent a house-style **coherence doctrine** (the
MCP `instructions`, delivered once) that frames the work as building one coherent
notebook — imports at the top, check `kernel_state` before writing, continue the
narrative via `get_notebook_map`, structure with markdown. The same text is also
exposed as the `cellar_notebook_style` prompt.

Tools (all UUID-addressed; all honor per-cell `cellar.hidden_from_agent`):
lifecycle (`restart_kernel`, `interrupt_kernel`, `kernel_status`,
`list_notebooks`, `open_notebook`, `create_notebook`); read (`get_notebook_map`
= section tree from markdown headers, `kernel_state` = live namespace bucketed
into imports/functions/classes/variables, `read_cell`/`read_cells`,
`read_by_location`, `read_section`, `search_cells`, `get_errors`,
`get_full_output` with medium/full tiering); write (`add_cell`/`add_cells`,
`edit_cell`, `delete_cell`, `move_cell`, `set_cell_type`,
`set_cell_visibility`); execute (`run_cell`, `run_cells`, `run_all`,
`run_range`).

## What was verified

Driven end-to-end in a real browser (and the saved `.ipynb` inspected):

- Multiple code cells run; outputs (stdout/stderr, results, tracebacks) stream
  live and persist to `notebook.ipynb`.
- Restarting `cellar` in the same folder restores all cells **and** outputs.
- Cross-cell state persists (`a = 6*7` in one cell, `a*2` → `84` in another).
- Saved `.ipynb`: valid nbformat 4.5, no `execution_count`, outputs present,
  stable unique cell IDs, the `cellar` cell-metadata placeholder preserved, no
  `language_info`.
- Idempotent clean-on-save: re-running all cells with identical results yields
  an empty `git diff` (a fresh `<… at 0x…>` address each run scrubs to the same
  value).
- Duplicate/missing cell IDs in a loaded file are re-keyed to unique slugs.

See the commit message / status report for captured evidence.
