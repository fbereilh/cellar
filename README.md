# Cellar — bridge spike (Phase 0)

A **throwaway proof-of-concept** proving the riskiest wiring for Cellar works
end-to-end:

> **SvelteKit (Node backend + Svelte UI) ↔ a headless Jupyter kernel ↔ the browser**

You run one command in a folder, a browser opens with a single code cell, you
type Python, hit **Run**, and outputs (stdout/stderr, results, tracebacks)
**stream live** back into the page.

This is **not** the product. No save pipeline, stable cell IDs, MCP/agent
interface, multi-cell management, Databricks, or `.py` view — those come later
(see `data/cellar-spec.md`). This just de-risks the bridge.

## Architecture (as built)

```
Browser (Svelte UI)                     one code cell, Run button, live output
  │  ▲
  │  │  POST /api/execute   (send code)
  │  │  GET  /api/stream    (SSE: outputs stream back live)
  ▼  │
SvelteKit app (Node)                    src/lib/server/kernel.js
  - single kernel connection via @jupyterlab/services (official JS client)
  - fans IOPub messages out to SSE subscribers
  │  ▲
  │  │  Jupyter REST + WebSocket protocol (token auth)
  ▼  │
Jupyter kernel service (Python sidecar) headless `jupyter_server`, one kernel
  │  ▲
  ▼  │  ZMQ
ipykernel (Python 3)
```

The committed architecture from spec §2/§4 — `@jupyterlab/services` in Node over
Jupyter's REST+WebSocket — works as-is. No fallback was needed.

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

Driven end-to-end in a real browser:

- `print('hello'); 6*7` → stdout `hello` and result `42` appear live.
- `1/0` → a `ZeroDivisionError` traceback renders.
- State persists across runs: `a = 6*7` then, in a second run, `a*2` → `84`.

See the commit message / status report for captured evidence.
