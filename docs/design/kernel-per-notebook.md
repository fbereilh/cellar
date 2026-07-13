# Kernel-per-notebook: architecture + phased migration plan

**Status:** proposed (design only - no app code changes in this PR)
**Decision:** the captain has decided to move Cellar from **one shared kernel** to **one kernel per notebook** (true variable isolation + parallel execution across notebooks).
**Scope of this doc:** describe the as-is architecture, the to-be architecture, recommend a path for each hard decision, and lay out an ordered, independently-shippable phased build. The build lands as separate PRs; this is the plan those PRs are cut from.

> This doc grounds every claim in the code on `main` at the time of writing. File:line references are anchors, not exact contracts - read the cited function before you change it.

---

## 1. Current architecture (as-is): one kernel behind every notebook

Cellar today runs **exactly one Jupyter kernel** for the whole app. Every open notebook shares that one Python namespace, and one cell runs at a time app-wide. This is stated in the code repeatedly (e.g. `run-queue.ts:1-9`, `notebook.ts:6-8`, `Sidebar.svelte:674-679`, MCP `INSTRUCTIONS` clause 8 in `server.ts:147-153`).

The single-kernel constraint is **not** in the Jupyter sidecar. `jupyter_server` is a multi-kernel host; the constraint is imposed entirely by `kernel.ts`, which starts exactly one kernel and caches the connection forever.

### 1.1 The sidecar (`bin/cellar.js`)

The launcher starts **one** headless `jupyter_server` per Cellar instance:

- `main()` `bin/cellar.js:668-687` - `spawn(hostPython, ['-m','jupyter_server', …])` with `--ServerApp.root_dir=${WORKSPACE}` and `cwd: WORKSPACE`. One port (`jupyterPort`, `bin/cellar.js:630`).
- `bin/cellar.js:621-625` - writes **one** kernelspec named `python3` into a temp `JUPYTER_PATH` dir (`writeKernelspec`, `venv.js:197-206`, `argv:[projectPython,'-m','ipykernel_launcher',…]`). One spec, bound to the one project interpreter.
- **cwd inheritance (`bin/cellar.js:680-686`):** because `kernel.ts` starts a kernel with `startNew({name:'python3'})` and passes **no notebook path**, the kernel inherits the sidecar's process cwd (`WORKSPACE`). Anchoring the sidecar at `WORKSPACE` is what makes `os.getcwd()` and relative reads resolve in the user's project. Every kernel this sidecar would start today gets the same `WORKSPACE` cwd.

**Consequence for the migration:** the sidecar needs no structural change - it already hosts N kernels. The only sidecar-adjacent nuance is cwd (§3).

### 1.2 The single-kernel choke point (`kernel.ts`)

This is the module the redesign shards. Everything single-kernel lives here:

- Module singletons `kernel.ts:43-47`: `kernelPromise`, `liveKernel`, `manager`, `currentKernel`, `statusHandler` - one of each, process-wide.
- **Session epoch** `sessionId = 0` (`kernel.ts:59`), `execsThisSession` (`kernel.ts:61`), `loadedNbPaths: Set<string>` (`kernel.ts:71`) - a single monotonic epoch and a single "which notebooks have run a cell this session" set.
- `beginSession()` `kernel.ts:73-82` - `sessionId += 1`, clears `loadedNbPaths`, `widgetComms`, and calls `resetWidgets()`. **One epoch bump wipes every notebook's derived state.**
- `getKernel()` `kernel.ts:355-401` - the single-kernel factory: `if (kernelPromise) return kernelPromise;` then `manager.startNew({name:'python3'})` once, cached forever. Registers the widget comm target + output capture, injects `STARTUP_CODE` (matplotlib inline) + `DATAFRAME_FORMATTER_CODE`, and wires the `autorestarting` handler.
- `execute(code, onEvent, {internal})` `kernel.ts:523-590` - `const kernel = await getKernel()`; `const session = sessionId`. **Every** notebook's every cell (and every internal probe) runs against this one kernel and is stamped with the one epoch, emitted as the `{type:'kernel', id, session}` event.
- Lifecycle: `restartKernel()` (`408-426`), `rebindKernel()` (`439-467`), `interruptKernel()` (`474-479`), `kernelStatus()` (`482-485`), `kernelSession()` (`493-503`), `currentSessionId()` (`506-508`), `getKernelInfo()` (`601-612`) - all read/mutate the single `currentKernel`/`sessionId`. **A restart/interrupt affects all notebooks at once.**
- `markNotebookLoaded(nb, session)` (`214-217`) / `loadedNotebookPaths()` (`220-222`) - the one shared "loaded" set, guarded on the single `sessionId`. Its only caller is `run.ts:110`.
- Widget comms live map `widgetComms` (`kernel.ts:41`), `sendWidgetComm()` (`198-205`) - one map for the one kernel's widgets.

