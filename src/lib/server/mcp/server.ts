/**
 * Cellar — MCP server (agent interface).
 *
 * Runs IN-PROCESS inside Cellar's backend over Streamable HTTP on its own port,
 * so it shares the live notebook document + kernel with the UI. Because the MCP
 * server, its sessions, and the document are all independent of the kernel
 * connection, restarting/replacing/killing the kernel never drops the MCP
 * connection or the agent session (spec §4, hard requirement #1).
 *
 * Connect an agent to:  http://127.0.0.1:<CELLAR_MCP_PORT>/mcp   (default 39587)
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as svc from './service';
import { McpSessionRegistry, SESSION_IDLE_MS, REAPER_INTERVAL_MS } from './sessions';

const text = (obj: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(obj) }] });
const notFound = (msg: string) => ({ content: [{ type: 'text' as const, text: msg }], isError: true });

/**
 * Per-tool-call context the MCP SDK hands every handler as its second argument
 * (`RequestHandlerExtra`). `sessionId` is the Streamable-HTTP `Mcp-Session-Id` —
 * stable for the life of one connected `cellar mcp` bridge, so it is the reliable
 * identifier for THIS agent's session; we resolve every notebook-scoped tool's
 * target from it. `_meta.progressToken` + `sendNotification` are what a
 * long-running tool uses to keep the call alive (see `withProgress`).
 */
type ToolExtra = {
	sessionId?: string;
	_meta?: { progressToken?: string | number };
	sendNotification?: (notification: {
		method: 'notifications/progress';
		params: { progressToken: string | number; progress: number; total?: number; message?: string };
	}) => Promise<void>;
};

/**
 * How often a long-running run tool emits an MCP progress notification while it
 * waits for the kernel. It exists ONLY to keep the client's per-tool-call timeout
 * from firing on a slow cell (Claude Code's default is ~60s), so it must be
 * comfortably under that: at 15s a 60s-timeout client gets three resets before it
 * would have given up. Exported for the unit test.
 */
export const PROGRESS_INTERVAL_MS = 15_000;

/**
 * Run a long-running tool body while emitting periodic MCP progress
 * notifications, so the call never goes silent and trips the MCP CLIENT's
 * per-tool-call timeout (the killer: a cell that runs longer than ~60s makes the
 * agent's client give up and DISCARD the eventual result, even though the run
 * finishes server-side). A client that requested progress sets a `progressToken`
 * in the request `_meta`; each notification we send against it resets that
 * client's timeout (when it enables `resetTimeoutOnProgress`, as Claude Code
 * does) and keeps the connection alive, so the FINAL result is delivered when the
 * run completes. The tool's contract is unchanged — it still returns the full
 * result at the end; it just no longer goes quiet in the meantime.
 *
 * A wall-clock heartbeat, deliberately NOT tied to the run's output stream: the
 * canonical hang is `time.sleep(90)`, which emits nothing until it finishes, so
 * an output-driven ping would never fire. If the client sent no progressToken
 * (it did not ask for progress) this is a no-op passthrough — we never push
 * unsolicited notifications. Any send error is swallowed (a dropped heartbeat
 * must never fail the run), and the timer is `unref`'d so it can't keep the
 * process alive on its own.
 */
export async function withProgress<T>(extra: ToolExtra | undefined, fn: () => Promise<T>): Promise<T> {
	const progressToken = extra?._meta?.progressToken;
	const send = extra?.sendNotification;
	if (progressToken === undefined || !send) return fn();
	const startedAt = Date.now();
	let progress = 0;
	const timer = setInterval(() => {
		progress += 1;
		const seconds = Math.round((Date.now() - startedAt) / 1000);
		// progress must be monotonically increasing (MCP spec); total is unknown for
		// an open-ended run, so we omit it and carry the elapsed time in `message`.
		send({ method: 'notifications/progress', params: { progressToken, progress, message: `running… ${seconds}s` } }).catch(() => {});
	}, PROGRESS_INTERVAL_MS);
	timer.unref?.();
	try {
		return await fn();
	} finally {
		clearInterval(timer);
	}
}

/**
 * The absolute notebook a tool call targets: an explicit per-call `notebook`
 * overrides this session's pinned working notebook, which overrides the global
 * active notebook (see service.ts `targetFor`). Passed as the `nb` argument to
 * every notebook-scoped service function so an agent's ops land in ITS notebook,
 * not whichever tab the user happens to have focused.
 */
const targetOf = (extra: ToolExtra | undefined, notebook?: string) => svc.targetFor(extra?.sessionId, notebook);

/**
 * Resolve a required cell ref (a short handle, any longer prefix, or a full UUID)
 * to its full cell id for `target`, or return the structured tool error to hand
 * straight back. Every id-taking tool resolves at this boundary, so all downstream
 * service + notebook code keeps working with full ids — and an ambiguous prefix
 * (matches >1 cell) or an unknown ref surfaces as a clear, actionable error rather
 * than silently addressing the wrong cell.
 */
function resolveOne(target: string, ref: string): { id: string } | { error: ReturnType<typeof notFound> } {
	try {
		return { id: svc.resolveRef(target, ref) };
	} catch (e) {
		return { error: notFound(String((e as Error)?.message ?? e)) };
	}
}

/** Resolve a list of cell refs to full ids, erroring on the first bad one. */
function resolveMany(target: string, refs: string[]): { ids: string[] } | { error: ReturnType<typeof notFound> } {
	const ids: string[] = [];
	for (const ref of refs) {
		const r = resolveOne(target, ref);
		if ('error' in r) return r;
		ids.push(r.id);
	}
	return { ids };
}

// Every notebook-scoped tool accepts an optional `notebook` (a workspace .ipynb
// path) that targets that notebook for one call, overriding this session's
// working notebook. The rule is stated once in INSTRUCTIONS (clause 6); the
// param stays machine-visible in each tool's inputSchema so the affordance needs
// no per-tool prose.
const notebookParam = { notebook: z.string().optional() };

/**
 * Run a Databricks tool, turning its structured failure into a structured tool
 * error. `code` (`not_connected`, `sdk_missing`, `permission_denied`, …) is the
 * part an agent can act on - losing it to a bare string would leave "ask the
 * user to connect" indistinguishable from "that catalog does not exist".
 */
async function databricksTool(fn: () => unknown) {
	try {
		return text(await fn());
	} catch (err) {
		// A DatabricksError carries a structured `code`; fall back for anything else.
		const e = err as { code?: string; message?: string };
		return { content: [{ type: 'text' as const, text: JSON.stringify({ error: e?.code ?? 'error', message: String(e?.message ?? err) }) }], isError: true };
	}
}

/**
 * The FULL `route_imports` contract, carried by add_and_run (the preferred write
 * path). The other write tools (add_cell/add_cells/edit_cell) carry the terse
 * ROUTE_IMPORTS_PTR pointer instead — the full statement lives in exactly one
 * place, and the `route_imports` bool stays in every write tool's inputSchema.
 */
const ROUTE_IMPORTS_DOC = ` IMPORT ROUTING (default ON): any MODULE-LEVEL import in your source is moved into the notebook's single "imports" cell (the user-designated cell wherever it sits, or created on demand), deduplicated against what is already there, removed from the code you submitted, and the imports cell is RUN so the kernel has it immediately. Imports nested inside a def/class/if/try body are never touched. The result carries an "imports" report {cell_id, added, run_status}. Pass route_imports:false to keep the import lines inline in this cell instead — do that when the import is deliberately local (a lazy or conditional import, or a cell demonstrating an import).`;
const ROUTE_IMPORTS_PTR = ` Module-level imports are auto-routed to the notebook's imports cell; pass route_imports:false to keep them inline — see add_and_run for the full contract.`;

/**
 * House-style doctrine handed to the agent once at connect (MCP server
 * `instructions`). Sets the frame — build ONE coherent notebook, not a pile of
 * snippets — before the first tool call. Advisory: the host injects it into the
 * model's context. Reference only tools that ship today.
 */
