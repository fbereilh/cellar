# Team setup

How a teammate goes from a fresh clone to a running Cellar, plus every config knob
you might set. Cellar is designed to run with **zero configuration** - the defaults
below reproduce the standard behavior on any machine, so most of this document is
reference you only reach for when you want to deviate.

If you just want to *use* Cellar (not develop it), the Homebrew and Docker paths in
the [README](../README.md#install) are the shortest routes. This doc is the
clone-and-run path for contributors and teammates working from source.

## Prerequisites

Cellar has no machine-specific paths baked in: it discovers your home directory,
its own install location, and free ports at runtime. You only need the toolchain:

| Tool | Version | Notes |
| --- | --- | --- |
| **Node** | 18+ | Runs the SvelteKit app and the launcher. |
| **npm** | ships with Node | Installs JS deps and builds. |
| **Python** | 3.9+ | The kernel interpreter. Cellar never calls a system Python directly - it goes through `uv`. |
| **[`uv`](https://docs.astral.sh/uv/)** | recent | On your `PATH`. Cellar uses it for **all** venv creation and package installs (`uv venv`, `uv pip install`). Hard requirement - it fails fast if `uv` is missing (there is no `python -m venv` fallback). |

Nothing else is required. Cellar's own heavy Jupyter host environment
(`jupyter-server`) is created and cached under `~/.cellar/host-venv` on first run;
you do not install it yourself.

macOS and Linux are the primary targets. Windows path handling exists
(`Scripts/` vs `bin/`, resolved via `process.platform`) but is less exercised.

## Install and first run (from a clone)

```sh
git clone https://github.com/fbereilh/cellar.git
cd cellar
make setup          # npm install + build + chmod + npm link  (links `cellar` onto your PATH)
```

`make setup` is a convenience wrapper over the real commands - see the
[`Makefile`](../Makefile) (run `make` with no target to list them). It runs:

- `npm install` - JS dependencies,
- `npm run build` - the production SvelteKit server into `build/`,
- `chmod +x bin/cellar.js` - keep the launcher executable,
- `npm link` - put a `cellar` command on your `PATH`.

Then, from **any** project folder:

```sh
cd ~/some-project
cellar               # boots both servers, opens your browser, workspace = cwd
```

On this first run Cellar will, with your confirmation on a TTY:

1. Create `~/.cellar/host-venv` and install `jupyter-server` into it (cached; one-time).
2. Resolve (or create) the **project** venv for the kernel - see
   [Kernel / venv resolution](#kernel--venv-resolution) below.
3. Ensure `ipykernel` is present in the project venv, and best-effort install
   `ipywidgets` (a soft feature dependency for Databricks-style parameter
   widgets and other interactive widgets - it never prompts, and a failure is a
   quiet no-op rather than an error).
4. Start the Jupyter sidecar and the app, allocate free ports, and open the browser.

`Ctrl-C` shuts everything down cleanly. `cellar ../other-repo` opens a different
folder without `cd`-ing. Pass `--yes` (or run under `$CI` / a non-TTY) to
auto-approve the venv create/install prompts.

### Without a global `npm link`

If you would rather not link, run the launcher directly:

```sh
npm run build && node bin/cellar.js          # production build
node bin/cellar.js --dev                      # Vite dev server (hot reload)
```

`make dev` is the second command. `make run` is the first, but rebuilds only when
the build is stale (via `scripts/ensure-build.js`) instead of unconditionally.
Note that a production launch refuses a **stale** build (built before your latest
`src/` edit), not just a missing one: run `npm run build` (or `make run`, which
does it for you), pass `--dev`, or set `CELLAR_SKIP_BUILD_CHECK=1` to override.

## Kernel / venv resolution

Cellar binds the kernel to **your project's** interpreter, not a global one. On
launch it resolves the venv in this order and uses the first match:

1. `--venv <path>` flag, or the `CELLAR_VENV` env var - an explicit choice.
2. `$VIRTUAL_ENV` - a venv you have already activated in the shell.
3. `<workspace>/.venv` - a project-local venv, if it exists.
4. Otherwise it **creates** `<workspace>/.venv` (via `uv venv`, after confirming).

`--python <interpreter>` binds an arbitrary interpreter without creating or
installing anything. You can also change the environment at runtime from
**Settings → Python environment** in the UI.

Because the kernel runs in the project venv, `import`s, `os.getcwd()`, and
relative file reads all resolve inside your project - exactly as if you had
launched Jupyter there yourself.

## Connecting an agent (MCP)

Running `cellar` writes (or idempotently merges) a `.mcp.json` into the workspace
with a `cellar` stdio entry, so an agent opened in that folder auto-connects.
Because the MCP port is chosen dynamically per run, agents are pointed at the
**stdio command** `cellar mcp`, never a fixed URL - so nothing to reconfigure when
ports change:

```sh
claude mcp add cellar -- cellar mcp
```

Pass `--no-mcp-config` to `cellar` to opt out of writing `.mcp.json`. The raw
Streamable-HTTP endpoint (for an HTTP-capable client) is
`http://127.0.0.1:<CELLAR_MCP_PORT>/mcp`; the live port is shown in the launcher
banner and in the sidebar's **Connect an agent** panel.

## Databricks

Databricks auth is the SDK's own profile auth - Cellar shells out to nothing and
bundles no CLI. It reads profiles from `~/.databrickscfg` (override the location
with the standard `DATABRICKS_CONFIG_FILE` env var). In the sidebar's
**Databricks** section, pick a profile and cluster and click Connect; Cellar binds
`spark` and a `WorkspaceClient` (`w`) into the kernel. Cellar hands the profile
straight to the SDK, which authenticates it however it is configured - a **PAT**,
or a `databricks-cli` / keyring / cached-OAuth token - so most profiles connect
with no sign-in step. The one profile shape gated behind an in-browser sign-in is
a no-token `auth_type = external-browser` profile (as is a hand-typed host, below).
`databricks-connect` must be no newer
than the cluster's DBR (a newer client hard-fails the session); Cellar installs
it into the project venv on connect, pinned to the cluster's DBR major.minor, and
re-pins a matching client automatically if a mismatch would otherwise surface.

A teammate with **no** `~/.databrickscfg` can still type a workspace host in the UI
and sign in through the browser - a config file is not required to get started.

Once you connect, the **Databricks** panel shows the cluster name and connection
status. If a session goes idle or otherwise drops, a **Reconnect** button restores it against the
cluster you already chose - the same one-click recovery agents and the automatic
expiry self-heal use, so it may briefly restart the kernel (and wipe its
namespace) when a `databricks-connect` re-pin is needed.

Once connected, the **Databricks** section shows two cards - a **Cluster** card
(the connection identity plus Switch/Disconnect, or Reconnect when a session
dropped) and a separate **Runtime** card carrying the **Databricks runtime**
toggle (on by default for a connected notebook). The runtime setting advertises
`DATABRICKS_RUNTIME_VERSION` in the kernel so pasted Databricks-notebook code that
gates on `IS_DATABRICKS` takes its interactive `dbutils.widgets` path instead of a
local CLI fallback. Because that gate is read at import time, the setting is
applied by **restarting the kernel** - so connecting (or switching) a cluster
auto-enables the runtime and restarts the kernel for you, and toggling the Runtime
card likewise restarts immediately (which clears the kernel namespace). No manual
"restart to apply" step. Force the setting (and the advertised version) headless
with `CELLAR_DATABRICKS_RUNTIME` / `CELLAR_DATABRICKS_RUNTIME_VERSION` (see the
reference below).

**Disconnect vs Log out.** Disconnect ends that notebook's Spark session and
leaves you authenticated. **Log out** - the quiet button under the Cluster card's
Switch/Disconnect row - also signs you out: it disconnects every bound notebook
app-wide (so no leftover reconnect intent silently rebuilds `spark` later),
deletes the OAuth token Cellar's own browser sign-in minted (the Databricks SDK's
python-local cache, `~/.config/databricks-sdk-py/oauth/`), and clears Cellar's
in-process sign-in state, so the next connect has to authenticate again. It never
touches credentials that are not Cellar's: `~/.databrickscfg` profiles, OS keyring
entries and the databricks CLI's own token cache are left alone - for a PAT or
`databricks-cli` profile there is simply nothing of Cellar's to purge, and the
panel says so rather than implying a purge that never happened. Because it signs
out everywhere, it asks you to confirm first; the button is hidden when Cellar
holds no saved sign-in anywhere to clear, except while connected, where it still
ends the sessions. If any part of it does not provably complete - a cached token
that could not be deleted or found, a notebook whose session could not be ended -
it reports the sign-out as **incomplete** instead of clean, and says what to finish
by hand. There is no agent/MCP equivalent: signing out, like the sign-in browser,
stays a human action.

## Configuration reference (environment variables)

All of these are optional. **Unset = the standard behavior**; set one only to
deviate. Ports default to a **free ephemeral port** chosen per run (so concurrent
`cellar` instances never collide) - pin them only when you need a predictable port
to publish, e.g. inside a container.

### Ports and networking

| Variable | Default | Purpose |
| --- | --- | --- |
| `CELLAR_APP_PORT` | free ephemeral | Fix the browser/app port (e.g. to publish it from Docker). |
| `CELLAR_MCP_PORT` | free ephemeral (fallback `39587`) | Fix the MCP HTTP port. |
| `CELLAR_JUPYTER_PORT` | free ephemeral | Fix the Jupyter sidecar port. |
| `CELLAR_MCP_HOST` | `127.0.0.1` | Interface the MCP server binds. Set `0.0.0.0` to expose it (containers). |
| `CELLAR_NO_BROWSER` | unset | `1`/`true`/`yes` skips auto-opening the browser. |

### Kernel and venv

| Variable | Default | Purpose |
| --- | --- | --- |
| `CELLAR_VENV` | auto-resolved | Bind the kernel to a specific project venv (same as `--venv`). |
| `CELLAR_KERNEL_IDLE_TIMEOUT` | `7200` (s, = 2h) | Idle-cull an entire kernel process after N seconds of inactivity. `0` disables culling. |
| `CELLAR_KERNEL_CULL_INTERVAL` | `min(300, timeout)` (s) | How often the idle culler runs. |
| `CELLAR_KERNEL_IDLE_TIMEOUT_MS` | `30000` (ms, = 30s) | Per-run watchdog: how often a silent running cell has its kernel probed for liveness. **Not a deadline** - a silent cell whose kernel probes healthy runs indefinitely, and only the probe's verdict aborts a run: the kernel is gone from the Jupyter server or reports itself dead (aborts on the first probe), or the kernel's reply can no longer reach us on 3 consecutive probes (the websocket has given up reconnecting, or it is connected yet the kernel is not executing our cell). A probe that fails or times out, and a websocket that is still reconnecting, are inconclusive: the watchdog just probes again - unless the websocket has ALSO given up, which is corroborated proof the kernel is unreachable by any route and aborts on 3 consecutive such probes. `0` disables the per-run watchdog entirely (a genuinely wedged kernel then frees its slot only on manual Restart); a positive value overrides the probe interval. Distinct from the culler above. |
| `CELLAR_KERNEL_PROBE_TIMEOUT_MS` | `10000` (ms, = 10s) | How long one liveness probe (a localhost `GET /api/kernels/<id>`, normally ~3-5ms) may take before it is abandoned as inconclusive. An abandoned probe does not abort a run on its own; the watchdog just probes again (unless the websocket has also given up - see above). |
| `CELLAR_KERNEL_RECONNECT_TIMEOUT_MS` | `15000` (ms, = 15s) | How long a dead-socket self-heal (rebuild the kernel websocket without restarting the process or clearing its namespace, after the watchdog convicts a `disconnected` socket) may take before it is abandoned. A timeout is non-fatal: the reconnect keeps trying in the background and a later run retries, so nothing is lost. |
| `CELLAR_MAX_KERNELS` | `8` | Soft cap: shows a warn-only banner past N live kernels (never blocks a run). `0` disables the warning. |
| `CELLAR_KERNEL_MEMORY_POLL_MS` | `4000` (ms, = 4s) | How often each live kernel's resident memory (RSS) is measured host-side (via `ps`) and re-broadcast to the UI. The timer is unref'd and self-stops when no kernel remains; a value is only re-published when the whole-MiB figure changes. |

### MCP session lifecycle

| Variable | Default | Purpose |
| --- | --- | --- |
| `CELLAR_MCP_SESSION_IDLE_MS` | `1800000` (30 min) | Reap an idle MCP session after this long. |
| `CELLAR_MCP_REAPER_INTERVAL_MS` | `300000` (5 min) | How often the MCP session reaper runs. |

### Advanced / rarely set

| Variable | Default | Purpose |
| --- | --- | --- |
| `CELLAR_ISOLATED` | unset | Run with no global instance registry and no cross-instance reaping (what the Docker image sets). |
| `CELLAR_SKIP_BUILD_CHECK` | unset | `1` serves a **stale** production build anyway (a source checkout otherwise refuses to launch when `build/index.js` is older than `src/`). A packaged install never checks. `--dev` bypasses the check too. |
| `CELLAR_KERNEL_STATUS_DEBOUNCE_MS` | `80` | Debounce window for kernel-status broadcasts to the UI. |
| `CELLAR_DATAFLOW_PROBE_TIMEOUT_MS` | `10000` (ms, = 10s) | How long the staleness dataflow probe subprocess (`ast` + `symtable` over the notebook's cells) may run before it is SIGKILLed. A batch that times out is treated as conservative-stale, never falsely fresh. |
| `CELLAR_DATAFLOW_BACKOFF_BASE_MS` | `30000` (ms, = 30s) | First backoff window after a dataflow batch times out; doubles per consecutive timeout. A timed-out batch is not re-probed until its window elapses or its source content changes, so a persistently-slow notebook converges instead of re-spawning the probe every pass. |
| `CELLAR_DATAFLOW_BACKOFF_MAX_MS` | `300000` (ms, = 5min) | Ceiling on the dataflow backoff window, so a persistently-slow notebook still re-probes rarely rather than never. |
| `CELLAR_ADD_PROJECT_ROOT` | UI setting | Force whether the project root is added to the kernel's `sys.path` (overrides the persisted UI toggle). |
| `CELLAR_DATABRICKS_RUNTIME` | UI setting (default on for a connected notebook) | Force whether `DATABRICKS_RUNTIME_VERSION` is advertised in the kernel environment, so `IS_DATABRICKS`-gated notebook code takes its `dbutils.widgets` path. Overrides the persisted UI toggle and bypasses the connected-notebook scope. Applied at kernel start/restart only. |
| `CELLAR_DATABRICKS_RUNTIME_VERSION` | `15.4` | The runtime version string advertised when the toggle above is on (overrides the persisted UI value). |
| `CELLAR_JUPYTER_URL` | `http://127.0.0.1:8888` | Point the kernel bridge at an external Jupyter server (the launcher sets this automatically for the managed sidecar). |
| `CELLAR_JUPYTER_TOKEN` | `` (empty) | Token for an external Jupyter server. |
| `DATABRICKS_CONFIG_FILE` | `~/.databrickscfg` | Standard SDK variable for the Databricks config location. |
| `BODY_SIZE_LIMIT` | `512K` | adapter-node's app-wide cap on a request body, which is what bounds how large a file a tab may **save** (reading is unaffected - a 15 MB HTML export still opens and previews). Cellar deliberately leaves it alone, since raising it raises how much memory any request can make the server buffer; a document that would not fit opens view-only instead. Set it (e.g. `2M`) to widen the editable range - the app reports the value actually in force to each file tab. `cellar --dev` runs Vite, which applies no body cap at all. |

> **Internal, do not set by hand:** `CELLAR_WORKSPACE`, `CELLAR_KERNELSPEC_DIR`,
> `CELLAR_PROJECT_VENV`, `CELLAR_LAUNCHER_PID`, and `CELLAR_KEYS` are set by the
> launcher for the child processes it spawns. Setting them yourself will confuse
> the runtime.

### Docker-only

These are read by the container [entrypoint](../docker/entrypoint.sh), not the
launcher directly (see the [README's Docker section](../README.md#run-with-docker)):

| Variable | Default | Purpose |
| --- | --- | --- |
| `CELLAR_REQUIREMENTS` | unset | Path to a requirements file installed into the baked kernel venv at container start (no rebuild). |
| `CELLAR_MCP_CONFIG` | `0` | `1` writes a `.mcp.json` inside the container (for an agent running *in* the container). |

## Verify your setup

```sh
npm run build     # production build (must be green)
npm run check     # svelte-check - must report 0 errors
npm run test      # unit suite - the merge gate
```

`npm run test:e2e` is a best-effort local smoke test that boots the real launcher,
runs `6*7`, and asserts `42` renders; it needs the full kernel runtime
(`uv` + `python3` + the cached host-venv) and skips itself when that is absent.
It rebuilds the app first when `build/` is older than `src/` (the specs serve the
production build, so a stale one would silently test uncompiled code) and runs two
spec files at a time. Install its browser once with `npx playwright install chromium`.

## Troubleshooting

- **`uv: command not found` / venv errors** - install [`uv`](https://docs.astral.sh/uv/)
  and make sure it is on your `PATH`. It is a hard requirement.
- **`cellar: command not found` after `make setup`** - the `npm link` symlink needs
  the launcher's executable bit; `make setup` re-`chmod`s it. Re-run `make setup`,
  or run `node bin/cellar.js` directly.
- **`production build is STALE` / `production build not found`** - a production
  launch serves `build/index.js`, and refuses to run it against newer `src/`. Run
  `npm run build` (or `make run`, which rebuilds only when stale), pass `--dev` for
  the Vite dev server, or set `CELLAR_SKIP_BUILD_CHECK=1` to serve the stale build
  anyway. A packaged install (npm/brew/Docker) never triggers this.
- **Port already in use** - Cellar picks free ports by default, so this only
  happens if you pinned `CELLAR_APP_PORT` / `CELLAR_MCP_PORT` / `CELLAR_JUPYTER_PORT`.
  Unset them to let Cellar choose.
- **A stale/duplicate instance in a folder** - `cellar ls` lists instances,
  `cellar cleanup` reaps orphans (`--all` stops every live one). A relaunch in a
  folder takes over its previous instance automatically.
- **A run aborted with "Restart the kernel to recover"** - the per-run watchdog
  aborts only when a probe proves the kernel can no longer answer: it is gone from
  the Jupyter server, reports itself dead, or its reply cannot reach us. A slow,
  silent cell (a Spark query, a big pandas op) is never aborted for being silent,
  however long it runs. Restart the kernel from the sidebar's Kernels section, and
  see `CELLAR_KERNEL_IDLE_TIMEOUT_MS` above - set it to `0` to disable the per-run
  watchdog entirely if you hit a false abort.
- **A file tab says "view-only · too large to save"** - the document is larger than a
  save request may carry (`BODY_SIZE_LIMIT`, `512K` by default), so Cellar opens it
  read-only rather than offering an edit it could never persist. Reading, syntax
  highlighting, and the rendered preview are unaffected. Raise `BODY_SIZE_LIMIT`
  (see above) if you need to edit it.
- **A file will not open: "file too large to open"** - a text file is capped at
  **2 MB**, with one exception: `.html`/`.htm` get **15 MB**, because a self-contained
  export (plotly with the inlined bundle, bokeh `INLINE`, an nbconvert report) is
  routinely bigger than the ordinary cap. Saving enforces the same ceiling, so a
  save can never land bytes the tab would refuse to reopen.
- **The status bar says "too large for blame"** - line-level git decorations (the
  blame line and the change bars) are skipped above 2 MB, since blaming a multi-MB
  file costs seconds on the same thread that carries kernel streaming, SSE, and MCP.
  The file itself opens and previews normally; only the per-line decorations are absent.
- **An `.html` preview says "This page loads files stored next to it"** - the preview
  is origin-isolated (it cannot read the app's DOM, cookies, or storage), and the cost
  of that isolation is that a page pulling sibling files off disk
  (`<script src="report_files/x.js">`) cannot load them, so the page renders without
  them. Re-export the file self-contained (e.g. plotly's `include_plotlyjs=True`,
  bokeh's `INLINE`, `jupyter nbconvert --embed-images`) and it renders in full.
- **A run aborted with "The kernel connection is being refreshed; re-run the cell"** -
  the kernel websocket died (its reconnect retries were spent) while the process
  itself is still alive. Cellar rebuilds the socket in the background without
  restarting the kernel or clearing its namespace, so you can simply re-run the cell;
  no manual restart is needed. See `CELLAR_KERNEL_RECONNECT_TIMEOUT_MS` above.