### 1.3 The run path + the app-wide queue (`run.ts`, `run-queue.ts`)

- `run-queue.ts` is a **single, app-wide FIFO**. One `active` entry + one `pending[]` list (`run-queue.ts:77-79`), keyed by `(nb, cellId)` (`keyOf`, `run-queue.ts:82`). `queueState()` (`run-queue.ts:90-95`) is `{running, queue}` for the **whole kernel**. Its rationale (`run-queue.ts:10-16`): "a run queued from notebook B must wait behind a run from notebook A" - precisely the behavior kernel-per-notebook removes.
- `clearRunQueue()` (`run-queue.ts:227-233`) drops all pending runs; called from `restart/interrupt/rebind/autorestart` in `kernel.ts` (`386,411,441,475`). One restart clears the whole queue.
- `executeCellRun()` `run.ts:57-128` - the **one execution core** shared by the UI `/run` route, MCP `runCell`, and the imports cell: `execute()` → `setOutputs()` → stamp runtime-only `lastRun` (with `session` captured from the `kernel` event, `run.ts:85`) → publish `run:start`/`run:output`/`run:end`. Calls `markNotebookLoaded(nb, session)` (`run.ts:110`).
- Both entry points take a queue ticket first: UI route `src/routes/api/cells/[id]/run/+server.js:37` and MCP `service.ts:794`, both `enqueueRun({nb, cellId, actor, source})` → `ticket.wait()` → `executeCellRun` → `ticket.done()`.

### 1.4 The run-status / staleness doctrine (per-cell vs one epoch)

The correctness backbone of the agent-first notebook is the split between **saved outputs** (in the `.ipynb`, outlive the kernel) and **executed-this-session** (against the live namespace). It hinges on the **single** global epoch:

- Each cell's runtime-only `metadata.cellar.lastRun.session` records the epoch a run started in (`run.ts:115-123`), stripped from disk by `clean.ts` so it can't be forged.
- `service.ts` `isLiveSession()` (`78`) / `ranThisSession()` (`93-95`) compare that stamp against `currentSessionId()` - **one global epoch** for all cells across all notebooks. `run_status` (`ok_session`/`error_session` vs `ok_persisted`/`error_persisted` vs `error_kernel_unavailable`) is derived from it (`service.ts:149`, `830-836`).
- Staleness (`dataflow.ts`/`staleness.ts`) builds the dependency graph **per notebook** already, but its "did it run this session" input is the one global epoch.

### 1.5 Databricks (`databricks.ts`)

- `spark`/`w` are bound **in the one kernel's namespace**: `CONNECT_CODE(cfg)` does `_g = globals(); _g['spark']=…; _g['w']=…` (`databricks.ts:877-912`), executed through the shared `execute(…, {internal:true})` bridge (`runInKernel`, `databricks.ts:1014-1051`).
- Connection state is **module-global** (one connection for the whole server): `connection`/`connectedSel`/`lost`/`inFlight`/`liveness` (`databricks.ts:1058-1084`).
- Epoch-scoped: `connectionStatus()` (`databricks.ts:1098-1107`) nulls the connection when `connection.session !== currentSessionId()` - one restart drops the one connection.
- **Not coupled:** the *listing* subprocess (`projectPython()` `222-228`, `probe()` `611-690`, `forAgent` `1350-1355`) runs in a short-lived project-venv subprocess, kernel-independent. This half needs no rework; only the kernel-resident session (`spark`/`w`) and the module-global connection state do.
- UI: `Databricks.svelte` takes a single `kernelSessionId` prop (`77-78`) and reloads status when it changes (`189-195`).

### 1.6 Widgets (`widgets.ts`) + variable inspection (`inspect.ts`)