const INSTRUCTIONS = `You are authoring ONE coherent, human-readable Python notebook in Cellar — not a
pile of independent snippets. Notebooks here read top-to-bottom as a single
narrative where each cell builds on the last.

Cell ids appear as short handles (an 8-char prefix of the cell's id); pass a handle back wherever a tool takes a cell id, or the full UUID if you have one — both resolve to the same cell.

Follow this house style:

1. IMPORTS ARE COLLECTED IN ONE CELL — AND CELLAR PUTS THEM THERE FOR YOU. The
   notebook has a single "imports" cell. When you write code, any module-level
   import in it is auto-routed into that cell — so just write the import where the
   code needs it and let it be routed; your cell keeps only the real work. Pass
   route_imports:false when you mean an import to stay inline (a lazy or conditional
   import, or a cell whose subject IS the import). consolidate_imports sweeps an
   existing notebook's scattered imports into that cell in one call. Before adding
   an import, check kernel_state (below) to see whether the module is already
   loaded. (See add_and_run for the full routing contract.)

2. CHECK STATE BEFORE YOU WRITE. Call kernel_state to see what is already
   imported and which variables/functions/classes already exist in the live
   kernel. Do not re-import a module that is already loaded, and do not recompute
   or redefine a value that already exists — build on it.

   INSPECT THE DATA, DO NOT GUESS IT. Use list_variables and inspect_variable(name)
   to SEE the data (a DataFrame's columns, an array's shape) instead of guessing a
   column name or adding a throwaway df.head()/df.columns cell. Both are read-only
   (run NO code, do not change exec counts) and, like kernel_state, reflect only
   the LIVE kernel session — a variable absent from list_variables is not defined
   right now, whatever a cell's saved output shows.

3. KERNEL_STATE IS THE LIVE TRUTH; SAVED OUTPUTS ARE NOT. A cell's outputs are
   saved in the .ipynb file and outlive the kernel, so "this cell has output" NEVER
   means "this cell has run in the kernel you are talking to". Only kernel_state
   says what is actually defined right now. get_notebook_map and read_cells make the
   split explicit per cell through run_status + ran_this_session (see those tool
   docs for the run_status values, incl. error_kernel_unavailable).

   So: before you depend on a variable an earlier cell defines, confirm it in
   kernel_state. If it is missing, RE-RUN the upstream cells that define it
   (run_cell / run_range / run_all) before running anything downstream — otherwise
   you get a NameError on a cell whose saved output looked perfectly fine.
   Restarting the kernel resets every cell to "not run this session".

   STALENESS — WATCH IT, YOU CREATE IT. Because you run cells out of order and edit
   upstream cells, a cell's output routinely goes OUT OF DATE: it ran this session,
   but a cell it DEPENDS ON has since been edited or re-run. A stale cell's output
   is NOT trustworthy — before you rely on it (or build downstream of it), re-run
   it and its upstreams; run_stale re-runs everything stale in dependency order in
   one call. When you edit a cell, expect the cells below it that use its names to
   go stale — re-run them so the notebook you leave behind is coherent.
   (get_notebook_map and kernel_state flag what is stale.)

   STALENESS UNDER-REPORTS - IT IS A FLOOR, NOT A GUARANTEE. The flag is static
   analysis (which names each cell defines/uses) plus run timestamps; nothing
   inspects the kernel namespace to check it. A dependency carried only through a
   conditional bind (if flag: df = load()) or through exec/globals() records no
   dependency at all, so editing its upstream leaves that cell reported FRESH while
   its output is already out of date. "stale" always means re-run it; "fresh" means
   nothing was detected, not that it was verified. When you edit a cell that defines
   a name, re-run the cells below it that use it even if they are not flagged - or
   restart_kernel + run_all when you need certainty.

4. CONTINUE THE STORY. Before adding a cell, call get_notebook_map to see the
   narrative so far. A new cell should advance it — reuse existing variables,
   reference earlier results, and add a short markdown header when you start a new
   section. Do not answer a question in isolation as if the notebook were empty.

5. STRUCTURE WITH MARKDOWN. Use markdown header cells to divide the notebook into
   sections (Setup, Load data, Explore, Model, Results). Keep code cells focused:
   one idea per cell. Add markdown cells with add_and_run (NOT add_cell): markdown
   does not render on its own, and "running" a markdown cell renders it (no kernel
   executes); add_and_run creates it AND shows it rendered, so a header never sits
   as raw source in the notebook.

   NEVER NUMBER A HEADER BY HAND. Write "## Load data", not "## 2. Load data" -
   numbering is Cellar's to add, never yours. It is a notebook-level setting naming
   WHICH levels are numbered, and it may be OFF: get_notebook_map's display block
   reports the levels (header_numbering:[] = off) and each section's number. Turn it
   on with set_header_numbering when numbering suits the notebook (levels:[2] numbers
   every H2; levels:[] turns it off again). Either way it is display-only: the number
   is added at render time and never enters your source, so one you type yourself is
   rendered on TOP of Cellar's - "1. 1. Load data". If you meet headers already
   carrying hardcoded numbers while numbering is on, edit the numbers out of the
   source; keep a number that is part of the title itself ("3. Third Attempt").

   REPORT VIEW hides every code cell's input and shows only its output - the
   notebook read as a results document, not as code (set_report_view; cells still
   run, no source is touched, and get_notebook_map's display block reports it).
   Turn it on when the user asks for a report or a clean read-through, and expect
   your markdown and your outputs to carry the whole story when it is on. A PER-CELL
   override (set_hide_input) beats the notebook-wide default in either direction:
   hidden:true hides one cell's code, hidden:false keeps one cell's code visible
   under report view, hidden:null clears the override. get_notebook_map reports each
   code cell's effective code_hidden (and its explicit hide_input when it carries
   one), so you can see - even with report view on - which cells the user chose to
   keep shown; do not "fix" such a cell back to hidden.

6. DECLARE YOUR WORKING NOTEBOOK FIRST. Your read/write/run tools target YOUR
   session's working notebook — not whichever tab the user happens to be looking
   at. Before you start, call use_notebook(name) to declare it — it OPENS the
   notebook, or CREATES it if new (open-or-create in one call; pass
   create_if_missing:false to open-only and error if it does not exist). From then
   on every add/edit/run defaults to that notebook, and it stays put no matter
   which tab the user switches to. This is what lets several agents each work a
   DIFFERENT notebook in one Cellar at the same time without stepping on each
   other — and it means your edits will NOT yank the user off the tab they are on
   (your notebook is surfaced as an available tab, but their focus is theirs).

   Declaring your notebook does not steal the user's focus, and the user switching
   tabs does not change your target. Use list_notebooks to discover names (each is
   flagged working=yours and active=the user's tab); current_notebook confirms
   where your edits land. If you never declare a working notebook, your tools fall
   back to the user's active tab — fine for a lone agent, but it means your target
   moves when the user switches tabs, so pin one when it matters. To reach into
   ANOTHER notebook for a single operation without changing your working notebook,
   pass that tool's optional notebook parameter (a workspace .ipynb path).

7. WRITE AND RUN TOGETHER. When you add a code cell you intend to execute, use
   add_and_run — it creates the cell and runs it in one call, returning the new
   cell id and the run result (outputs/errors) together, with fewer round-trips
   than add_cell followed by run_cell. Use add_and_run for markdown cells too, so
   they render instead of sitting as raw source. Reserve add_cell for code you are
   adding but will run later (a cell you want left un-run).

8. ONE KERNEL PER NOTEBOOK — ISOLATED NAMESPACES, PARALLEL EXECUTION. Each
   notebook has its OWN kernel (its own Python process, its own namespace), so
   your kernel tools act on YOUR working notebook and nothing else. Concretely:
     - Your namespace is yours. Variables, imports, functions, and spark/w a cell
       defines exist ONLY in your working notebook's kernel. Another notebook's
       variables are NOT visible to you, and yours are not visible to it — never
       assume a name defined in another notebook exists in yours (kernel_state /
       list_variables show what is actually defined here). Keep each notebook's
       story self-contained.
     - restart_kernel / interrupt_kernel affect ONLY your working notebook's
       kernel — a restart clears YOUR namespace and drops YOUR queued runs, never
       the user's other notebooks or another agent's. (Restart still reverts your
       cells to ran_this_session:false; do not restart casually.)
     - Runs serialize only within a notebook. Your notebook's kernel runs one cell
       at a time, so a run you request while YOUR notebook is busy (a human editing
       the same notebook, or your own earlier run) is QUEUED, never dropped —
       run_cell just takes longer to return and its result carries queued:true plus
       the position it waited at. A run in your notebook is NEVER queued behind a
       DIFFERENT notebook's cell; notebooks execute in parallel. Do not interrupt
       or restart just because a run is slow — that drops your own queued runs.
     - run_queue returns a per-notebook map ({working, notebooks:{path:{running,
       queue}}}) so you can see your own queue and whether other notebooks are busy.

9. DATABRICKS: USE THE SESSION, DO NOT BUILD ONE. kernel_state and
   get_notebook_map carry a "databricks" block for YOUR working notebook (each
   notebook has its own kernel, so its own session). When it says connected:true, a
   live Databricks Connect session is ALREADY bound in the namespace — spark (a
   Spark session on the named cluster) and w (a databricks.sdk WorkspaceClient).
   Use those names directly; never write connection boilerplate (no
   DatabricksSession.builder, no WorkspaceClient(...), no DATABRICKS_* env fiddling)
   — Cellar already did it and a second session would fight the first. Explore
   Unity Catalog with the databricks_* tools instead of adding a cell just to look
   at a table.

   WHAT YOU MAY AND MAY NOT DO WITH THE CONNECTION. You MAY restore a session that
   went dead: databricks_reconnect re-establishes the cluster the user ALREADY chose
   (it never picks a new one). You MAY connect a CHOSEN cluster: databricks_connect
   binds a cluster you selected (find one with databricks_list_clusters) — but only
   when auth needs no browser (a PAT profile, or an already-signed-in OAuth host);
   an un-signed-in OAuth host returns oauth_login_required, and the browser sign-in
   stays a HUMAN action (ask the user). You may NOT start, stop, or restart compute
   (a TERMINATED cluster → ask the user; agents cannot start clusters), and do NOT
   restart your kernel to "fix" Databricks — that just destroys the session.

   RECONNECT CAN RESTART YOUR KERNEL. Both databricks_reconnect and databricks_connect
   may need to re-pin databricks-connect, which restarts the kernel and CLEARS every
   variable. Check kernel_restarted / namespace_cleared in the result: when true,
   re-run your cells; when false your namespace was preserved. Never assume a
   reconnect was free.

   Expired sessions SELF-HEAL: when a spark.* cell fails with SESSION_CLOSED /
   "Spark Connect Session expired" / NO_ACTIVE_SESSION (a closed client), call
   databricks_status (or kernel_state) — that triggers Cellar's auto-reconnect — then
   re-run the failed cell. If a cell HANGS silently or status cannot confirm the
   session (e.g. the kernel SOCKET died, which the status probe cannot get through),
   call databricks_reconnect. (See the databricks_* tool docs for the
   reconnected:true / expired:true / kernel_restarted semantics.)

10. SQL CELLS RUN AGAINST spark. A cell can be type "sql" (cell_type:"sql", or
   set_cell_type). Its source is raw SQL — do NOT wrap it in spark.sql() or Python
   quotes; Cellar runs spark.sql(<your query>) and renders the result as an
   interactive grid, also binding it to _sql_df in the kernel so a following Python
   cell can chain off it. _sql_df is LAST-WRITE-WINS across the notebook, so with
   more than one SQL cell, NAME the binding: open the cell with a "-- >> sales_df"
   line (a plain SQL comment; must be the first non-blank line) and the result also
   binds to sales_df, which no later SQL cell clobbers. The name must be a valid
   Python identifier (an invalid one fails the cell with a message saying so). A
   named cell still sets _sql_df too, and the staleness graph treats the SQL cell as
   DEFINING the name, so a Python cell using it goes stale when you edit the query.
   SQL cells need the live spark session from clause 9 (with
   databricks connected:false they fail with a clear "connect Databricks" message).
   Prefer a sql cell when the query itself is the point; a python cell (or the
   databricks_* tools) when you need Python around it.

The goal: a notebook a human would be happy to have written — imports up top,
shared state, a clean section outline, and a continuous line of reasoning from
first cell to last.`;

