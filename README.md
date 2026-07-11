# Cellar

[![CI](https://github.com/fbereilh/cellar/actions/workflows/ci.yml/badge.svg)](https://github.com/fbereilh/cellar/actions/workflows/ci.yml)

**A Python notebook built for you and your AI agent to share.**

Cellar runs an interactive notebook in your browser on one shared Jupyter kernel, with a first-class agent interface built in. Open a folder and both you and an AI agent (like Claude Code) work the *same* live notebook: the agent adds and runs cells, and the results stream into your browser in real time. No copy-paste, no context handoff, no drift.

It saves ordinary `.ipynb` files that open in vanilla Jupyter, and it keeps them git-clean so your diffs stay meaningful.

## Why Cellar

- 🤝 **You and your agent, one notebook.** An agent's runs and edits appear live in your open tab (streaming output, run badges, structural changes), and your edits flow back the same way. You are never looking at stale state.
- ⚡ **One command, zero setup.** Run `cellar` in any folder. It resolves (or creates) the project venv with [`uv`](https://docs.astral.sh/uv/), starts the kernel, and opens your browser.
- 🔌 **Zero-config agent connection.** Cellar drops a `.mcp.json` in your workspace, so an agent opened in that folder connects automatically over MCP. Nothing to wire up.
- 🧹 **Git-friendly by design.** Clean-on-save strips volatile metadata and normalizes outputs, so re-running a notebook with the same results produces *no* git diff.
- 📊 **Rich outputs and data tools.** Matplotlib, Plotly, HTML, and full-size images render inline; inspect variables and preview DataFrames without leaving the page.
- 🧱 **Databricks, natively.** Point-and-click connect binds `spark` and a `WorkspaceClient` in the kernel and gives you a Unity Catalog browser.

## Install

**Homebrew (recommended).** Trust the formula once, then pick a channel:

```sh
brew trust --formula fbereilh/cellar/cellar    # one-time
```

**Stable** - the latest tagged release. Recommended for most people:

```sh
brew install fbereilh/cellar/cellar
```

**Latest** - tracks `main` for the newest work, for the adventurous:

```sh
brew install --HEAD fbereilh/cellar/cellar
```

> **Why trust?** Homebrew requires a one-time trust before it will load a third-party tap's formula; `--formula` trusts just this one (recommended). The install then auto-taps `fbereilh/cellar` for you, so there's no separate `brew tap` step.

```sh
cellar --update      # update to the newest version (install-method aware)
cellar --version     # show the version, sha, and install method
```

<details>
<summary>From a git clone (dev)</summary>

```sh
git clone https://github.com/fbereilh/cellar.git
cd cellar
make setup           # npm install + build + link `cellar` onto your PATH
```

`make update` (or `cellar --update`) pulls and rebuilds. See `make` with no target for all commands.
</details>

## Quick start

```sh
cd your-project
cellar
```

Your browser opens to a clean, empty workspace. Click **New notebook** (or open an existing `.ipynb` from the sidebar) and start writing and running cells. To bring in an agent, just open one (e.g. Claude Code) in the same folder - it auto-connects through the `.mcp.json` Cellar wrote, and you can watch it work alongside you.

`Ctrl-C` stops everything. Run `cellar ../other-repo` to open a different folder without `cd`-ing.

## Features

- **Code, Markdown, and SQL cells**, with a run queue, live run status, and staleness tracking so you always know what's fresh.
- **Rich outputs**: matplotlib, Plotly, rich HTML, and images you can double-click to view at natural size.
- **Run metadata** on every cell: when it last ran, how long it took, and who ran it (you or an agent).
- **Checkpoints and undo** for agent actions - snapshot before a risky change and roll back.
- **Command palette** for fast navigation and actions.
- **Variable and DataFrame inspection** to peek into the live kernel namespace.
- **Git blame and diff gutters** right in the editor.
- One shared kernel across notebooks, with a sidebar showing what's actually loaded in memory.

## Working with agents (MCP)

Cellar exposes an in-process **MCP server** that shares the live document and kernel with the UI. Point any MCP client at the stdio command:

```sh
claude mcp add cellar -- cellar mcp
```

(or just run `cellar` and let the auto-written `.mcp.json` do it). On connect, the agent gets a house-style doctrine that frames the work as building *one coherent notebook*, plus a rich tool set: read the notebook map and live kernel state, add/edit/move cells, and run them (`add_and_run` is the preferred write-and-execute flow). Because the MCP session is independent of the kernel connection, restarting the kernel never drops the agent's session or your document.

## Databricks

Open the sidebar's **Databricks** section, pick a profile and cluster, and click Connect. Cellar binds `spark` (a Databricks Connect session) and `w` (a `WorkspaceClient`) into the kernel, ready for `spark.read.table(...)`. A lazy Unity Catalog `catalog > schema > table` browser lets you click a table to drop a real, editable query cell into the notebook. Auth uses the SDK's own `~/.databrickscfg` profiles (PAT or OAuth) - no extra CLI required. Agents can see and query the connection too.

## Requirements

- **Node 18+**
- **Python 3.9+**
- **[`uv`](https://docs.astral.sh/uv/)** on your `PATH` (Cellar uses it for all venv and package management)

## Testing

Two layers, run with:

```bash
npm run test       # vitest unit suite  (fast, no browser, no kernel)
npm run test:e2e   # playwright smoke   (boots the real app + kernel; local)
```

- **Unit tests** (`tests/unit/`) guard the pure server logic — the crown jewel is
  clean-on-save: idempotent, git-clean round-trips, the metadata allowlist, memory-address
  scrubbing, and the notebook model (stable cell IDs, add/move/delete, duplicate-ID
  re-keying). These are the **must-pass gate and run on every PR in CI**.
- **E2E smoke** (`tests/e2e/smoke.spec.ts`, one spec) boots the real `cellar` launcher
  against a scratch workspace, runs `6*7`, asserts `42` renders, and confirms the saved
  `.ipynb` is valid. It needs the full kernel runtime (`uv` + `python3` + the cached
  host-venv), so it is a **local, best-effort** check and skips itself when that runtime is
  absent. CI does not provide the kernel runtime, so the E2E is not run there — the unit
  suite is what gates merges. Install the browser once with `npx playwright install chromium`.

## License

Released under the [MIT License](LICENSE).