- **Widgets:** one module-level `models` Map keyed by `comm_id` only, **no notebook dimension** (`widgets.ts:36`); routing maps `msgIdToComm`/`commToMsgId`/`pendingClear` (`50-52`); every mutator broadcasts via `publishGlobal` (`67,80,90,125,140,153`). `resetWidgets()` (`147-154`) is fired from `beginSession()` (`kernel.ts:81`) - one restart wipes every notebook's widgets. The header says it outright: "one store spans all notebooks" (`widgets.ts:27-35`).
- **Inspection:** `execProbe()` (`inspect.ts:186-206`) runs through the single `execute(…, {internal:true})`; probes read `get_ipython().user_ns` (`inspect.ts:86,346,384`) - the one shared namespace. `kernelState()` (`250-273`), `inspectVariables()` (`223-233`), `listVariables()`, `inspectVariable()` all reconcile against the one `currentSessionId()`.

### 1.7 Kernels sidebar + API routes

- `Sidebar.svelte` `kernelsSection` (`668-699`) renders **at most one** kernel card - there is no `{#each kernels}`. One `kernelInfo` prop, a flat `loadedNotebooks` list under it (`notebookList`, `628-639`), and global Interrupt/Restart controls (`kernelControls`, `643-666`). Closed-but-loaded notebooks show a dimmed "closed" row (`notebookRow`, `594-608`) because their state persists in the shared namespace.
- `+page.svelte`: single `kernelInfo` state (`759`), `loadedNotebooks` derived from `kernelInfo.loaded_notebooks` (`298-299`).
- API routes are **parameterless**: `GET /api/kernel` (`+server.js`, `getKernelInfo()` + `loadedNotebookPaths()`), `POST /api/kernel/restart`, `POST /api/kernel/interrupt`, `GET /api/kernel/variables`. None takes a notebook id; each acts on the global kernel.

### 1.8 The multi-doc model is already per-notebook (`notebook.ts`)

`notebook.ts` is the one large subsystem that needs **almost no change**: `docs` is a `Map<absPath, NotebookDoc>` (`notebook.ts:48`), every op accepts a trailing `nb`, and `activePath` (`49`) + `setActiveNotebook`/`getActiveNotebookPath` (`254-264`) track the user's focused tab. It holds **no kernel handle** and does not import `./kernel`. `setLastRun` (`500-508`) just carries the `session` number the caller passes. **The document layer is already keyed by the exact identity (absolute notebook path) that will key the kernel manager.**

### 1.9 Blast-radius summary

| Area | Single-kernel assumption | Anchor |
|---|---|---|
| kernel core | one `currentKernel`, one `sessionId`, one `loadedNbPaths`, one `getKernel()`/`startNew` | `kernel.ts:43-47,59-71,355-401` |
| run queue | one app-wide FIFO (`active`+`pending`) | `run-queue.ts:77-79,90-95` |
| run core | `executeCellRun` → global `execute()`; `markNotebookLoaded` on one epoch | `run.ts:57-128,110` |
| run-status doctrine | `ranThisSession` vs one `currentSessionId()` | `service.ts:78,93-95` |
| databricks | one global `connection`; `spark`/`w` in one namespace; epoch vs global | `databricks.ts:877-912,1058-1084,1098-1107` |
| widgets | one `models` map, no notebook dim; `resetWidgets` on global `beginSession` | `widgets.ts:36,147-154` ← `kernel.ts:81` |
| inspect | probes read one `user_ns`; staleness vs global epoch | `inspect.ts:86,263,493,514` |
| sidebar | one `kernelInfo`, flat `loadedNotebooks`, global controls | `Sidebar.svelte:668-699` |
| API routes | parameterless kernel routes | `api/kernel/*` |
| MCP | `kernel_status`/`kernel_state`/`run_queue`/`restart`/`interrupt` all global | `service.ts:246`, `server.ts:208-211,218` |
| **not coupled** | `notebook.ts` docs Map; databricks listing subprocess; sidecar (multi-kernel host) | `notebook.ts:48`, `databricks.ts:611-690`, `bin/cellar.js:668-687` |

---

## 2. Target architecture (to-be): one kernel per notebook

One `jupyter_server` sidecar (unchanged) hosting **N kernels - one per notebook** - keyed by the notebook's absolute path, **lazy-started** (a notebook gets its kernel on its first run). A **kernel manager** replaces the single `currentKernel`. Runs route to the notebook's kernel; the run queue becomes **per-kernel**, so notebooks execute in parallel while each kernel still serializes its own cells. Session epoch, `ran_this_session`, widgets, variable inspection, and `spark`/`w` all become **per-notebook**. Cross-notebook namespace sharing goes away - that is the point. "Wipe a notebook from memory" becomes "restart that notebook's kernel".