function registerTools(server: McpServer) {
	// --- lifecycle ---
	server.registerTool('restart_kernel', { description: 'Restart YOUR working notebook\'s kernel (each notebook has its own): clears ONLY that notebook\'s namespace and opens a new kernel session, so its cells revert to ran_this_session:false. Also DROPS that notebook\'s queued runs (they were submitted against the namespace you are clearing). Other notebooks\' kernels — the user\'s, another agent\'s — are UNTOUCHED. Does NOT affect the MCP connection or document.', inputSchema: { ...notebookParam } }, async ({ notebook }, extra: ToolExtra) => text(await svc.kernel.restart(targetOf(extra, notebook))));
	server.registerTool('interrupt_kernel', { description: 'Interrupt YOUR working notebook\'s running kernel and drop its queued runs (stop means stop). Affects only your notebook\'s kernel; other notebooks are untouched.', inputSchema: { ...notebookParam } }, async ({ notebook }, extra: ToolExtra) => text(await svc.kernel.interrupt(targetOf(extra, notebook))));
	server.registerTool('kernel_status', { description: 'Status of YOUR working notebook\'s kernel, plus its live kernel session: {started, session_id, execs_this_session}. Each notebook has its own kernel, so this is about yours. execs_this_session:0 means no cell has run against this namespace yet, whatever the notebook\'s saved outputs suggest.', inputSchema: { ...notebookParam } }, async ({ notebook }, extra: ToolExtra) => text(svc.kernel.status(targetOf(extra, notebook))));
	server.registerTool('run_queue', { description: 'The run queue across notebooks as a per-notebook map: {working, notebooks:{"<path>":{running, queue}}}. `working` is YOUR working notebook\'s path. Each notebook has its OWN kernel running one cell at a time, so a run you request is QUEUED (never dropped) only behind YOUR notebook\'s own cells — it never waits on a different notebook, which runs in parallel. Each queue entry carries {nb, cellId, actor, position} (position 1 = next up); running is that notebook\'s executing cell (or null). A notebook with nothing running or queued is absent from the map. Reads only; never boots a kernel.', inputSchema: {} }, async (_args, extra: ToolExtra) => text(svc.getRunQueue(extra?.sessionId)));
	server.registerTool('list_notebooks', { description: 'List every .ipynb in the workspace (workspace-relative paths) so you can discover notebook names. Each entry is flagged `working` (THIS session\'s working notebook — where your edits land) and `active` (the notebook the USER is looking at). The two differ whenever you pinned a different notebook than the user\'s focused tab. Use use_notebook to set your working notebook.', inputSchema: {} }, async (_args, extra: ToolExtra) => text(svc.listNotebooks(extra?.sessionId)));
	server.registerTool('use_notebook', { description: 'DECLARE this session\'s working notebook (a workspace .ipynb) — OPEN-OR-CREATE: opens the named notebook, or CREATES it if it does not exist yet (omit name for an untitled new notebook) — the single tool for both opening and creating. From then on your read/write/run tools default to it — independent of which tab the USER has focused, and independent of what any OTHER agent is working on. This does NOT steal the user\'s focus: the notebook is surfaced as an available tab, but the user stays on whatever tab they are on. Call this FIRST when you start working, especially when several agents share one Cellar. Pass create_if_missing:false for open-only (error if the notebook does not exist) when you must NOT create. Pass a per-call `notebook` on an individual tool to reach across to another notebook once without changing your working notebook.', inputSchema: { name: z.string().optional(), create_if_missing: z.boolean().optional() } }, async ({ name, create_if_missing }, extra: ToolExtra) => { try { return text(svc.useNotebook(extra?.sessionId, name, create_if_missing ?? true)); } catch (e) { return notFound(String((e as Error)?.message ?? e)); } });
	server.registerTool('current_notebook', { description: 'Report THIS session\'s working notebook (where your edits land) and whether it is a genuine pin or the fallback to the user\'s active tab. When unpinned, your target follows the user\'s tab switches — call use_notebook to pin your own.', inputSchema: {} }, async (_args, extra: ToolExtra) => text(svc.currentNotebook(extra?.sessionId)));

	// --- read ---
	server.registerTool('get_notebook_map', { description: 'Compact hierarchical section tree (from markdown headers): id, type, header level/title, one-line summary, run status, staleness, has-output, visibility, plus a `kernel` header {started, session_id, execs_this_session} and a `display` header {header_numbering, report_view} carrying the notebook-level display-only settings. Not full content. header_numbering lists the heading levels Cellar auto-numbers ([] = off); a section in a numbered level also carries the `number` it renders with - that number is NOT in the cell source, so never write one there yourself (see set_header_numbering). report_view:true means every code cell is displayed output-only. Each code cell carries code_hidden:true when its input is EFFECTIVELY hidden (report_view on, or a per-cell override), and hide_input (true|false) only when it carries an EXPLICIT per-cell override of report_view — so a cell with hide_input:false and no code_hidden is one the user deliberately keeps shown even under report view (set/clear with set_hide_input). run_status separates LIVE from SAVED execution: ok_session/error_session = the cell ran in the CURRENT kernel session (ran_this_session:true); ok_persisted/error_persisted = the outputs were loaded from the .ipynb and are LEFTOVER from a previous session (ran_this_session:false) — nothing those cells define exists in the kernel. error_kernel_unavailable = the run could not reach a kernel at all, so this failure is LIVE, not leftover (nothing executed, so ran_this_session stays false). stale_state = not_run|fresh|stale|n/a; stale:true (with stale_reason + stale_upstream) means the cell ran this session but a cell it depends on has since changed (edited or re-run), so its output is OUT OF DATE — re-run it before trusting it. stale_state is a FLOOR, not a guarantee: it is derived from STATIC dataflow analysis plus run timestamps and never inspects the kernel namespace, so a dependency carried only through a conditional bind (if flag: df = load()) or through exec/globals() is invisible to it, and such a cell can report fresh while its output is already out of date (see cell_impact). has_output means a cell has saved output, never that it ran. Trust kernel_state, not saved outputs, for what is actually defined.', inputSchema: { ...notebookParam } }, async ({ notebook }, extra: ToolExtra) => text(await svc.getNotebookMap(targetOf(extra, notebook))));
	server.registerTool('kernel_state', { description: 'THE LIVE TRUTH about what is defined right now: the kernel namespace - imports already loaded, user-defined functions/classes, and variables (with types, shapes, dataframe columns), plus a `databricks` block saying whether a Databricks Connect session is bound (and to which profile/cluster), and `stale_cells` - the cells whose live output is now OUT OF DATE ([{id, reason, upstream}]) because a cell they depend on changed since they ran. The namespace, session_id, and `stale_cells` all reflect the kernel of YOUR working notebook (each notebook has its own kernel, isolated from the others). Returns {started:false} if no kernel is running (does not boot one); stale:true means the kernel restarted while reading, so the namespace below belongs to session_id and is already gone. Call this BEFORE writing code so you do not re-import modules or redefine names that already exist, and BEFORE depending on a variable an earlier cell defines - a cell can show saved outputs (run_status ok_persisted) yet never have run in this session. If a name is missing here, re-run the cell that defines it. Re-run (or distrust) everything in stale_cells before relying on it. If databricks.connected is true, `spark` and `w` are live: use them, never re-create them.', inputSchema: { ...notebookParam } }, async ({ notebook }, extra: ToolExtra) => text(await svc.getKernelState(targetOf(extra, notebook))));
	server.registerTool('list_variables', { description: 'YOUR working notebook\'s kernel namespace as structured data: every user DATA variable (modules/functions/classes/dunders are filtered out) with {name, type, repr_short, size}, and for pandas/spark DataFrames the SCHEMA {shape, columns:[{name, dtype}]}, for pandas Series {dtype, shape}, for numpy arrays {dtype, shape}. Each notebook has its own kernel, so this reflects yours. Read-only introspection - it runs NO user code and does not inflate execs_this_session. Use it to SEE the data (a DataFrame\'s columns, an array\'s shape) instead of guessing or adding a throwaway df.head() cell. Reflects only the LIVE kernel session: {started:false} if your kernel is not running (it does not boot one); stale:true means the kernel restarted while reading, so nothing listed exists any more.', inputSchema: { ...notebookParam } }, async ({ notebook }, extra: ToolExtra) => text(await svc.getVariables(targetOf(extra, notebook))));
	server.registerTool('inspect_variable', { description: 'Detailed view of ONE live variable by name in YOUR working notebook\'s kernel: full type, shape/len, and kind-specific detail - a DataFrame\'s columns+dtypes plus a small head sample (first rows), a Series\' dtype+head, a numpy array\'s dtype/shape/stats+head, a dict\'s keys, a sequence\'s first items. Bounded (rows/keys/items capped) so a huge object never floods output; a Spark DataFrame returns its schema only (never collected, so no job is triggered). Read-only - runs NO user code, exec count unaffected. Prefer this over adding a df.head() cell just to look. Returns {found:false} when the name is not defined in your notebook\'s namespace, {started:false} when your kernel is not running. Reflects only the LIVE kernel session.', inputSchema: { name: z.string(), ...notebookParam } }, async ({ name, notebook }, extra: ToolExtra) => text(await svc.inspectVariable(name, targetOf(extra, notebook))));
	server.registerTool('read_cells', { description: 'Read ONE OR SEVERAL cells by id/handle (a single-element ids array reads one cell; many reads many). Returns each cell\'s source + summarized outputs, carrying the same per-cell ran_this_session/run_status/stale semantics as get_notebook_map (ok_session = ran live this session; ok_persisted = saved leftover; error_kernel_unavailable = a LIVE kernel-down failure; stale ⇒ re-run before trusting the output).', inputSchema: { ids: z.array(z.string()), ...notebookParam } }, async ({ ids, notebook }, extra: ToolExtra) => { const target = targetOf(extra, notebook); const res = resolveMany(target, ids); if ('error' in res) return res.error; return text(await svc.readCells(res.ids, target)); });
	server.registerTool('read_by_location', { description: 'Read a cell by location: index (0-based over visible cells), position first/last, or next/prev of a cell.', inputSchema: { index: z.number().int().optional(), position: z.enum(['first', 'last']).optional(), relative_to: z.string().optional(), direction: z.enum(['next', 'prev']).optional(), ...notebookParam } }, async ({ index, position, relative_to, direction, notebook }, extra: ToolExtra) => { const target = targetOf(extra, notebook); let relTo = relative_to; if (relative_to != null) { const res = resolveOne(target, relative_to); if ('error' in res) return res.error; relTo = res.id; } const r = await svc.readByLocation({ index, position, relativeTo: relTo, direction }, target); return r ? text(r) : notFound('no cell at that location'); });
	server.registerTool('read_section', { description: 'Read all cells under a markdown header (until the next same-or-higher header). The header carries its display-only auto-`number` when its level is numbered; that number is rendered, not stored, so it is absent from the cell source the read returns.', inputSchema: { header_id: z.string(), ...notebookParam } }, async ({ header_id, notebook }, extra: ToolExtra) => { const target = targetOf(extra, notebook); const res = resolveOne(target, header_id); if ('error' in res) return res.error; const r = await svc.readSection(res.id, target); return r ? text(r) : notFound(`${header_id} is not a visible header cell`); });
	server.registerTool('search_cells', { description: 'Free-text search over cell SOURCE and saved OUTPUT text; returns ids + snippets. Substring match, NOT scope-aware — a hit in a comment, a string literal, or an output counts. To answer "where is <name> DEFINED / which cells USE it", prefer find_symbol (dataflow-precise, never a false hit in a comment/string). Snippet fields carry the same ran_this_session/run_status semantics as read_cells/get_notebook_map (ran_this_session:false ⇒ the output is a leftover from a previous session; kernel_state is the live truth).', inputSchema: { query: z.string(), in: z.enum(['input', 'output', 'both']).optional(), ...notebookParam } }, async ({ query, in: where, notebook }, extra: ToolExtra) => text(svc.searchCells(query, where ?? 'both', targetOf(extra, notebook))));
	server.registerTool('find_symbol', { description: 'Locate a Python name across the notebook by DATAFLOW, not text: the cell(s) that DEFINE it (assignment/import/def/class, in document order) and the cells that USE it (each resolved to the definition it binds to). Scope-aware — a match in a comment or string is never reported, and a definition is never confused with a use (unlike search_cells). Returns {symbol, defined_in:[ids], used_in:[{cell, binds_to}], live_definer?, live_in_kernel?, hidden_definer?}. binds_to = the nearest PRECEDING definer that use resolves to (null = a forward reference, or the binding definer is hidden). live_definer = the last visible definer whose value is actually live in the current kernel session. live_in_kernel reconciles against the running kernel: true = the name is defined in the namespace now, false = only in source (unrun or redefined since), ABSENT = no live kernel to check. hidden_definer:true means a definer is hidden from you, so some info is suppressed. Use this for "where is df / clean / Model defined?" and "which cells would I touch if I rename it?" without reading the whole notebook. LIMITS (static source analysis): a conditional bind (if flag: df = load()) hides that cell\'s later read of df; names created dynamically (exec, globals(), star-import) are invisible — kernel_state is the live-truth fallback; def/class vs variable is not distinguished. get_notebook_map stale_state and cell_impact are derived from this SAME static graph plus run timestamps, so they inherit these limits rather than covering them - treat none of the three as a runtime check of the kernel.', inputSchema: { name: z.string(), ...notebookParam } }, async ({ name, notebook }, extra: ToolExtra) => text(await svc.findSymbol(name, targetOf(extra, notebook))));
	server.registerTool('cell_impact', { description: 'The dependency blast radius of ONE cell, by DATAFLOW: `depends_on` = the cells whose definitions this cell READS (its direct upstream), `dependents` = the cells that would become STALE if you EDIT this one (transitive downstream, document order). Returns {cell, depends_on:[ids], dependents:[ids]}. Use BEFORE editing a cell that defines a name others use, to see exactly what run_stale will re-run. Derived from the SAME dataflow graph as staleness and find_symbol — scope-aware (a name in a comment/string is never counted). `depends_on` answers this before an edit, adding the downstream direction stale_upstream (which only appears once a cell is ALREADY stale) never surfaces. LIMIT (static source analysis, honest under-report): a dependency carried only through a conditional bind (if flag: df = load(), then df.head()), a `global`-declared augmented assignment inside a function, or exec/globals() is INVISIBLE to the graph, so a data cell can under-report `dependents`. NOTHING catches this at run time: get_notebook_map\'s stale_state is computed from this SAME static graph plus run timestamps and never inspects the kernel namespace, so it under-reports IDENTICALLY - a cell whose upstream you edited can report stale_state fresh while its output is already out of date. Neither signal is a backstop for the other. When you edit a cell that defines a name, re-run the downstream cells yourself (or restart_kernel + run_all) rather than trusting an absent dependent. A markdown/unknown cell yields empty lists.', inputSchema: { id: z.string(), ...notebookParam } }, async ({ id, notebook }, extra: ToolExtra) => { const target = targetOf(extra, notebook); const res = resolveOne(target, id); if ('error' in res) return res.error; return text(await svc.cellImpact(res.id, target)); });
	server.registerTool('get_errors', { description: 'List cells whose latest output is an error (ename/evalue/traceback). Each entry carries the same run_status/ran_this_session semantics as read_cells/get_notebook_map: ran_this_session:false errors are leftovers from a previous session — EXCEPT kernel_unavailable:true (run_status error_kernel_unavailable), a LIVE kernel-down failure to fix, not ignore as stale.', inputSchema: { ...notebookParam } }, async ({ notebook }, extra: ToolExtra) => text(svc.getErrors(targetOf(extra, notebook))));
	server.registerTool('get_full_output', { description: 'Fuller cell outputs. Medium-capped by default; size=full returns everything. Images are returned as real MCP image blocks. An oversized image (a retina/high-DPI plot) is DOWNSCALED to ~768px on the longest edge on the default (medium) path to save image tokens - the block carries a `downscaled:{from,to}` note when this happened; call again with size=full to get the ORIGINAL full-resolution image bytes untouched. Output fields carry the same ran_this_session/run_status semantics as read_cells/get_notebook_map (ran_this_session:false ⇒ leftover from a previous session; kernel_state is the live truth).', inputSchema: { id: z.string(), size: z.enum(['medium', 'full']).optional(), ...notebookParam } }, async ({ id, size, notebook }, extra: ToolExtra) => {
		const target = targetOf(extra, notebook);
		const res = resolveOne(target, id);
		if ('error' in res) return res.error;
		const r = svc.getFullOutput(res.id, size ?? 'medium', target);
		if (!r) return notFound(`cell ${id} not found or hidden`);
		// Tool result content is a text summary plus one image block per image output.
		type TextBlock = { type: 'text'; text: string };
		type ImageBlock = { type: 'image'; data: string; mimeType: string };
		const content: Array<TextBlock | ImageBlock> = [{ type: 'text', text: JSON.stringify({ id: r.id, size: r.size, ran_this_session: r.ran_this_session, outputs: r.outputs.map((o) => (o.data ? { type: o.type, image: o.image, ...(o.downscaled ? { downscaled: o.downscaled } : {}) } : o)) }) }];
		for (const o of r.outputs) if (o.data) content.push({ type: 'image', data: String(o.data), mimeType: String(o.image) });
		return { content };
	});

	// --- write ---
	server.registerTool('add_cell', { description: `Add a cell (optionally after a cell), of type code|sql|markdown, with optional source. A sql cell holds a SQL query that runs against the connected Databricks spark session (see doctrine clause 10). Adds only - it does NOT run or render the cell (a markdown cell added this way stays raw source until rendered; prefer add_and_run for markdown/sql).${ROUTE_IMPORTS_PTR}`, inputSchema: { after_id: z.string().optional(), cell_type: z.enum(['code', 'sql', 'markdown']).optional(), source: z.string().optional(), route_imports: z.boolean().optional(), ...notebookParam } }, async ({ after_id, cell_type, source, route_imports, notebook }, extra: ToolExtra) => {
		const target = targetOf(extra, notebook);
		let after = after_id;
		if (after_id != null) { const res = resolveOne(target, after_id); if ('error' in res) return res.error; after = res.id; }
		const { ids, imports } = await svc.addCells([{ cell_type, source }], after, { routeImports: route_imports ?? true, nb: target });
		// Source that was nothing but imports creates no cell of its own — they went
		// straight to the imports cell, which is then the cell this call produced.
		return ids.length
			? text({ id: ids[0], ...(imports ? { imports } : {}) })
			: text({ id: imports!.cell_id, routed_to_imports: true, imports });
	});
	server.registerTool('add_cells', { description: `Add multiple cells in order (optionally after a cell).${ROUTE_IMPORTS_PTR}`, inputSchema: { cells: z.array(z.object({ cell_type: z.enum(['code', 'sql', 'markdown']).optional(), source: z.string().optional() })), after_id: z.string().optional(), route_imports: z.boolean().optional(), ...notebookParam } }, async ({ cells, after_id, route_imports, notebook }, extra: ToolExtra) => { const target = targetOf(extra, notebook); let after = after_id; if (after_id != null) { const res = resolveOne(target, after_id); if ('error' in res) return res.error; after = res.id; } return text(await svc.addCells(cells, after, { routeImports: route_imports ?? true, nb: target })); });
	server.registerTool('edit_cell', { description: `Replace a cell source in place.${ROUTE_IMPORTS_PTR} (Editing the imports cell itself never routes — you are already writing into it.)`, inputSchema: { id: z.string(), source: z.string(), route_imports: z.boolean().optional(), ...notebookParam } }, async ({ id, source, route_imports, notebook }, extra: ToolExtra) => {
		const target = targetOf(extra, notebook);
		const res = resolveOne(target, id);
		if ('error' in res) return res.error;
		const r = await svc.editCell(res.id, source, { routeImports: route_imports ?? true, nb: target });
		return r ? text(r) : notFound(`cell ${id} not found`);
	});
	server.registerTool('consolidate_imports', { description: 'Sweep every MODULE-LEVEL import in your working notebook into its single "imports" cell (the user-designated cell wherever it sits, or created at the top on demand; deduplicated, __future__ first, canonically ordered), strip those lines from the cells they came from, and run the imports cell so the kernel has them. Imports nested inside a def/class/if/try body are deliberately left alone — a nested import is a choice (lazy loading, TYPE_CHECKING), not an accident. Idempotent: running it twice changes nothing and re-runs nothing.', inputSchema: { ...notebookParam } }, async ({ notebook }, extra: ToolExtra) => text(await svc.consolidate(targetOf(extra, notebook))));
	server.registerTool('create_checkpoint', { description: 'Snapshot your working notebook (cells + source + outputs + metadata) to a restorable checkpoint the human can revert to. Cellar already takes an automatic checkpoint before your mutations and runs (throttled to one per several actions), so you rarely need this — call it only to mark a deliberate restore point before a risky change. Returns the checkpoint metadata {id, at, trigger, label, cellCount}.', inputSchema: { label: z.string().optional(), ...notebookParam } }, async ({ label, notebook }, extra: ToolExtra) => text(svc.checkpoint(label, targetOf(extra, notebook))));
	server.registerTool('export_html', { description: 'Export your working notebook to ONE self-contained HTML file on disk (rendered markdown, syntax-highlighted code, and every persisted output inlined — no server, no network needed to open it). Renders the notebook\'s LAST-RUN saved outputs; it never touches the kernel. hide_code:true produces a clean REPORT (markdown + outputs, no code) — note a report DROPS code cells that have no output (imports, `df = load()`); hide_code:false forces code shown; OMIT hide_code to follow the notebook\'s own "hide all code" setting. Writes alongside the notebook as <name>.html by default, or to an explicit workspace-relative `path` (a `.html` extension is added if missing); both are confined to the workspace. Returns the file LOCATION + metadata {path, bytes, hide_code}, NOT the HTML body (it would be huge) — read the file if you need its contents.', inputSchema: { hide_code: z.boolean().optional(), path: z.string().optional(), ...notebookParam } }, async ({ hide_code, path, notebook }, extra: ToolExtra) => text(svc.exportHtml({ hideCode: hide_code, path, nb: targetOf(extra, notebook) })));
	server.registerTool('delete_cell', { description: 'Delete a cell.', inputSchema: { id: z.string(), ...notebookParam } }, async ({ id, notebook }, extra: ToolExtra) => { const target = targetOf(extra, notebook); const res = resolveOne(target, id); if ('error' in res) return res.error; return svc.removeCell(res.id, target) ? text({ ok: true }) : notFound(`cell ${id} not found`); });
	server.registerTool('move_cell', { description: 'Move a cell to an absolute index.', inputSchema: { id: z.string(), position: z.number().int(), ...notebookParam } }, async ({ id, position, notebook }, extra: ToolExtra) => { const target = targetOf(extra, notebook); const res = resolveOne(target, id); if ('error' in res) return res.error; return svc.moveCell(res.id, position, target) ? text({ ok: true }) : notFound(`cell ${id} not found`); });
	server.registerTool('set_cell_type', { description: 'Set a cell type to code, sql, or markdown. sql tags the code cell as a SQL query (runs against the connected Databricks spark session); code reverts it to Python.', inputSchema: { id: z.string(), cell_type: z.enum(['code', 'sql', 'markdown']), ...notebookParam } }, async ({ id, cell_type, notebook }, extra: ToolExtra) => { const target = targetOf(extra, notebook); const res = resolveOne(target, id); if ('error' in res) return res.error; return svc.setType(res.id, cell_type, target) ? text({ ok: true }) : notFound(`cell ${id} not found`); });
	server.registerTool('set_cell_visibility', { description: 'Show/hide a cell from the agent (cellar.hidden_from_agent).', inputSchema: { id: z.string(), hidden: z.boolean(), ...notebookParam } }, async ({ id, hidden, notebook }, extra: ToolExtra) => { const target = targetOf(extra, notebook); const res = resolveOne(target, id); if ('error' in res) return res.error; return svc.setCellVisibility(res.id, hidden, target) ? text({ ok: true, id: svc.handleFor(target, res.id), hidden }) : notFound(`cell ${id} not found`); });

	server.registerTool('set_header_numbering', { description: 'Set WHICH markdown heading levels render with an automatic number, for your working notebook (levels:[2] numbers every H2 "1.", "2."; levels:[1,2] numbers hierarchically "1.", "1.1"; levels:[] turns numbering off). Notebook-level and DISPLAY-ONLY: the numbers are computed at render time and no cell source is ever edited, so never type a number into a header yourself. Returns the sanitized levels actually stored (deduped, 1-6, ascending) and how many headings now carry a number. get_notebook_map reports the current levels plus each section\'s number.', inputSchema: { levels: z.array(z.number().int().min(1).max(6)), ...notebookParam } }, async ({ levels, notebook }, extra: ToolExtra) => text(svc.setHeaderNumbering(levels, targetOf(extra, notebook))));
	server.registerTool('set_report_view', { description: 'Turn the notebook-wide report view on/off for your working notebook (enabled:true = report view ON: every code cell renders its OUTPUT only, with its code input hidden, so a human reads results and markdown without the code; enabled:false = code shown again). Display-only - no source is touched and cells still run normally. A per-cell override (see set_hide_input) can still show or hide an individual cell\'s code regardless of this. Returns the resulting report_view state; get_notebook_map reports whether it is on.', inputSchema: { enabled: z.boolean(), ...notebookParam } }, async ({ enabled, notebook }, extra: ToolExtra) => text(svc.setReportView(enabled, targetOf(extra, notebook))));
	server.registerTool('set_hide_input', { description: 'Show or hide ONE code cell\'s input, overriding report view for that cell (hidden:true = force this cell\'s code hidden; hidden:false = force it shown even under report view; hidden:null = clear the per-cell choice so it follows the notebook-wide report_view again). Per-cell hide_input ALWAYS wins over the notebook-wide default (set_report_view), so this is how you keep one cell\'s code visible in a report, or hide a single cell without report view. Display-only - no source is touched and the cell still runs. Only a code cell can hide its input (markdown has no code to hide). Returns {hide_input (the explicit value or null), code_hidden (the effective state after precedence), report_view (the notebook default)}; get_notebook_map reports code_hidden per cell (and hide_input where a cell carries an explicit override).', inputSchema: { id: z.string(), hidden: z.boolean().nullable(), ...notebookParam } }, async ({ id, hidden, notebook }, extra: ToolExtra) => { const target = targetOf(extra, notebook); const res = resolveOne(target, id); if ('error' in res) return res.error; const r = svc.setHideInput(res.id, hidden, target); return r.ok ? text({ id: svc.handleFor(target, res.id), ...r }) : notFound(`cell ${id} is not a code cell (only a code cell can hide its input)`); });

	// --- execute ---
	server.registerTool('add_and_run', { description: `PREFERRED write-and-execute: create a cell AND run it in one call (fewer round-trips than add_cell then run_cell). Adds a code|sql|markdown cell (default code) with the given source, after a cell (after_id) or appended at the end, runs it, and returns run_cell's result (status + outputs) plus the new cell id. Code that raises returns the error as the result (does not fail — the cell still exists). A markdown cell_type is created AND rendered (markdown does not execute on the kernel - running it renders it, status "rendered"); this is the way to add markdown so it shows rendered rather than raw source. Use add_cell (no run) only when you want to add a cell WITHOUT running/rendering it.${ROUTE_IMPORTS_DOC} Routing happens BEFORE this cell runs, so an import it needs is already in the kernel. Source that is ONLY imports creates no cell at all (they go straight to the imports cell) and returns routed_to_imports:true.`, inputSchema: { source: z.string(), cell_type: z.enum(['code', 'sql', 'markdown']).optional(), after_id: z.string().optional(), route_imports: z.boolean().optional(), ...notebookParam } }, async ({ source, cell_type, after_id, route_imports, notebook }, extra: ToolExtra) => { const target = targetOf(extra, notebook); let after = after_id; if (after_id != null) { const res = resolveOne(target, after_id); if ('error' in res) return res.error; after = res.id; } return text(await withProgress(extra, () => svc.addAndRun({ source, cellType: cell_type, afterId: after, routeImports: route_imports ?? true, nb: target }))); });
	server.registerTool('run_cell', { description: 'Run one cell by handle (or full UUID). Running a markdown cell RENDERS it (no code executes) and returns status "rendered"; use this (or add_and_run) so markdown shows rendered rather than raw source. Your notebook\'s kernel runs one cell at a time: if IT is busy your run is QUEUED (never dropped) and this call waits its turn, then returns the real outputs annotated queued:true + queue_position + waited_ms. A run in another notebook never queues this one (parallel kernels). If that cell is ALREADY queued (or running) it is not enqueued twice - the call returns immediately with status "queued" (or "running") and its queue_position; a pending run has its source refreshed to the current one. status "cancelled" means an interrupt/restart dropped the queued run before it started; nothing executed. See run_queue.', inputSchema: { id: z.string(), ...notebookParam } }, async ({ id, notebook }, extra: ToolExtra) => { const target = targetOf(extra, notebook); const res = resolveOne(target, id); if ('error' in res) return res.error; const r = await withProgress(extra, () => svc.runCell(res.id, target)); return r ? text(r) : notFound(`cell ${id} not found`); });
	server.registerTool('run_cells', { description: 'Run multiple cells in order, each waiting its turn in the kernel queue. Returns a COMPACT batch summary {ran, errored, results}: ran/errored count how many cells executed/raised; results is one record per cell. An OK cell is a status line only — {id, run_status, has_output, plus stale fields if still stale} — its full output is NOT inlined but is one get_full_output(id) call away. An ERRORED cell carries its {ename, evalue, traceback} in full (READ_CAP-capped, library frames elided, same as run_cell; the whole stack via get_full_output(id, size:"full")), so a batch failure is actionable without a second call. Stops at the first cell whose queued run an interrupt/restart cancelled (that record has status "cancelled") - the rest would run against a namespace their predecessors never populated.', inputSchema: { ids: z.array(z.string()), ...notebookParam } }, async ({ ids, notebook }, extra: ToolExtra) => { const target = targetOf(extra, notebook); const res = resolveMany(target, ids); if ('error' in res) return res.error; return text(await withProgress(extra, () => svc.runCells(res.ids, target))); });
	server.registerTool('run_all', { description: 'Run all code cells in document order. Returns the same compact {ran, errored, results} batch summary as run_cells (OK cells as status lines with output one get_full_output away; errored cells with full traceback), and the same queueing + cancellation semantics.', inputSchema: { ...notebookParam } }, async ({ notebook }, extra: ToolExtra) => text(await withProgress(extra, () => svc.runAll(targetOf(extra, notebook)))));
	server.registerTool('run_stale', { description: 'Re-run every STALE code cell (a cell that ran this session but whose inputs changed since) in dependency order, bringing the notebook back in sync with its current code. Returns the same compact {ran, errored, results} batch summary as run_cells — the per-cell records name every cell that ran, so there is no separate id list. Use this after editing an upstream cell instead of hunting down every downstream cell by hand; see stale_cells in kernel_state / stale_state in get_notebook_map for what is stale. Same queueing + cancellation semantics as run_cells.', inputSchema: { ...notebookParam } }, async ({ notebook }, extra: ToolExtra) => text(await withProgress(extra, () => svc.runStale(targetOf(extra, notebook)))));
	server.registerTool('run_range', { description: 'Run code cells in the inclusive range from one cell to another. Returns the same compact {ran, errored, results} batch summary as run_cells (OK cells as status lines with output one get_full_output away; errored cells with full traceback), and the same queueing + cancellation semantics.', inputSchema: { from_id: z.string(), to_id: z.string(), ...notebookParam } }, async ({ from_id, to_id, notebook }, extra: ToolExtra) => { const target = targetOf(extra, notebook); const rf = resolveOne(target, from_id); if ('error' in rf) return rf.error; const rt = resolveOne(target, to_id); if ('error' in rt) return rt.error; return text(await withProgress(extra, () => svc.runRange(rf.id, rt.id, target))); });

	// --- databricks (reconnect + gated connect; compute lifecycle stays human-only) ---
	server.registerTool('databricks_status', { description: 'Whether a Databricks Connect session is LIVE in YOUR working notebook\'s kernel, and against which profile/cluster/host. Each notebook has its OWN kernel and its OWN Databricks session, so this reports your notebook\'s connection - another notebook may be connected to a different cluster, or not at all. When connected:true, `spark` (a Spark session on that cluster) and `w` (a databricks.sdk WorkspaceClient) are bound in the kernel namespace and verified reachable - use them directly instead of writing connection boilerplate. Liveness is checked with a cheap cached `SELECT 1` probe (short TTL, skipped while the kernel is busy) plus the client\'s synchronous `spark._client.is_closed` flag, so a session that expired server-side (idle timeout / cluster GC) OR whose Spark Connect client was closed locally (surfacing as NO_ACTIVE_SESSION) is caught even though `spark` is still bound. On expiry Cellar AUTO-RECONNECTS against the same profile+cluster: a healed response is connected:true with reconnected:true (re-run any cell that failed with SESSION_CLOSED). If auto-reconnect fails it returns connected:false with expired:true - call databricks_reconnect (it also repairs a dropped kernel socket that a status probe cannot get through), or ask the user to reconnect from the sidebar, then re-run. connected:true with liveness_unverified:true means liveness could not be confirmed (kernel busy or a transient error), not that it is dead. connected:false without expired means no session at all: ask the user to connect (or databricks_connect a chosen cluster). May run a tiny kernel probe; never boots a kernel. The same block appears in kernel_state and get_notebook_map.', inputSchema: { ...notebookParam } }, async ({ notebook }, extra: ToolExtra) => text(await svc.databricks.status(targetOf(extra, notebook))));
	server.registerTool('databricks_reconnect', { description: 'RESTORE a dead Databricks Connect session in YOUR working notebook against the cluster it was LAST connected to (the profile+cluster the USER already chose — this NEVER picks a new one). Use it when a `spark.*` cell fails and databricks_status cannot confirm/heal — a kernel-socket drop (the status probe itself cannot get through), a server-side expiry (SESSION_CLOSED / "Spark Connect Session expired" / NO_ACTIVE_SESSION), or a kernel restart. Walks the one recovery ladder cheapest-first: refresh a dropped kernel socket in place (namespace intact), else rebuild an expired session, else re-establish after a kernel restart. Returns connected:true with reconnected:true when `spark`/`w` are live again (then re-run any failed cell). IT CAN RESTART YOUR KERNEL: if Cellar must re-pin databricks-connect the response carries kernel_restarted:true + namespace_cleared:true — then every Python variable is GONE (re-run your cells); on a plain socket/session repair both are false and your namespace is preserved. Errors: not_connected = no prior connection to restore (ask the user to connect, or databricks_connect a chosen cluster); cluster_terminated = the cluster is stopped (agents cannot start compute — ask the user); kernel_unavailable = no live kernel to restore into (run a cell to boot one). May take a while while re-pinning (progress is reported). Prefer this over restart_kernel, which just destroys the session.', inputSchema: { ...notebookParam } }, async ({ notebook }, extra: ToolExtra) => databricksTool(() => withProgress(extra, () => svc.databricks.reconnect(targetOf(extra, notebook)))));
	server.registerTool('databricks_list_clusters', { description: 'List the workspace\'s attachable clusters (read-only discovery), so you can pick one for databricks_connect or report their state to the user: [{cluster_id, name, state, spark_version, node_type}], RUNNING first. Auth comes from an explicit `profile` (a ~/.databrickscfg profile name) or `host`, or — if you pass neither — YOUR working notebook\'s existing connection. This is READ-ONLY: it never starts, stops, or restarts a cluster (compute lifecycle is human-only — if a cluster you need is TERMINATED, tell the user to start it). Runs the Databricks SDK server-side (not in the kernel). Errors: oauth_login_required = the host needs a human browser sign-in (ask the user); not_connected = give a `profile` or ask the user to connect first.', inputSchema: { profile: z.string().optional(), host: z.string().optional(), ...notebookParam } }, async ({ profile, host, notebook }, extra: ToolExtra) => databricksTool(() => svc.databricks.listClusters({ profile, host }, targetOf(extra, notebook))));
	server.registerTool('databricks_connect', { description: 'CONNECT your working notebook to a CHOSEN cluster (find one with databricks_list_clusters). Binds `spark` + `w` in the kernel via Cellar\'s normal connect path (same auth + version-pin as the sidebar). GATED: it only proceeds when auth needs NO human browser — a PAT profile, or an OAuth host already signed in; an un-signed-in OAuth host returns oauth_login_required (ask the user to sign in from the Databricks sidebar — agents cannot drive the browser). It does NOT start compute: a TERMINATED/stopped cluster returns cluster_terminated (ask the user to start it). SIDE EFFECT: to match the cluster\'s runtime Cellar may reinstall databricks-connect (seconds to a minute — progress is reported), and if the client was already imported this RESTARTS your kernel — the response then carries kernel_restarted:true + namespace_cleared:true (re-run your cells); otherwise both are false and your namespace is preserved. Pass `cluster_id` plus a `profile` (a ~/.databrickscfg profile name) or `host`. To merely RESTORE a session that just died against the cluster the user already chose, prefer databricks_reconnect.', inputSchema: { cluster_id: z.string(), cluster_name: z.string().optional(), profile: z.string().optional(), host: z.string().optional(), ...notebookParam } }, async ({ cluster_id, cluster_name, profile, host, notebook }, extra: ToolExtra) => databricksTool(() => withProgress(extra, () => svc.databricks.connect({ clusterId: cluster_id, clusterName: cluster_name, profile, host, nb: targetOf(extra, notebook) }))));
	server.registerTool('databricks_list_catalogs', { description: 'List the Unity Catalog catalogs your working notebook\'s connected workspace exposes: [{name, comment}]. Runs the Databricks SDK server-side (not in the kernel), so it never queues behind a running cell. Fails with error "not_connected" when your notebook has no live session.', inputSchema: { ...notebookParam } }, async ({ notebook }, extra: ToolExtra) => databricksTool(() => svc.databricks.catalogs(targetOf(extra, notebook))));
	server.registerTool('databricks_list_schemas', { description: 'List the schemas in one Unity Catalog catalog: [{name, comment}]. Server-side SDK call. Fails with error "not_connected" when your notebook has no live session, "not_found" when the catalog does not exist, "permission_denied" when you cannot see it.', inputSchema: { catalog: z.string(), ...notebookParam } }, async ({ catalog, notebook }, extra: ToolExtra) => databricksTool(() => svc.databricks.schemas(catalog, targetOf(extra, notebook))));
	server.registerTool('databricks_list_tables', { description: 'List the tables in one Unity Catalog schema: [{name, full_name, table_type, format}]. Use full_name with databricks_preview_table or spark.read.table(). Server-side SDK call. Fails with error "not_connected" when your notebook has no live session.', inputSchema: { catalog: z.string(), schema: z.string(), ...notebookParam } }, async ({ catalog, schema, notebook }, extra: ToolExtra) => databricksTool(() => svc.databricks.tables(catalog, schema, targetOf(extra, notebook))));
	server.registerTool('databricks_preview_table', { description: 'Read the first `limit` rows of a table (default 20, max 1000) through YOUR working notebook\'s live `spark`, and return {name, limit, schema:[{name,type}], rows:[{column: value}]}. Prefer this over adding a cell when you are only orienting yourself: it reads the table WITHOUT touching the notebook. When the query belongs in the notebook\'s story, add_and_run a cell with spark.read.table(...) instead. `name` is catalog.schema.table (a two-part schema.table is accepted for legacy metastores). Fails with error "not_connected" when your notebook has no live session, "read_failed" when Spark rejects the read.', inputSchema: { name: z.string(), limit: z.number().int().min(1).max(1000).optional(), ...notebookParam } }, async ({ name, limit, notebook }, extra: ToolExtra) => databricksTool(() => svc.databricks.preview(name, limit ?? 20, targetOf(extra, notebook))));

	// --- prompt: the house style as a surfaceable slash-command ---
	server.registerPrompt('cellar_notebook_style', { description: "Cellar's house style for building one coherent notebook." }, () => ({
		messages: [{ role: 'user', content: { type: 'text', text: INSTRUCTIONS } }]
	}));
}

