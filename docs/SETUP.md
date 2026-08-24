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
its own install location, and the ports it needs at runtime. You only need the
toolchain:

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

1. Ask which **other** AI coding harnesses to wire up to its MCP server (Claude
   Code is already set up for you) - see
   [Connecting an agent](#connecting-an-agent-mcp). The question only ever
   *adds*: pressing Enter turns nothing off.
2. Create `~/.cellar/host-venv` and install `jupyter-server` into it (cached; one-time).
3. Resolve (or create) the **project** venv for the kernel - see
   [Kernel / venv resolution](#kernel--venv-resolution) below.
4. Ensure `ipykernel` is present in the project venv, and best-effort install
   `ipywidgets` (a soft feature dependency for Databricks-style parameter
   widgets and other interactive widgets - it never prompts, and a failure is a
   quiet no-op rather than an error).
5. Start the Jupyter sidecar and the app, resolve their ports (an ordinary launch
   re-uses the app/MCP ports this folder had last time, when they are still
   free - see [Ports and networking](#ports-and-networking)), and open the browser.

`Ctrl-C` shuts everything down cleanly. `cellar ../other-repo` opens a different
folder without `cd`-ing. Pass `--yes` (or run under `$CI` / a non-TTY) to
auto-approve the venv create/install prompts; the harness question is *skipped*
rather than auto-answered there, so nothing is decided for you (use
`cellar harness add` when you want it).

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

### Code roots (several checkouts, one instance)

A notebook may declare a **code root**: a directory - normally a git worktree -
that *its* kernel runs in and imports from, so one instance can serve several
checkouts of the same repo:

```sh
git worktree add roots/pr-482 some-branch        # inside the workspace
git worktree add ../winrate-model-pr398 some-branch   # a sibling checkout
```

Pick it in the **Code root** bar at the top of the notebook, in the sidebar **Git**
section's **Worktrees** block (**Use as root**), or let an agent set it
(`use_notebook(name, root)`; `list_roots` shows what is available). It is stored
as `metadata.cellar.root` in the `.ipynb`, so it survives a reload and stays
git-clean.

**A root outside the workspace must be a registered worktree of the workspace's
own repo.** That is the whole admission rule for an outside directory: `git
worktree list`, run in the workspace, has to name that exact directory - so the
set of directories Cellar will accept is the set *you* created with `git worktree
add` against this repo. A worktree of some other repo, an arbitrary path, and a
checkout that *contains* the workspace are all refused, by name. Give it either
the absolute path `git worktree add` printed or a `../`-relative one; Cellar
stores the `../`-relative form, so the notebook stays portable to any machine
that reproduces the layout. Everything below applies to roots inside and outside
the workspace alike.

The bar is hidden by default - **Settings → Show the code root bar** turns it on -
so a workspace that never adopts roots gains no new UI, even in a repo with
worktrees of its own. The one exception is what makes that default safe: a notebook
that actually declares a root always shows the bar, a root missing on disk
included, so a kernel is never running somewhere nothing on screen explains or can
clear. Until you turn it on, the sidebar's **Worktrees** block is where you find
your worktrees, and it needs no toggle. Detected worktrees fill the picker whenever
the bar is shown; that list is read the first time the bar becomes visible, so
flipping the toggle populates it with no reload, but reload the tab if you created
the worktree after the bar was already up (the sidebar block refreshes on its own).

A root moves exactly two things: the kernel process's working directory and the
entry Cellar adds to its `sys.path`. Everything else stays workspace-wide - the
file tree, git, search, checkpoints, `.cellar/`, and **the interpreter**: a root
never changes which venv the kernel runs, so all of the resolution above is
unaffected. A notebook that declares no root behaves exactly as before. That holds
for an external worktree too, and it is the surprising half: your kernel runs in
the sibling checkout while the file tree still shows the workspace. A root grants
no file access, so nothing Cellar serves - the tree, a file tab, an agent's reads
and writes - follows it into that worktree.

Four things worth knowing before you set one:

- **Changing a root frees that notebook's kernel** (a process's working directory
  is fixed when it spawns), so its variables are cleared and its cells read "not
  run this session". Re-declaring the root a notebook already has is a no-op, in
  either spelling of the same directory.
- **A root that is not a usable directory is refused**, by name and with the
  repair, rather than quietly falling back to the workspace - a notebook must
  never claim to run against a checkout it is not running against. The same check
  runs when the kernel starts: if it somehow came up somewhere other than the
  declared root, the start fails instead of importing from the wrong checkout.
- **Adopting an external worktree writes Cellar's agent config there** - see the
  next subsection.
- **A `.py` (jupytext / Databricks source) notebook cannot hold one.** It is
  written back from its cells alone and stores no notebook-level metadata, so the
  picker is not shown and setting a root is refused; convert it to `.ipynb` first.
  Clearing a root is always allowed.

Worktrees under `roots/` are untracked files in the outer checkout - add `roots/`
to that repo's `.gitignore` if you would rather not see them (Cellar does not edit
your `.gitignore`). Git decorations for files *inside* a root are read from the
outer checkout, so they may be wrong or absent.

The one surface that reads a root's OWN checkout is the sidebar's **Git** section:
one row per open notebook, naming the code root it runs from and that checkout's
branch, short SHA, commit subject and date, with a dot when it has uncommitted
changes. Under those rows, a **Worktrees** block lists every checkout `git worktree
list` reports - one per row, the ones outside the workspace tagged `external`, each
with a **Use as root** button that points the notebook you are looking at at it.
A worktree that is registered but whose directory is gone says *missing on disk*
and offers no button, because a kernel rooted there would be refused anyway. Both
are read-only otherwise - they report where each kernel's code comes from and do
not stage, commit, push, or switch branches - and the section is collapsed by
default, running `git` only while it is open. Clicking a notebook row focuses that
notebook's tab.

#### Agent config in an adopted worktree

An agent working in a review notebook runs its own tools with that notebook's root
as the working directory, so once the root is a worktree *outside* the workspace it
can no longer find this Cellar: `cellar mcp` resolves the instance from its own cwd
and does not walk up. So **setting an external worktree as a root writes Cellar's
agent config into that checkout** - one file per harness this workspace has set up
(`.mcp.json` for Claude Code, `.codex/config.toml` for Codex), each naming this
instance with `--workspace <path>` so the bridge reaches it from there.

Four things bound that write:

- It happens only when a notebook is actually **pointed at** the worktree, never
  when one is merely listed in the picker or by `list_roots`.
- Each file is paired with an entry in that repository's `.git/info/exclude`,
  written first, so the checkout never shows it as an untracked change and a
  `git add -A` cannot commit it onto the branch under review. Git keeps that file
  per clone rather than per worktree, so the entries cover the top level of every
  worktree of that repo and its main checkout; it is never committed, so no
  collaborator inherits them.
- An existing `cellar` entry that says something else is left alone and reported as
  skipped - a worktree you also run Cellar in keeps pointing at its own instance.
- It can never break a root change: anything that fails (a read-only checkout, a
  config Cellar will not rewrite, an exclude it could not arrange) is reported back
  on the root-bar feedback line, in the sidebar, and to agents on `agent_config`.

Turn it off with **Settings → Set up agents in adopted worktrees**; `--no-mcp-config`
also suppresses the `.mcp.json` half for that launch, and only harnesses this
workspace allow-lists are written at all (`cellar harness list`).

## Connecting an agent (MCP)

Connecting an agent means registering one stdio MCP server - `cellar mcp` - in
whatever config file that agent reads. The command is the same everywhere; only
the file and its format differ, which is exactly why configuring one harness does
nothing for another:

| Harness | Config file | Format |
| --- | --- | --- |
| `claude` (Claude Code) | `<workspace>/.mcp.json` | JSON (`mcpServers`) |
| `codex` (OpenAI Codex) | `<workspace>/.codex/config.toml` | TOML (`[mcp_servers.cellar]`) |

Because the MCP port belongs to a running instance rather than to the folder's
config, agents are pointed at the **stdio command**, never a fixed URL - so there
is nothing to reconfigure when the port changes. The equivalent manual step for
Claude Code is:

```sh
claude mcp add cellar -- cellar mcp
```

`cellar mcp` is a *bridge*, not a standalone server: it attaches to the Cellar
instance running in that workspace. So a configured harness gets Cellar's tools
only while `cellar` is running there.

**Restarting Cellar does not mean restarting the agent.** A restart replaces the
instance and every MCP session with it, but the bridge outlives that: it
re-attaches to whatever instance serves the folder next and re-does the handshake
itself, so the agent's next tool call just works - no reconnect, no host
intervention, whether or not the port moved. If nothing is running in the folder,
calls fail with a message naming the `cd <workspace> && cellar` that fixes it and
the bridge keeps waiting, so it heals once Cellar is back (only a bridge that
finds no instance at *startup* exits, non-zero). A request that was **in flight**
when the instance went away is answered with an error saying its result can never
be delivered and that the call may or may not have been applied - deliberately
never re-sent, since re-sending a write could apply it twice.

### Which harnesses Cellar manages

Cellar keeps a per-workspace **allow-list** of harnesses it may configure, stored
in the (gitignored) `.cellar/harness.json`. On **every** start it reconciles that
list: each allowed harness's config is checked and repaired if the entry is
missing, stale, or was deleted. So the wiring is a standing instruction, not a
one-off write - delete `.mcp.json` and the next `cellar` puts it back.

**Claude Code is on the list by default**, which is what makes the zero-config
`.mcp.json` self-healing; a workspace with no marker behaves exactly as it always
has. Scope is deliberately per-workspace, not global: which agent you point at a
project is a property of that project, so a fresh clone gets the defaults rather
than another machine's answer.

The first run in a folder offers to *also* wire up the harnesses that are not on
the list yet (and asks once more if a later Cellar learns to configure one it
could not before). Answer with the listed numbers or names, or `yes` / `all` for
everything offered. The question can only **add**: a bare Enter, an explicit no, a
typo, a closed stdin, a 30s timeout, and a backgrounded `cellar &` are all
harmless and turn nothing off - they only differ in whether the question is asked
again next time. It is never asked without a TTY (`--yes`, `$CI`, or piped
stdin). `Ctrl-C` at the question is the one keystroke that does more: it stops the
launch, recording nothing, so the next run asks again.

### `cellar harness`

The explicit, any-time counterpart to that prompt (it never boots a server, and
honors `--workspace <dir>`):

```sh
cellar harness list                  # what Cellar manages here + each config's state
cellar harness add codex             # manage a harness and configure it now (claude | codex | all)
cellar harness remove codex          # stop managing it; its config entry is LEFT in place
cellar harness remove codex --strip  # …and also remove that entry
```

`list` prints two independent facts per harness - *managed here* and *configured
right now* - because the gap between them is exactly what the next start repairs.
`remove` and `--strip` are separated on purpose: "stop managing this" and "delete
this from my config" are different requests, and only one edits your file
(`--strip` takes the whole `cellar` entry, including anything nested under it such
as a `[mcp_servers.cellar.env]` table). Removing a harness also settles the
first-run question for it, so it is not offered back - `cellar harness add` is how
it returns. A harness Cellar refuses to configure (see below) makes `add` exit
non-zero, so a scripted `add all` cannot report success having configured nothing.

### What a write does, and does not, touch

These files are yours - they hold your other MCP servers and, for Codex, settings
like `model` or `approval_policy` - so every write **merges** into the existing
file, replaces it atomically (preserving its mode, and following a symlink rather
than replacing it with a regular file), and is idempotent: an already-correct
entry is left alone, whatever its formatting. The merge reaches inside the
`cellar` entry too, so keys you added beside `command`/`args` (`env`, `type`,
`cwd`) survive. Anything Cellar cannot edit confidently - an unreadable file, a
`cellar` server defined in another legal TOML form - is **refused** with a
one-line explanation instead of being rewritten.

Codex reads project config only for a project you have **trusted**; that trust
lives in your global `~/.codex/config.toml` and widens Codex's sandbox, so Cellar
deliberately does not write it - approve the folder when Codex asks.

Pass `--no-mcp-config` to `cellar` to skip writing/repairing `.mcp.json` for that
launch only; it never changes the allow-list, and the sidebar's **Connect an
agent** panel says the repair is paused rather than claiming a self-heal that is
not happening. It covers the whole launch, so no `.mcp.json` is written into an
[adopted worktree](#agent-config-in-an-adopted-worktree) either (a harness whose
config is a different file, such as Codex, is unaffected). The raw Streamable-HTTP endpoint (for an HTTP-capable client) is
`http://127.0.0.1:<CELLAR_MCP_PORT>/mcp`; the live port is shown in the launcher
banner and in that same panel.

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
namespace) when a `databricks-connect` re-pin is needed. A kernel restart itself -
from the Runtime toggle, the Kernels sidebar, `%restart_python` or an autorestart -
does not show that dropped-session warning: the panel says it is reconnecting while
the session is rebuilt, and only reports the session as lost if the rebuild
actually fails.

Once connected, the **Databricks** section shows three cards - a **Cluster** card
(the connection identity plus Switch/Disconnect, or Reconnect when a session
dropped), an **Upload** card (the notebook upload and its naming fields, described
below), and a separate **Runtime** card carrying the **Databricks runtime**
toggle (**off by default**). The runtime setting advertises
`DATABRICKS_RUNTIME_VERSION` in the kernel so pasted Databricks-notebook code that
checks whether it is running on Databricks takes its interactive `dbutils.widgets`
path instead of a local CLI fallback. Because that gate is read at import time, the
setting is applied by **restarting the kernel**, which clears the kernel namespace -
and advertising a runtime changes what *every* library believes about its
environment (mlflow's `is_in_databricks_runtime()` reads the same variable). So it
is an explicit opt-in: connecting - or switching - a cluster deliberately does *not*
enable it and does not restart on its own. A connect binds `spark`/`w` in the
running kernel and keeps your variables, unless the client has to be re-pinned to
the cluster's DBR (that does restart).

The card's state badge reports the **running kernel**, not the preference you just
set: `active` when the live session really carries the variable, `pending` when it
does not - a kernel started without it offers **Apply now**, which restarts it
exactly as the toggle does, and with no kernel yet the next start picks the setting
up - and `off` otherwise. Force the setting headless with
`CELLAR_DATABRICKS_RUNTIME`, and the advertised version with
`CELLAR_DATABRICKS_RUNTIME_VERSION` (either can be set without the other; see the
reference below) - the card then says the environment is in control and disables the
control that override holds, since no toggle or restart can change it.

**An agent can read and set it too.** Whether a kernel advertises a runtime decides
which branch a notebook's own `IS_DATABRICKS` gate takes, and a notebook full of
`dbutils.widgets` reads identically either way - so the agent tools that describe a
notebook (`databricks_status`, `kernel_state`, `get_notebook_map`) all carry a
`runtime: {advertised, version, forced_by_env}` block taken from the **running
kernel**, exactly like the card's badge. `databricks_runtime(enable, version?)` sets
it: the same preference, the same restart, the same "every variable is cleared" cost,
reported back as `kernel_restarted` / `namespace_cleared` so the agent knows to re-run
its cells. It restarts only when the state really changes, so re-enabling what is
already advertised costs nothing; enabling on a notebook with no Databricks session
stores the preference and says nothing is advertised yet rather than restarting to
change nothing; and while `CELLAR_DATABRICKS_RUNTIME` holds the decision the call is
refused (`runtime_env_forced`), since no restart could move it. Connecting a cluster
still advertises nothing - that reversal is exactly the assumption an agent forms on
connecting, so it is spelled out in the doctrine it is given.

The preference is per workspace, so an agent turning it on also governs what your
other connected notebooks advertise at their next kernel start (only the notebook it
addressed restarts now). The card's toggle follows the stored preference rather than a
snapshot taken when the panel mounted, so a change an agent makes shows up there with
no reload. The version field is the one exception, since it is a field you may be
typing in: a version an agent set shows there only after a reload. That stays cosmetic
because only a deliberate edit of that field writes it - flipping the toggle, or
**Apply now**, moves the advertisement alone and applies whatever version is stored -
and the badge reports the running kernel throughout.

**Library code that resolves credentials for itself.** Cellar connects with an
*explicit* profile, so the identity behind `spark` and `w` lives inside Cellar's own
`Config` and nowhere a second resolution can look. Your own library therefore starts
from zero: a bare `WorkspaceClient()`, or the `from databricks.sdk.runtime import ...`
that builds one while the module body runs, resolves credentials exactly as it would
with no Cellar involved. Two things follow.

A connected kernel carries `DATABRICKS_CLUSTER_ID`, published *after* the session is
built - the connect scrubs every `DATABRICKS_*` variable first, since
databricks-connect refuses to build a remote session while it believes it is on a
runtime. A later bare `DatabricksSession.builder.getOrCreate()` therefore hands back
the session you already have, instead of failing with "Cluster id or serverless are
required but were not specified", and it costs no extra compute. Every connect
rewrites it (a connect that fails leaves none behind) and disconnect removes it, so a
stale id can never point later code at a cluster you are no longer on. Cellar
deliberately does *not* export `DATABRICKS_CONFIG_PROFILE`: which profile a process
falls back to is a machine-wide choice, and it is not Cellar's to make.

Credentials are the half Cellar cannot supply for you, so it detects the gap instead.
If `~/.databrickscfg` marks no profile as the default - no `[__settings__]
default_profile` and no `[DEFAULT]` section carrying keys - or marks one the SDK
refuses (a name the file does not define, or the reserved `__settings__` itself), then
code resolving credentials for itself fails, with `cannot configure default
credentials` or with the SDK's own error for a default it cannot use, while Cellar's
own `spark` keeps working - which reads as a Cellar bug and is not one. A **default
profile** card then appears at the top of the Databricks section, on a connected (or
expired) notebook, carrying one ready-to-copy `databricks auth switch --profile <name>`
command per profile you could choose. It is a heads-up rather than an error: nothing
failed, and your connection is unaffected. Cellar shows the command and does not run
it - it shells out to no CLI, it never writes your credential config, and which
profile becomes the machine default is your call, so nothing in that list is
pre-selected. A machine that already resolves a default, or one with no profile to
offer, sees nothing at all.

**Parameter widgets and the SDK import.** Cellar binds its own `dbutils` in every
kernel, so `dbutils.widgets.text(...)` and `.get(...)` draw real controls and read
back the value you typed, with or without a Databricks connection. Library code
written to run both on and off a cluster usually reaches for
`from databricks.sdk.runtime import dbutils` rather than the bare name, so while a
runtime is advertised Cellar points that import at the same widgets - otherwise the
SDK's own object answers it, and that one rebuilds each widget at its default every
time a cell re-declares it, silently discarding what you entered while still drawing
the controls. If Cellar finds that import holding anything other than its own
widgets, the Databricks panel says so (on the Runtime card, and on the Cluster card
when no session is live) and a kernel restart rebinds it. It only ever reports what
it could check: with no kernel, a busy one, or no advertised runtime, it stays quiet
rather than guessing.

**Upload the open notebook to your workspace.** While connected, the **Upload**
card - its own card between Cluster and Runtime, since this acts on workspace files
and never on compute - carries an **Upload notebook to workspace** button (the
connection controls, Switch/Disconnect/Log out, stay on the Cluster card). It copies
the notebook you have open into your own Databricks folder - `/Users/<you>/<name>`,
where the user folder comes from the connected identity (`current_user.me()`) rather
than anything you type, and the name is the file's basename with the extension
dropped (optionally wrapped in the prefix/postfix described below), since Databricks
names a workspace notebook by its path segment. It imports in **JUPYTER** format, so the notebook
lands with its cells intact instead of being flattened into one `.py` script; a
`.py` jupytext or Databricks-source notebook is uploaded as a proper `.ipynb`,
built from the live document so it matches what Cellar saves on disk. It
authenticates through the connection you already made - the same
`WorkspaceClient` every listing uses, so an expired profile reports the same
`databricks auth login --profile <name>` remedy as everywhere else - and it is a
**workspace-files** operation only: it never starts, stops or restarts a cluster (a
connection is needed only to identify the workspace and the user). Nothing is
overwritten silently: the first attempt sends no overwrite flag, so a notebook
already at that path comes back untouched and the panel asks you to confirm a
**Replace**, while a path occupied by something that is not a notebook is refused
rather than offered as a replace. A successful upload shows the workspace path and
an **Open in Databricks** link. A notebook whose JSON is larger than ~7 MB is
refused before anything is sent (the workspace import API accepts roughly 10 MB of
base64 content); clearing the outputs, which are what make a notebook that large, is
the fix.

**Naming the upload (prefix / postfix).** Two optional fields above the button wrap
the notebook's own name, so a file can land as `2026-08-05_analysis` or
`analysis_20260805` without renaming it first. Both may carry date tokens -
`{YYYY-MM-DD}`, `{YYYYMMDD}`, `{YYYY-MM}`, `{YYYYMM}`, `{YYYY}`, `{MM}`, `{DD}` -
which expand against the **local** date and are **case-sensitive** (so `{mm}`,
minutes by every other convention, can never silently mean the month); there are
deliberately no time-of-day tokens, and anything else in braces is left literal, so
a typo shows up in the preview instead of vanishing from the name. The braces are
**required** (a bare `MM` would turn `march` into `03arch`), so the vocabulary sits
in a **dropdown beside each field**, listing every token next to what it becomes
today. Picking one inserts its exact braced form into *that* field - the control
names the field, rather than writing into whichever one you happened to be in last -
at the caret, beside what you have typed and never over it, so both affixes stay
free text. A field you have not typed in yet has no caret you chose, so the token
appends to the end of it. A short line under the fields keeps saying that the tokens
exist and that the braces are part of them, since a closed dropdown is not something
you find before typing; it steps aside when the warning below has something more
specific to say. A braced run that is *not* a token is named in a warning under
the preview ("`{mm}` is not a date token - it uploads exactly as written"), because
a literal left literal in silence reads like a token that has not expanded yet
rather than one that never will; it stays a warning and never a refusal, since
`{FOO}` may be exactly what you meant. The panel previews the resolved name as you
type, and that preview is exactly what the workspace receives - the
browser and the server share one rule (`$lib/databricksUploadName`), and the browser
expands the tokens at click time so the two cannot disagree even across midnight.
Because a Databricks workspace notebook carries no suffix, the postfix attaches to
the extension-less stem: `analysis.ipynb` plus `_{YYYYMMDD}` is `analysis_20260805`,
never `analysis.ipynb_20260805`. Leave both empty and the upload is exactly what it
was before: `/Users/<you>/<basename-without-extension>`. An affix that could move
the upload out of your own folder - a `/`, a `\` or a control character - is
**refused** with the reason on screen and the button disabled, rather than quietly
cleaned up into a name the preview never showed; so is a prefix/postfix combination
that pushes the assembled name past 200 characters. A **Replace** confirm always
overwrites the path it named: the affixes it resolved with are pinned when it arms,
so a date token rolling over between the two clicks cannot redirect it, and typing
in either field dismisses the confirm (and the previous attempt's result) rather
than leaving a path on screen this panel would no longer upload to. Your last-used
prefix and postfix are remembered per project in the workspace's `.cellar/` store,
so a regular naming pattern survives a relaunch.

**A default prefix/postfix for every project.** If you stamp every upload the same
way, set it once in **Settings → Default Databricks upload name** instead of once
per repo. It takes the same tokens and the same not-a-token warning as the sidebar's
fields - offered here as a row of clickable chips writing into the field you were
last in, rather than the sidebar's per-field dropdown, this pane having the width for
them - and it is stored **per user, not per project** - in
`~/.cellar/settings.json`, beside the instance registry and the host
venv, so it outlives both the workspace and the relaunch that changes the app port
(`CELLAR_USER_SETTINGS` redirects that file; see the reference below). The
direction is fixed and is the point: **a project that has set its own prefix or
postfix always wins**, and the default only fills in for a project that was never
asked - changing it never rewrites naming you set deliberately somewhere else. A
Databricks panel already open in this Cellar picks the change up with no reload; a
Cellar running in another project picks it up on its next page load. Clearing a
**project's** field is itself an answer ("no prefix here"), so that project opts
out of the default rather than inheriting it again; clearing the **default** simply
removes it. What is stored either way is the raw pattern with its tokens
unexpanded, so tomorrow's upload gets tomorrow's date. An affix that could never be
uploaded (a slash, a backslash or a control character) is refused rather than
stored - the field keeps what you typed, with the reason on screen and the last
usable default left untouched. The 200-character ceiling is *not* applied here: it
bounds an assembled name, and a default meets a different notebook name in every
project, so it stays where the upload itself is previewed.

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
deviate. Pin a port only when you need a predictable one to publish, e.g. inside a
container - see [Ports and networking](#ports-and-networking) for what an unset
port does.

### Ports and networking

A folder **remembers the ports it got** and asks for them again next launch (in
the gitignored `<workspace>/.cellar/ports.json`), so the browser tab or bookmark
you left open still works after a restart. The app and MCP ports are remembered;
the Jupyter sidecar port is not, since only the launcher and the app ever see it.

A remembered port is a *preference*, re-earned on every launch and never a claim:
Cellar takes it only when nothing else has it, and **never reclaims it** from
another running instance - it falls back to a fresh ephemeral port instead, then
remembers that one so the next restart is stable again. Any such move is printed
with its cause, so a changed address is never silent. Isolated (`CELLAR_ISOLATED`)
and `--new` launches exist so concurrent instances cannot collide, so they neither
read nor write the preference: an unpinned port there is always ephemeral (a pin
still wins everywhere, which is why the Docker image can publish fixed ports).

An explicit pin always wins, is used verbatim (never probed - it fails loudly at
`listen()` if it is busy), and is deliberately **not** remembered, so it cannot
outlive the run that asked for it.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CELLAR_APP_PORT` | this folder's last app port, else free ephemeral | Fix the browser/app port (e.g. to publish it from Docker). |
| `CELLAR_MCP_PORT` | this folder's last MCP port, else free ephemeral (app fallback `39587`) | Fix the MCP HTTP port. |
| `CELLAR_JUPYTER_PORT` | free ephemeral (never remembered) | Fix the Jupyter sidecar port. |
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

### Chat cells

| Variable | Default | Purpose |
| --- | --- | --- |
| `CELLAR_CHAT_TIMEOUT_MS` | `300000` (ms, = 5 min) | Wall-clock bound on one chat run before its `claude` child is killed. |
| `CELLAR_CHAT_MAX_PROMPT_BYTES` | `600000` (~600 KB) | Largest transcript a chat run will send. Over it the run is **refused** (never truncated), naming the size and the two levers - clear outputs, or hide cells from AI. |
| `CELLAR_CHAT_SLOTS` | `~/.cellar/claude` | Directory holding Cellar's own Claude account slots (each is a `CLAUDE_CONFIG_DIR`). Point it elsewhere to keep a test run away from your real accounts. |
| `CELLAR_CHAT_LOGIN_RETAIN_MS` | `60000` (ms, = 60s) | How long a finished-but-unread sign-in attempt stays pollable before it is swept. |

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
| `CELLAR_DATABRICKS_RUNTIME` | UI setting (default off) | Force whether `DATABRICKS_RUNTIME_VERSION` is advertised in the kernel environment, so notebook code that checks whether it is running on Databricks takes its `dbutils.widgets` path. It is also what makes `from databricks.sdk.runtime import dbutils` resolve to Cellar's own widgets instead of the SDK's value-discarding ones. Overrides the persisted UI toggle and bypasses the connected-notebook scope; the sidebar then reports the setting as environment-controlled and disables the toggle, and an agent's `databricks_runtime` call is refused (`runtime_env_forced`) rather than restarting a kernel to change nothing. Applied at kernel start/restart only. |
| `CELLAR_DATABRICKS_RUNTIME_VERSION` | `15.4` | The runtime version string advertised when the runtime is on. Overrides the persisted UI value (and disables the card's version field), independently of `CELLAR_DATABRICKS_RUNTIME` - either can be set without the other. Unlike that one it refuses nothing: a version an agent passes to `databricks_runtime` is stored as the preference and reported back as overridden, so it takes effect once this is unset. |
| `CELLAR_USER_SETTINGS` | `~/.cellar/settings.json` | Path of the cross-project user-settings file (today: the default Databricks upload prefix/postfix, and the chat-cell account slot, model, and the web-search / workspace-reads / other-notebooks opt-ins). Point it elsewhere to keep those settings with a dotfile setup, or to isolate them in a test run. Per-project state stays in each workspace's own `.cellar/` and is unaffected. |
| `CELLAR_JUPYTER_URL` | `http://127.0.0.1:8888` | Point the kernel bridge at an external Jupyter server (the launcher sets this automatically for the managed sidecar). |
| `CELLAR_JUPYTER_TOKEN` | `` (empty) | Token for an external Jupyter server. |
| `DATABRICKS_CONFIG_FILE` | `~/.databrickscfg` | Standard SDK variable for the Databricks config location. |
| `BODY_SIZE_LIMIT` | `512K` | adapter-node's app-wide cap on a request body, which is what bounds how large a file a tab may **save** (reading is unaffected - a 15 MB HTML export still opens and previews). Cellar deliberately leaves it alone, since raising it raises how much memory any request can make the server buffer; a document that would not fit opens view-only instead. Set it (e.g. `2M`) to widen the editable range - the app reports the value actually in force to each file tab. `cellar --dev` runs Vite, which applies no body cap at all. |

> **Internal, do not set by hand:** `CELLAR_WORKSPACE`, `CELLAR_KERNELSPEC_DIR`,
> `CELLAR_PROJECT_VENV`, `CELLAR_LAUNCHER_PID`, `CELLAR_NO_MCP_CONFIG` (the
> launcher's own `--no-mcp-config` flag, passed through so the sidebar can say the
> `.mcp.json` repair is paused and so an adopted worktree gets no `.mcp.json`
> either), and `CELLAR_KEYS` are set by the launcher for the
> child processes it spawns. Setting them yourself will confuse the runtime.

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
- **Port already in use** - Cellar yields rather than fights for a port, so this
  only happens if you pinned `CELLAR_APP_PORT` / `CELLAR_MCP_PORT` /
  `CELLAR_JUPYTER_PORT`. Unset them to let Cellar choose. A *remembered* port that
  something else has taken is not an error: Cellar says so, picks a fresh one, and
  remembers that instead.
- **An agent doesn't see Cellar's tools** - run `cellar harness list` in the
  project: it shows whether Cellar manages that harness here and whether its
  config registers `cellar` right now. `cellar harness add <name>` fixes both (and
  keeps it fixed - managed harnesses are repaired on every start). If the config
  is correct, check that `cellar` is actually **running** in that folder: `cellar
  mcp` bridges to a live instance and does not start one. For Codex, also approve
  the project when it asks - it ignores project config for an untrusted folder.
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
- **A notebook will not run: "Notebook root ... does not exist in this workspace"** -
  it declares a [code root](#code-roots-several-checkouts-one-instance) whose
  directory is gone or misspelled (a worktree you removed, or a hand-edited
  `metadata.cellar.root`). Cellar refuses to start the kernel rather than silently
  running the notebook at the workspace root. Re-create the directory
  (`git worktree add <root> <branch>`) or clear the root in the notebook's
  **Code root** bar - a missing root is still listed there, marked `(missing)`,
  so you can select the workspace and carry on.
- **A root outside the workspace is refused** - each refusal names its own repair,
  so read the message rather than guessing. *"is not a registered git worktree of
  this repository"*: only a worktree of the workspace's own repo is admitted, so
  create it with `git worktree add <path> <branch>` and confirm with `git worktree
  list` (the message also names the worktrees Cellar can see). *"is a registered
  worktree but its directory no longer exists"*: run `git worktree prune`, or
  re-create it. *"that worktree was moved to ..."*: `git worktree move` leaves the
  old path registered nowhere - point the notebook at the new path Cellar names
  (Cellar will not rewrite your `.ipynb` for you). *"it CONTAINS the workspace"*:
  you pointed at the checkout the workspace lives inside, which would run the
  kernel above the tree Cellar is serving - pick a sibling worktree instead.
- **The kernel refuses to start: "started in ... but its declared code root is ..."** -
  the kernel came up somewhere other than the worktree the notebook declares, so
  Cellar fails the start instead of letting imports resolve from the wrong
  checkout. Check the root directory still exists (`git worktree list`), or clear
  the notebook's root to run at the workspace root.
- **Cellar wrote `.mcp.json` into another checkout** - that is the
  [adopted-worktree agent config](#agent-config-in-an-adopted-worktree): pointing a
  notebook at a worktree outside the workspace wires an agent working there back to
  this instance. It is added to that repo's `.git/info/exclude`, so it is never
  committed. Turn it off with **Settings → Set up agents in adopted worktrees**;
  files already written stay until you delete them.
- **"Cannot set a code root on a .py notebook"** - a jupytext / Databricks source
  notebook is written back from its cells alone and stores no notebook-level
  metadata, so a root could not survive a reload. Convert it to `.ipynb` (app menu
  → **Convert to .ipynb**) if you need one; clearing a root is always allowed.
- **Your own `WorkspaceClient()` fails with "cannot configure default credentials"
  while Cellar's `spark` works** - Cellar passes its profile explicitly, so its
  identity is not this machine's default; code that resolves credentials for itself
  finds none because `~/.databrickscfg` marks no profile as the default. The
  Databricks panel's **default profile** card names the fix - see
  [Databricks](#databricks).
- **Parameter widgets render but keep coming back at their defaults** - the code is
  reaching the Databricks SDK's own `dbutils` rather than Cellar's, and the SDK's one
  rebuilds a widget from scratch every time a cell re-declares it, so the value you
  typed is gone before the same cell reads it. The Databricks panel says so when it
  can see it. Cellar points `from databricks.sdk.runtime import dbutils` at its own
  widgets only while a Databricks runtime is advertised, so turn the **Runtime**
  toggle on (or set `CELLAR_DATABRICKS_RUNTIME`) and restart the kernel - the rebind
  happens at kernel start, and it also covers an import that has not happened yet.
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
- **An open file tab didn't update when an agent (or another editor) changed the file** -
  Cellar watches the files you have open and applies an external change in place, so
  this should be immediate; if you had unsaved edits it waits behind a Reload / Keep
  mine banner instead of overwriting them. Three cases fall back to refreshing when
  you switch back to the browser window: a file over **2 MB** (re-reading and hashing
  a multi-MB file on every write would cost the same thread that carries kernel
  streaming, SSE, and MCP), a filesystem where directory watching is unavailable
  (some network mounts and container overlays), and more than **64** files open at
  once - the coldest stop being watched. Notebooks (`.ipynb`, and jupytext `.py`
  opened as notebooks) are not covered at all yet: reopen the tab to pick up an
  edit made to one outside Cellar.
- **An `.html` preview says "This page loads files stored next to it"** - the preview
  is origin-isolated (it cannot read the app's DOM, cookies, or storage), and the cost
  of that isolation is that a page pulling sibling files off disk
  (`<script src="report_files/x.js">`) cannot load them, so the page renders without
  them. Re-export the file self-contained (e.g. plotly's `include_plotlyjs=True`,
  bokeh's `INLINE`, `jupyter nbconvert --embed-images`) and it renders in full.
- **A wide HTML table output has its own sideways scrollbar** - rich `text/html`
  output (a pandas `Styler`, a table from `IPython.display.HTML`) gets comfortable
  padding and alignment by default, and a table too wide for the output area
  overflows into that output's own horizontal scroll instead of being squeezed.
  Text columns still wrap, and the notebook page itself never scrolls sideways.
  Anything you style yourself (`set_table_styles`, `set_properties`, an inline
  `style`) overrides those defaults, so you keep full control of a table you have
  styled.
- **A table from another library looks oddly aligned, or lost its grid lines** - those
  defaults apply to *every* table in rich `text/html` output, not just pandas ones, so
  a library's own `_repr_html_` (statsmodels' `summary()`, dask's array summary) picks
  them up too. Three cosmetic side effects are accepted: a table that declares no
  `<thead>` gets no header rule and its header row reads left-aligned like an index
  column; a label/value layout table whose cells hold plain text inherits the numeric
  right-align (a cell holding a paragraph, list, or other block content keeps normal
  left alignment); and Cellar drops the default table border, so `<table border="1">`
  no longer draws a grid. Style the table yourself - an inline `style`, a stylesheet
  the output carries, or a pandas `Styler` - and your rules win.
- **A long notebook keeps only its visible cells in the page** - by default Cellar
  renders the cells near the viewport and collapses the rest into a placeholder of
  the same height, so a several-hundred-cell notebook opens and scrolls like a short
  one. Nothing is lost: find-in-notebook, the outline, the sidebar search and
  follow-the-running-cell all mount their target before jumping to it, and
  printing/save-to-PDF re-mounts every cell first. Turn it off from **Settings →
  Windowed rendering** or the navbar's **View** menu (*Render all cells*) - both
  drive the same preference, which is remembered per project - or for one session
  with `?virtualize=0` on the app URL (`=1` forces it back on). The URL parameter
  always wins, and both controls are then shown locked (Settings naming the
  parameter) so neither can pretend otherwise.
- **A cell shows only a single header row** - it is collapsed: the chevron at the left
  of a cell's toolbar hides that cell's input *and* its output, leaving the header
  (cell id, type, run controls, run/stale badges) plus a one-line source preview. Click
  the chevron again, or anywhere on the collapsed header, to expand it; a collapsed
  cell can still be run, moved, selected, and deleted. A click carrying a selection
  modifier (`Shift`, `Cmd`/`Ctrl`) or a right-click is a selection gesture, not a
  disclosure one, so it leaves the cell collapsed. The choice is remembered per
  notebook (in the workspace's `.cellar/` store, like folded headings), so it survives
  a reload and never touches the `.ipynb` - no git diff.
- **A cell has no Run button, and `⌘/Ctrl+Enter` does nothing in it** - it is a **raw**
  cell (the `raw` label on its toolbar): nbformat's type for verbatim text a downstream
  tool reads - Quarto or nbdev frontmatter, an nbconvert directive. Cellar never executes
  it and never renders it, so it shows its source unhighlighted and carries none of the
  execution controls (no Run, no Run-above, no Clear, no output area, no run or stale
  badges); it still drags, collapses, moves, deletes, and copies its input. Both run paths
  refuse it rather than erroring - the UI simply offers none, and an agent's `run_cell`
  returns status `skipped`. Its own nbformat metadata survives a save (`raw_mimetype` and
  `format`, which Jupyter's *Raw NBConvert Format* menu writes), so the cell keeps naming
  the output formats it belongs to. Change it back from the type label at the right of its
  toolbar, the command palette (*Change cell(s) to code*), or `y`/`m`/`r` in command mode
  (`r` is the chord that makes a cell raw in the first place).
- **A cell will not become raw or chat: "A .py notebook cannot hold a raw cell" / "...a chat
  cell"** - a jupytext / Databricks-source notebook is rebuilt from its cells on every save,
  and the format carries no raw marker and no cell metadata or outputs. So the declaration
  would be gone after a reload: raw text would come back in a **runnable** Python cell, and a
  chat cell would come back as runnable prose with its AI reply gone for good (no re-run
  reproduces one). Cellar refuses both instead - in the type menu (where neither is offered),
  in the notebook's add controls (which withhold the **Chat** button there), and on the `r`
  and `t` chords; an agent's `add_cell` / `set_cell_type` is refused for raw, and cannot
  ask for a chat cell at all (no agent write tool takes `chat`). Convert the notebook to
  `.ipynb` (app menu → **Convert to .ipynb**) if you need one. The same limit applies to raw
  in the other direction: **Save as .py** writes a raw cell out as code, so a Quarto notebook
  exported that way loses its frontmatter cell's type.
- **A stopped or failed chat reply shows `>`, backticks and `*asterisks*` above the
  answer** - when you press Stop, or the reply cannot finish (a rate limit, a timeout, a
  sign-in problem), the lines recording which tools the reply used keep the punctuation
  they are written with - a leading `>`, backticks around each call, a stray `\` - instead
  of the tidy dimmed lines a finished reply shows. Only their appearance differs: those
  lines and the part of the answer that arrived are all there, and nothing was lost.
- **Find matched a cell but nothing is highlighted in it** - the match is inside a cell
  whose content is currently hidden - a cell collapsed to its header row, or a source
  match in a cell whose code is hidden by report view. Those matches are still counted,
  so the `i / N` total stays honest, but there is nothing on screen to paint. Expand the
  cell (or show its code) and the highlight appears; a search never expands a cell for
  you, so it can't discard a collapse you set by hand. The exception is a match on a
  cell's **id**: it is painted on the toolbar's `cell #xxxxxxxx` chip, which a collapsed
  cell still shows, so that one stays visible.
- **Searching a cell id found nothing** - an id has to be matched by at least its first
  8 characters (exactly what the toolbar chip shows, and what an agent quotes as a
  handle); a shorter prefix is treated as ordinary text. Ids are matched from the
  start, never in the middle, and a **regex** query searches cell content only - turn
  the `.*` chip off to find a cell by its id.
- **The "copy output" button on a cell is greyed out** - that cell has nothing textual
  to copy. Cellar copies what a cell *shows*, as text, so a picture (a matplotlib
  figure), a Plotly chart, a live widget, or a rich HTML object that is nothing but
  script (a folium map, a Bokeh chart) has no text form, and the button is disabled
  rather than pasting the `<Figure ...>` / `<folium.folium.Map ...>` placeholder Python
  prints for such an object. The same applies to a cell that has not run, and to one
  that printed only a blank line. A markdown or raw cell has no output at all, so it
  carries no copy-output button in the first place. Copy *input* is never disabled - every
  cell has source. Everything else copies as text you can paste: stream output and tracebacks
  (with the terminal colors stripped), and a DataFrame or an HTML table as a
  tab-separated table a spreadsheet reads as columns.
- **A run aborted with "The kernel connection is being refreshed; re-run the cell"** -
  the kernel websocket died (its reconnect retries were spent) while the process
  itself is still alive. Cellar rebuilds the socket in the background without
  restarting the kernel or clearing its namespace, so you can simply re-run the cell;
  no manual restart is needed. See `CELLAR_KERNEL_RECONNECT_TIMEOUT_MS` above.