### 2.1 The kernel manager (`kernel.ts` → `KernelManager`-shaped module)

Replace the module singletons with a `Map<string, NotebookKernel>` keyed by absolute notebook path. Each `NotebookKernel` holds exactly what is global today, now scoped to one notebook:

```
interface NotebookKernel {
  nbPath: string;                 // absolute path - the key
  connection: Kernel.IKernelConnection;
  sessionId: number;              // per-notebook monotonic epoch (was the global `sessionId`)
  execsThisSession: number;
  statusHandler: StatusListener;  // autorestart handler, identity-guarded to THIS kernel
  widgetComms: Map<string, IComm>;
  // (widget store + inspect probes route through this kernel - see §2.4)
}
```

The exported surface stays close to today's, but **every function that is process-global becomes `(nbPath, …)`-addressed**:

| Today (global) | Per-notebook |
|---|---|
| `getKernel()` | `getKernel(nbPath)` - lazy `startNew`, cache in the Map |
| `execute(code, onEvent, opts)` | `execute(nbPath, code, onEvent, opts)` |
| `restartKernel()` | `restartKernel(nbPath)` |
| `interruptKernel()` | `interruptKernel(nbPath)` |
| `rebindKernel()` | `rebindKernel(nbPath?)` - one notebook, or all (venv change affects all) |
| `kernelStatus()` / `kernelSession()` / `currentSessionId()` | `(nbPath)` variants; `currentSessionId(nbPath)` |
| `getKernelInfo()` | `getKernelInfo(nbPath)` and a new `listKernels()` for the sidebar |
| `loadedNotebookPaths()` | replaced by `listKernels()` (a live kernel *is* a loaded notebook) |
| `markNotebookLoaded(nb, session)` | **removed** - "loaded" now means "has a live kernel entry" |
| `beginSession()` | `beginSession(nbKernel)` - bumps that kernel's epoch, resets its widgets |

**Manager lifecycle per notebook:**

- **start / lookup:** `getKernel(nbPath)` - if the Map has a live entry, return it; else `manager.startNew({name:'python3', path: <workspace-relative nb path>})`, run `initKernel` (matplotlib + dataframe formatter + widget comm target + output capture), install the identity-guarded autorestart handler, store in the Map. Lazy: no kernel until the first run. Passing `path` also fixes the per-notebook cwd (§3, the deferred follow-up already noted in `bin/cellar.js:680-686`).
- **restart:** `restartKernel(nbPath)` - `clearRunQueue(nbPath)`, `connection.restart()`, bump that notebook's epoch, re-inject `initKernel`. Other notebooks untouched.
- **interrupt:** `interruptKernel(nbPath)` - `clearRunQueue(nbPath)` + `connection.interrupt()`.
- **rebind (venv change):** the Settings venv control rewrites the shared `python3` kernelspec, so a rebind must tear down **and re-create every** live kernel (or mark them all for lazy re-create). `rebindKernel()` with no arg iterates the Map.
- **shutdown:** `shutdownKernel(nbPath)` - `connection.shutdown()` (frees the Python process), drop the Map entry, `clearRunQueue(nbPath)`, reset that notebook's widgets. This is the new "close/wipe" primitive Jupyter already supports.
- **autorestart:** the `autorestarting` status handler stays, but its identity guard (`kernel.ts:381`) already scopes it to one connection; it now bumps only that notebook's epoch and clears only that notebook's queue.

`notebook.ts` `dropDocs`/`rekeyDocs` (`342-376`) gain a companion call into the manager: deleting a notebook should `shutdownKernel(abs)`; renaming should rekey the Map entry (or shut down + let it lazily restart under the new path).

### 2.2 Per-kernel run queue (`run-queue.ts`)

Shard the single `active`/`pending` into a per-kernel pair keyed by `nbPath`:

```
const queues = new Map<string, { active: QueueEntry | null; pending: QueueEntry[] }>();
```

- `enqueueRun({nb, cellId, …})` looks up (or creates) `queues.get(nb)`; serialization is now **within a notebook** only. Two notebooks run in parallel.
- `clearRunQueue(nbPath)` clears one notebook's pending list (called from that notebook's restart/interrupt/rebind/autorestart).
- The broadcast snapshot (`queue:changed`, `run-queue.ts:97-99`) becomes **per-notebook**: either tag it with `nb` (like `run:*` events) or broadcast a map `{ [nbPath]: {running, queue} }`. Recommend per-notebook tagged events (mirrors the existing `run:*` filtering in `LiveNotebook`), plus a `queuesSnapshot()` that returns the full map for MCP `run_queue` and the sidebar.