/** Read and JSON-parse a Node request body. */
function readBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let data = '';
		req.on('data', (c) => (data += c));
		req.on('end', () => {
			try {
				resolve(data ? JSON.parse(data) : undefined);
			} catch (e) {
				reject(e);
			}
		});
		req.on('error', reject);
	});
}

let started = false;
// One-time start guard shared across module instances via globalThis.
const g = globalThis as typeof globalThis & { __cellarMcpStarted?: boolean };

/** Start the in-process MCP HTTP server once. */
export function startMcpServer() {
	if (started || g.__cellarMcpStarted) return;
	started = true;
	g.__cellarMcpStarted = true;

	const port = Number(process.env.CELLAR_MCP_PORT || 39587);
	// Bind loopback by default (a local, single-user tool). In a container the
	// port is published, and Docker forwards to the container's external
	// interface, not loopback — so CELLAR_MCP_HOST=0.0.0.0 makes the MCP endpoint
	// reachable from the host. Opt-in only; nothing changes for a local run.
	const host = process.env.CELLAR_MCP_HOST || '127.0.0.1';
	// Every session owns a full McpServer (~30 registered tools) + transport + its
	// per-session service state (the pinned notebook). The registry is the single
	// owner of that lifecycle: `forget(sid)` closes the McpServer (dropping its
	// registrations + transport) AND clears the service-layer pin, and its `unref`'d
	// idle reaper reclaims sessions whose bridge died uncleanly (SIGKILL never fires
	// onclose) via that same path — so neither a clean nor an unclean disconnect
	// leaks. Forgetting a session is shared-resource-safe: it never shuts a kernel
	// or closes a notebook doc (both shared across sessions + the UI).
	const sessions = new McpSessionRegistry<McpServer, StreamableHTTPServerTransport>(svc.forgetSession);
	// The idle window + scan interval default to the module constants; both are
	// env-overridable so an operator can tune them (and a test can force the idle
	// path with a short threshold) without a rebuild.
	const idleMs = Number(process.env.CELLAR_MCP_SESSION_IDLE_MS) || SESSION_IDLE_MS;
	const reaperMs = Number(process.env.CELLAR_MCP_REAPER_INTERVAL_MS) || REAPER_INTERVAL_MS;
	sessions.startReaper(reaperMs, idleMs);

	const httpServer = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? '', 'http://localhost');
		if (url.pathname !== '/mcp') {
			res.writeHead(404).end('not found');
			return;
		}
		try {
			if (req.method === 'POST') {
				const body = await readBody(req);
				// The MCP session id header is single-valued.
				const sid = req.headers['mcp-session-id'] as string | undefined;
				const existing = sid ? sessions.get(sid) : undefined;
				if (sid && existing) sessions.touch(sid); // keep an active session from being reaped
				let transport = existing?.transport;
				if (!transport && isInitializeRequest(body)) {
					const server = new McpServer({ name: 'cellar', version: '0.1.0' }, { instructions: INSTRUCTIONS });
					registerTools(server);
					const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
						sessionIdGenerator: () => randomUUID(),
						onsessioninitialized: (id: string) => {
							sessions.register(id, { server, transport: created, lastActivity: Date.now() });
						}
					});
					// A clean disconnect closes the transport; do the FULL teardown, not
					// just a transport delete. `forget` removes the entry before closing
					// the server, so this re-entrant onclose is then a harmless no-op.
					created.onclose = () => {
						if (created.sessionId) sessions.forget(created.sessionId);
					};
					transport = created;
					await server.connect(created);
				}
				if (!transport) {
					res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session; send an initialize request first.' }, id: null }));
					return;
				}
				await transport.handleRequest(req, res, body);
			} else if (req.method === 'GET' || req.method === 'DELETE') {
				const sid = req.headers['mcp-session-id'] as string | undefined;
				const entry = sid ? sessions.get(sid) : undefined;
				if (!entry) {
					res.writeHead(400).end('missing or unknown session');
					return;
				}
				sessions.touch(sid!);
				await entry.transport.handleRequest(req, res);
			} else {
				res.writeHead(405).end('method not allowed');
			}
		} catch (err) {
			if (!res.headersSent) res.writeHead(500).end('mcp error: ' + String(err));
		}
	});

	// A run tool holds its POST response open for the ENTIRE cell run (streaming
	// progress notifications meanwhile), which for a long cell is minutes. Node's
	// default `requestTimeout` (300s) is measured from first byte to the request
	// being fully RECEIVED — the body here arrives at once, so it would not cut a
	// long response — but disable it (and the socket idle `timeout`) explicitly so
	// no future default can silently cap a legitimate long-lived run. Safe for a
	// local single-user endpoint; progress traffic keeps the socket live anyway.
	httpServer.requestTimeout = 0;
	httpServer.timeout = 0;
	httpServer.on('error', (err) => console.error('[cellar-mcp] server error:', err));
	httpServer.listen(port, host, () => {
		const shown = host === '0.0.0.0' ? '127.0.0.1' : host;
		console.log(`[cellar-mcp] MCP agent interface on http://${shown}:${port}/mcp`);
	});
}
