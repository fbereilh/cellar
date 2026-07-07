# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Current state: Phase 0 bridge spike

This repo currently holds only the **throwaway bridge spike** (spec Phase 0), not the product. Full product/tech spec lives outside the repo at `firstmate/data/cellar-spec.md`. See `README.md` for run/verify details.

- **Two runtimes.** Node (SvelteKit) + a Python sidecar (Jupyter kernel service) in `.venv/`. Both are booted by the CLI launcher `bin/cellar.js` (one command → both servers up → browser opens, workspace = cwd). `.venv/` is gitignored; recreate it via the setup steps in `README.md`.
- **Kernel bridge = the de-risked core.** `src/lib/server/kernel.js` connects to Jupyter over REST+WebSocket using `@jupyterlab/services` (the committed path from spec §2). Node 18+ global `fetch`/`WebSocket` are passed into `ServerConnection.makeSettings` — no `ws`/`node-fetch` polyfill needed.
- **Output streaming design.** `POST /api/execute` streams that run's IOPub events back as NDJSON in its own response body (one request = one execution = one stream). Deliberately no global SSE broadcast/subscriber set — an earlier broadcast design duplicated outputs across dev reconnects.
- **Kernelspec.** `python3` kernelspec must be registered into the venv (`ipykernel install --sys-prefix --name python3`), or `startNew({name:'python3'})` fails.
- **Not yet built (deferred by design):** save pipeline / `.ipynb`, stable cell IDs, MCP/agent interface, multi-cell UI, Databricks, `.py` view.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