### 2.3 Per-notebook session epoch + run-status doctrine

The doctrine is unchanged in spirit; only the epoch's scope narrows from global to per-notebook:

- `run.ts` already captures `session` from the run's own `kernel` event and stamps it on the cell (`run.ts:85,115`). With per-notebook epochs, the stamp is compared against **that notebook's** `currentSessionId(nbPath)`.
- `service.ts` `ranThisSession(cell, sid)` (`93-95`) already takes `sid` as a parameter - the change is that its callers pass `currentSessionId(cell's notebook)` instead of the one global. Every read tool already samples the epoch once per response (`service.ts:509,540`); it now samples the target notebook's epoch.
- `markNotebookLoaded` (`run.ts:110`, `kernel.ts:214`) is **deleted**: a notebook is "loaded" iff it has a live kernel entry, which the manager already knows.

### 2.4 Per-notebook widgets + inspection

- **Widgets (`widgets.ts`):** add a notebook dimension. Either key `models` by `(nbPath, comm_id)` or hold one store per `NotebookKernel`. `resetWidgets(nbPath)` is called from that notebook's `beginSession`. Widget SSE events gain an `nb` tag so a tab renders only its notebook's widgets (they are `publishGlobal` today; they become notebook-scoped like `run:*`). Comm ids are unique per session, so cross-notebook collision is not a correctness risk, but scoping the store is what makes a per-notebook restart wipe only that notebook.
- **Inspection (`inspect.ts`):** `execProbe(nbPath, code)` runs through `execute(nbPath, …)`; `kernelState(nbPath)`, `listVariables(nbPath)`, `inspectVariable(nbPath, name)` reflect that notebook's `user_ns` and reconcile against that notebook's epoch. The Variables sidebar reads the active notebook's kernel.

### 2.5 Cross-notebook sharing goes away (intended)

Today a notebook whose tab is closed keeps its variables in the shared namespace, and (in principle) notebook B could see names notebook A defined - the shared namespace made this possible even though the product never encouraged it. Per-notebook kernels **eliminate** this: each notebook has its own `user_ns`. This is the explicit goal (true isolation). Nothing in the product *relies* on cross-notebook sharing - the imports cell, staleness, and the run-status doctrine are all per-notebook already; the only behavior that changes is that a name defined in notebook A is no longer reachable from notebook B (which was never a supported workflow). See §3 for the imports-cell confirmation.

### 2.6 MCP surface (ties to PR #99)

**Dependency:** PR #99 (*per-agent working notebook*, currently OPEN) is the natural substrate. It gives each MCP session a pinned working notebook via `targetFor(sessionId, explicit?)` (`use_notebook`/`current_notebook`, per-call `notebook` override). Kernel-per-notebook rides that: an agent's kernel ops resolve to **its** working notebook's kernel.

- `kernel_status(nbPath)`, `kernel_state(nbPath)`, `run_queue` → the target notebook's kernel/queue (or, for `run_queue`, the full per-notebook map so an agent sees cross-notebook contention).
- `restart_kernel`/`interrupt_kernel` → the session's working notebook only (a huge safety win: an agent restarting its kernel no longer nukes the user's other notebooks).
- Doctrine text (`server.ts:52-204`): clause 8 changes from "ONE KERNEL, ONE RUN AT A TIME" (shared) to "each notebook has its OWN kernel; your working notebook's cells serialize among themselves but run in parallel with other notebooks; restarting your kernel affects only your notebook." Clause 9 (Databricks) changes to "your notebook's kernel has its own `spark`/`w`" (§3).

---

## 3. Hard design decisions (with recommendations)

### 3.1 Memory & lifecycle - N kernels = N Python processes

