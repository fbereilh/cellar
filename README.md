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
Browser (Svelte UI)                     src/lib/Cell.svelte + src/routes/+page.svelte
  - one CodeMirror editor per cell; add / run / reorder / delete
  │  ▲
  │  │  /api/cells… (add, PATCH source, delete, move, clear)
  │  │  POST /api/cells/:id/run   (NDJSON: outputs stream back live)
  ▼  │
SvelteKit app (Node) — owns the CANONICAL notebook document
  - src/lib/server/notebook.js  in-memory doc, stable cell IDs, load/save
  - src/lib/server/clean.js     clean-on-save field policy (nbdev port)
  - src/lib/server/ipynb.js     deterministic nbformat 4.5 (de)serialization
  - src/lib/server/kernel.js    kernel client via @jupyterlab/services
  │  ▲                                    │
  │  │ Jupyter REST + WebSocket           ▼  writes notebook.ipynb (workspace)
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

## First-time setup

```sh
# 1. Node deps
npm install

# 2. Python sidecar (Jupyter kernel service) in a local venv
python3 -m venv .venv
./.venv/bin/pip install jupyter-server ipykernel
./.venv/bin/python -m ipykernel install --sys-prefix --name python3 --display-name "Python 3 (Cellar)"
```

## Run it

From any folder you want as the workspace:

```sh
node /path/to/cellar/bin/cellar.js
```

or, from within this repo:

```sh
npm run cellar
```

That single command:

1. starts the Jupyter kernel sidecar (headless, scoped to the current folder),
2. starts the SvelteKit server, and
3. opens your default browser to the UI.

Ctrl-C stops both servers.

Add `--build` to serve the production build (`npm run build` first) instead of
the Vite dev server.

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