**Recommendation:**
- **Lazy-start** (required): no kernel until a notebook's first run. `getKernel(nbPath)` starts on demand.
- **Tab close keeps the kernel** (Jupyter default). Closing a tab must **not** shut the kernel down - the user re-opens the tab and expects their variables. This matches today's "closed but loaded" behavior (`Sidebar.svelte:594-608`). Provide an explicit **"Shut down kernel"** control (sidebar + MCP) for the user to reclaim memory deliberately.
- **Idle-kernel shutdown: yes, but conservative and off by default initially.** Jupyter's `MappingKernelManager` already supports `--MappingKernelManager.cull_idle_timeout`; prefer leaning on the sidecar's own culling over hand-rolling a timer, configured to a long default (e.g. 2h) and surfaced as a setting. Ship the manual "shut down" control first (Phase 3), add culling later (Phase 6). Culling must publish a `kernel:shutdown`/epoch-invalidation event so open tabs correctly show "not run this session".
- **Cap + warn on kernel count.** Each kernel is a full Python process (100s of MB with pandas/pyspark). Add a soft cap (e.g. warn at 8 live kernels) surfaced in the Kernels sidebar, and a hard-ish guard that prompts before starting the Nth. Recommend **warn-only** initially (do not block a run), with the count visible in the sidebar header.

*Tradeoff:* keeping kernels on tab-close costs memory but preserves the mental model users have today; culling reclaims it without surprising anyone if the timeout is long and the shutdown is clearly surfaced. Shutting down on tab-close would be simpler but breaks the "my variables are still there when I come back" expectation that the current shared-kernel model provides.

### 3.2 Databricks - per-notebook connection

**Recommendation: per-notebook connect.** `spark`/`w` live in the kernel namespace, so each notebook's kernel needs its own Databricks Connect session. Make the connection state per-notebook (key `connection`/`connectedSel`/`lost`/`liveness` by `nbPath` - the module singletons at `databricks.ts:1058-1084` become a `Map<nbPath, …>`), and bind `spark`/`w` into that notebook's kernel. The listing subprocess (`probe`/`projectPython`, `databricks.ts:611-690`) is already kernel-independent and stays shared/stateless.

*Tradeoff:* a Databricks Connect session per notebook means N cluster sessions if the user connects N notebooks - real cost, but it is the honest model (each notebook is an isolated runtime, so each must reach Spark on its own). A shared session proxied across kernels would need an out-of-kernel Spark broker and cross-process handle sharing - large complexity, and it re-introduces exactly the shared-state coupling we are removing. **Reject the shared-session proxy.** Mitigate the cost by: (a) connecting lazily (only when the user connects that notebook), and (b) the `Databricks.svelte` UI clearly showing "this notebook is connected to cluster X" per notebook. The auto-reconnect + liveness logic (`agentStatus()`, `databricks.ts:1262-1322`) applies per-notebook unchanged.

### 3.3 The imports cell / cross-notebook sharing

**Recommendation: confirm the loss of cross-notebook sharing is intended (it is).** The imports cell is a **per-notebook** construct already (`metadata.cellar.role='imports'`, one per document) - it consolidates imports *within* a notebook, never across. Nothing about it relied on the shared namespace. The only thing per-notebook kernels remove is a name defined in notebook A being visible in notebook B, which was never a supported or encouraged workflow. **No mitigation needed**; document it in the MCP doctrine so an agent does not assume another notebook's variables exist.

### 3.4 Run queue - N queues

**Recommendation: per-kernel FIFO (§2.2), represented as a per-notebook map.** The sidebar shows each kernel's own running/queued state under that kernel's card. MCP `run_queue` returns the full map `{ [nbPath]: {running, queue} }` so an agent can see that its run is waiting behind *its own* notebook's cell (normal) - cross-notebook contention no longer exists, so a run is never queued behind another notebook. Keep the `queue:changed` event but tag it per-notebook (mirrors `run:*`).

### 3.5 Kernels sidebar + controls

**Recommendation: one card per live kernel.** Replace the single-card `kernelsSection` (`Sidebar.svelte:668-699`) with `{#each kernels}` - each card shows one notebook's kernel status (via the existing `kernelBadge.js` mapping), with its own **Interrupt / Restart / Shut down** controls. A notebook with no kernel yet shows "not started" (it starts on first run). This makes "wipe this notebook from memory" = Restart (clears namespace, keeps the process) or Shut down (frees the process). The sidebar header shows the live kernel count (feeds the §3.1 cap warning). `+page.svelte` swaps the single `kernelInfo` (`759`) for a `kernels` map keyed by notebook path; the API returns `listKernels()`.

### 3.6 Session-epoch / run-status doctrine - per-notebook

**Recommendation: narrow the epoch scope, keep the reconciliation shape.** As in §2.3: the per-cell `lastRun.session` stamp is unchanged; it is now compared against **its own notebook's** epoch. `ranThisSession(cell, sid)` already takes `sid` as an argument - callers pass `currentSessionId(nbPath)`. `markNotebookLoaded` is deleted (a live kernel entry *is* loaded). This is a small, well-contained change because the doctrine was already parameterized by `sid` and by `nb`.

### 3.7 MCP - per-notebook (ties to PR #99)

**Recommendation: build on PR #99's `targetFor`.** `kernel_status`/`kernel_state`/`restart`/`interrupt`/`run_queue` resolve to the calling session's working notebook (per-call `notebook` override still allowed). This is a **safety upgrade**: an agent can no longer restart the shared kernel and clear the user's (or another agent's) namespace - it only touches its own notebook. Update `INSTRUCTIONS` clauses 8-9 accordingly. **Sequencing:** PR #99 should land before or with Phase 5; if #99 slips, Phase 5 can temporarily resolve to `getActiveNotebookPath()`.

### 3.8 Back-compat / migration - hard switch

**Recommendation: hard switch, no "shared kernel" mode.** A dual-mode kernel (shared vs per-notebook) would fork the run-status doctrine, the queue, widgets, inspection, and Databricks - doubling the surface that must stay correct, for a mode nobody asked for. The phased plan (below) keeps the app working after every merge, so a compatibility flag earns nothing. If a fallback is ever wanted, the honest one is an env guard for a single release, removed immediately after - not a permanent mode. **Do not build a shared-kernel option.**

---

## 4. Phased implementation plan

Each phase is an independently-shippable PR. The ordering keeps the app working after every merge: early phases change internals behind the existing single-kernel *appearance*, later phases expose the N-kernel reality.

### Phase 1 - Kernel manager core (internals only; UI still shows "a kernel")

**Scope:**
- Convert `kernel.ts` from module singletons to a `Map<nbPath, NotebookKernel>` (§2.1). Every exported fn gains an `nbPath` param.
- `getKernel(nbPath)` lazy-starts + caches; `execute(nbPath, …)`; per-notebook epoch + autorestart handler.
- Route `run.ts` / `run-queue.ts` by notebook: shard the queue per kernel (§2.2). `executeCellRun` already carries `nb` - thread it into `execute(nb, …)`.
- Pass the workspace-relative notebook `path` to `startNew` so each kernel roots at its own notebook's dir (fixes `bin/cellar.js:680-686`'s deferred cwd note).
- Keep the **UI + MCP surface unchanged** by having the now-parameterized global-ish endpoints resolve to the active notebook (`getActiveNotebookPath()`), so the app still presents "one kernel" until Phase 3. `loadedNotebookPaths()` returns the Map keys.

**Acceptance:** two notebooks run cells in parallel (verify a long-running cell in notebook A does not block a cell in notebook B); each notebook has an independent namespace (a variable defined in A is not visible in B); restart of the active notebook does not clear the other's namespace. Existing tests green; `npm run check` clean.

### Phase 2 - Per-notebook session epoch + run-status/loaded doctrine

**Scope:**
- `service.ts` reconciliation uses `currentSessionId(nbPath)` per notebook (§2.3, §3.6). Delete `markNotebookLoaded`; "loaded" = live kernel entry.
- Staleness (`dataflow.ts`/`staleness.ts`) already per-notebook; feed it the per-notebook epoch.
- Read tools sample the target notebook's epoch (they already sample once per response).

**Acceptance:** `run_status`/`ran_this_session` are correct per notebook - running a cell in A marks A's cells live without affecting B's; restarting A's kernel reverts only A's cells to `ok_persisted`. Unit tests for the split run-status extended to two notebooks.

### Phase 3 - Kernels sidebar shows N kernels + per-kernel controls (incl. wipe)

**Scope:**
- `api/kernel` returns `listKernels()`; add `POST /api/kernel/restart`, `/interrupt`, and new `/shutdown` taking `{path}`.
- `Sidebar.svelte` `kernelsSection` → `{#each kernels}` with per-card status + Interrupt/Restart/**Shut down** (§3.5). `+page.svelte` swaps the single `kernelInfo` for a per-notebook map. Live kernel count in the header.
- Variables sidebar (`inspect`) reads the active notebook's kernel.

**Acceptance:** each open/loaded notebook shows its own kernel card with independent status; Restart clears one namespace; Shut down frees one process and drops the card; parallel busy states render independently. This is the phase where the N-kernel reality becomes visible.

### Phase 4 - Databricks per-notebook

**Scope:**
- Key `databricks.ts` connection state by `nbPath` (§3.2); bind `spark`/`w` into the target notebook's kernel; per-notebook liveness/auto-reconnect.
- `Databricks.svelte` shows per-notebook connection; drops the single `kernelSessionId` prop for the active notebook's epoch.
- Listing subprocess unchanged.

**Acceptance:** notebook A connected to a cluster does not bind `spark` in notebook B; restarting A's kernel drops only A's Databricks session; two notebooks can hold independent sessions. `not_connected` errors are per notebook.

### Phase 5 - Widgets / inspection / MCP per-notebook + doctrine (ties to PR #99)

**Scope:**
- Widgets store per notebook + notebook-tagged SSE (§2.4).
- MCP `kernel_status`/`kernel_state`/`run_queue`/`restart`/`interrupt` resolve via PR #99's `targetFor` (§3.7). Rewrite `INSTRUCTIONS` clauses 8-9.
- `run_queue` returns the per-notebook map.

**Acceptance:** an agent's `restart_kernel` clears only its working notebook; `kernel_state` reflects the working notebook's namespace; a widget in A does not render in B's tab; two agents on two notebooks each see their own kernel state. Depends on PR #99 (fallback to active notebook if it slips).

### Phase 6 - Lifecycle & memory (idle shutdown, caps)

**Scope:**
- Configure sidecar idle-kernel culling (`cull_idle_timeout`, long default) with a `kernel:shutdown` invalidation event (§3.1). Setting to tune/disable.
- Soft cap + warning at N live kernels in the sidebar; count in the header.
- Shutdown-on-notebook-delete wiring (`dropDocs` → `shutdownKernel`).

**Acceptance:** an idle kernel is culled after the timeout and its notebook's cells correctly read "not run this session"; the sidebar warns past the cap; deleting a notebook frees its kernel process.

**Why this order:** Phase 1 de-risks the core (parallel execution + isolation) behind the unchanged UI, so a regression is caught before anything user-visible changes. Phase 2 makes the correctness doctrine honest per notebook (must precede exposing N kernels, or the sidebar would show N kernels while run-status still reasoned globally). Phase 3 is the first user-visible flip. Phases 4-5 (Databricks, widgets, MCP) are independent leaf subsystems that each ride the now-per-notebook core and can land in any order among themselves. Phase 6 (lifecycle) comes last because it is an optimization on a working N-kernel system, not a prerequisite for correctness.

---

## 5. Risks & open questions

**Risks:**
1. **Memory blow-up.** N notebooks × (pandas + pyspark) can exhaust RAM fast. Mitigation: lazy-start, manual shutdown (Phase 3), culling + cap (Phase 6). *This is the biggest operational risk.*
2. **Kernel startup latency per notebook.** The first run of each notebook now pays kernel-boot cost (previously only the first run app-wide did). Mitigation: keep it lazy; consider a "pre-warm on tab open" option later (explicitly deferred - do not pre-warm in v1, it defeats lazy-start's memory win).
3. **Databricks cost.** A Connect session per notebook = N cluster sessions. Mitigation: lazy connect, clear per-notebook UI. Flagged for the captain (§3.2).
4. **Rebind (venv change) fan-out.** A venv change must restart/re-create every live kernel (they share one `python3` kernelspec). Ensure `rebindKernel()` iterates the Map and clears every queue.
5. **Event/SSE volume.** Per-notebook widget/queue events multiply the SSE traffic; ensure filtering stays cheap (tag by `nb`, filter client-side as `run:*` already does).
6. **PR #99 sequencing.** Phase 5 leans on the per-session working notebook. If #99 stalls, Phase 5 falls back to `getActiveNotebookPath()` (documented in §3.7).

**Open questions for the captain:**
- **Tab-close policy:** confirm keep-kernel-alive on tab close (recommended §3.1) vs shut-down-on-close. This is the single biggest UX/memory tradeoff.
- **Idle-cull default:** on or off by default, and what timeout? (Recommend on, ~2h, tunable.)
- **Kernel cap:** warn-only vs hard block, and at what count? (Recommend warn-only, ~8.)
- **Databricks per-notebook cost:** acceptable, or is a shared-broker worth the complexity later? (Recommend accept per-notebook, reject broker.)
- **cwd per notebook:** confirm each kernel should root at its own notebook's directory (the deferred `bin/cellar.js:680-686` follow-up), relevant for multi-directory workspaces.
- **Shared-kernel fallback:** confirm the hard-switch recommendation (§3.8) - no permanent shared-kernel mode.
