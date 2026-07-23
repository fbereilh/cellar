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
import { IMG_MAX_EDGE, MAX_IMAGE_BLOCKS, MAX_FULL_OUTPUT_IMAGE_BLOCKS } from './image';
import { INSPECT_HEAD_ROWS, INSPECT_ARRAY_HEAD_ROWS, INSPECT_ARRAY_ITEMS, INSPECT_STR_CHARS, INSPECT_HEAD_BUDGET } from '../inspect';
import { McpSessionRegistry, SESSION_IDLE_MS, REAPER_INTERVAL_MS } from './sessions';

const text = (obj: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(obj) }] });
const notFound = (msg: string) => ({ content: [{ type: 'text' as const, text: msg }], isError: true });

type ImagePayload = { output_index: number; mime: string; data: string; [k: string]: unknown };

/**
 * A tool result that SHOWS the cell's figures: the ordinary JSON text block, plus
 * one real MCP image content block per image the service selected.
 *
 * This is the transport half of the image contract. The service (which is
 * transport-independent) decides WHICH images ship and at what size — the mime
 * allowlist, the downscale, the per-result cap — and hands them over on
 * `result.images`; this lifts the base64 out of the JSON into image blocks and
 * leaves only the metadata behind, so a raster is never ALSO stringified into the
 * text content (which would cost the tokens twice and show the agent nothing).
 * Results with no images are byte-identical to plain `text()`.
 */
export function textWithImages(result: Record<string, unknown>) {
	const images = Array.isArray(result.images) ? (result.images as ImagePayload[]) : [];
	if (!images.length) return text(result);
	const meta = images.map(({ data: _data, ...rest }) => rest);
	return {
		content: [
			{ type: 'text' as const, text: JSON.stringify({ ...result, images: meta }) },
			...images.map((i) => ({ type: 'image' as const, data: i.data, mimeType: i.mime }))
		]
	};
}

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
const ROUTE_IMPORTS_DOC = ` IMPORT ROUTING (default ON): any MODULE-LEVEL import in your source is moved into the notebook's single "imports" cell (wherever the user put it, or created on demand), deduplicated, removed from the code you submitted, and that cell is RUN so the kernel has it immediately; the result carries an "imports" report {cell_id, added, run_status}. Imports nested in a def/class/if/try body are never touched. Pass route_imports:false to keep the lines inline when the import is deliberately local (lazy/conditional, or a cell whose subject IS the import).`;
const ROUTE_IMPORTS_PTR = ` Module-level imports are auto-routed to the notebook's imports cell; pass route_imports:false to keep them inline — see add_and_run for the full contract.`;

/**
 * The image contract, carried by every tool that ships figures (add_and_run,
 * run_cell, get_full_output). Stated once so the bound cannot drift from what
 * `image.ts` actually enforces - and every number in it is INTERPOLATED from that
 * module's own constants, so prose and policy cannot disagree: written as literals
 * here, changing a constant would silently leave the agent a wrong description.
 */
const IMAGE_DOC = ` FIGURES COME BACK AS IMAGES YOU CAN SEE: an image output (a matplotlib/plotly figure) is returned as a real image content block, not a text placeholder — so LOOK at the chart you just drew (labels, ticks, whether the data is what you meant) instead of saving it to a file to read it back. Bounded to stay cheap: an oversized raster is downscaled to ~${IMG_MAX_EDGE}px on the longest edge, at most ${MAX_IMAGE_BLOCKS} images ride in an automatic RUN result (an explicit get_full_output(id) ships up to ${MAX_FULL_OUTPUT_IMAGE_BLOCKS}), and a format that is not inlined (image/svg+xml, image/webp) keeps its text placeholder. Nothing is lost to a bound: whatever did not fit is listed in images_omitted with the call that resumes there — get_full_output(id, images_from: N) returns the images from output N on, so a cell with dozens of figures is paged, never truncated. A consecutive run declined by the SAME bound is ONE images_omitted entry carrying a \`count\` (how many) plus the output_index to resume at; a per-figure reason (unsupported_mime, too_large) names its own output. Every output still appears in \`outputs\` with its [image/png, WxH, KB] placeholder, and \`images\` names each one's output_index. Use get_full_output(id, size:"full") when you need pixel detail.`;

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

   THE IMPORTS CELL IS THE ONE EXCEPTION, AND IT IS DELIBERATE. Adding an import to
   the imports cell (which your write tools do automatically, on nearly every cell
   you add) does NOT stale every cell below it - only the cells that read a name
   whose import statement actually changed. "import pandas as pd" always binds the
   same module, so re-running it or re-adding it verbatim changes nothing for a cell
   that uses pd. Do not read the resulting quiet as staleness being broken, and do
   not re-run the notebook "to be safe": a rebound or removed import DOES still
   stale its readers. The exception is withdrawn where re-running an import is no
   longer harmless - a notebook that arms %autoreload anywhere, or an imports cell
   carrying any magic not proven inert (%run, %store, %load, %pylab, %load_ext) -
   and those notebooks simply go back to staling everything downstream of an
   imports edit.

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

   EXPORT TARGET is the notebook's nbdev-style module: the workspace-relative .py
   file the cells marked for export are written to (its #|default_exp).
   get_notebook_map's display block reports export_target (null when unset). When
   you mark cells for export, or the user asks to export the notebook's functions to
   a module, set it with set_export_target(path); path:null clears it. It persists
   in the notebook metadata and regenerates the module immediately - no cell source
   changes.

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

   YOU CAN SEE YOUR OWN FIGURES — LOOK AT THEM. A cell that draws a plot returns
   the rendered image in the run result (add_and_run / run_cell), as a real image,
   downscaled to keep it cheap. So do not savefig to a scratch file to inspect a
   chart, and do not ship a plot you have not looked at: read the axis labels, the
   tick formatting, the legend, and whether the data drawn is the data you meant.
   Fix what you see before moving on. In a BATCH run (run_all/run_cells/run_stale)
   figures are NOT inlined — has_image:true marks the cells that drew one; call
   get_full_output(id) on the ones that matter (size:"full" for pixel detail).

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
   when auth needs no browser (a profile the SDK can authenticate itself — a PAT, a
   databricks-cli / cached-OAuth profile — or an already-signed-in OAuth host); an
   un-signed-in OAuth host, or a no-token external-browser profile, returns
   oauth_login_required, and the browser sign-in stays a HUMAN action (ask the user). You may NOT start, stop, or restart compute
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
	server.registerTool('restart_kernel', { description: 'Restart YOUR working notebook\'s kernel (each notebook has its own): clears only that namespace and opens a new session, so its cells revert to ran_this_session:false, and DROPS its queued runs (they were submitted against the namespace you are clearing). Other notebooks\' kernels are untouched, as are the MCP connection and the document.', inputSchema: { ...notebookParam } }, async ({ notebook }, extra: ToolExtra) => text(await svc.kernel.restart(targetOf(extra, notebook))));
	server.registerTool('interrupt_kernel', { description: 'Interrupt YOUR working notebook\'s running kernel and drop its queued runs (stop means stop). Affects only your notebook\'s kernel; other notebooks are untouched.', inputSchema: { ...notebookParam } }, async ({ notebook }, extra: ToolExtra) => text(await svc.kernel.interrupt(targetOf(extra, notebook))));
	server.registerTool('kernel_status', { description: 'Status of YOUR working notebook\'s kernel and its live session: {started, session_id, execs_this_session}. execs_this_session:0 means no cell has run against this namespace yet, whatever the saved outputs suggest.', inputSchema: { ...notebookParam } }, async ({ notebook }, extra: ToolExtra) => text(svc.kernel.status(targetOf(extra, notebook))));
	server.registerTool('run_queue', { description: 'The run queue as a per-notebook map: {working, notebooks:{"<path>":{running, queue}}}, where `working` is YOUR notebook\'s path. Each notebook has its OWN kernel running one cell at a time, so your run only ever queues behind YOUR notebook\'s cells — notebooks run in parallel. Each entry carries {nb, cellId, actor, position} (position 1 = next up); `running` is that notebook\'s executing cell or null, and a notebook with nothing running or queued is absent. Reads only; never boots a kernel.', inputSchema: {} }, async (_args, extra: ToolExtra) => text(svc.getRunQueue(extra?.sessionId)));
	server.registerTool('list_notebooks', { description: 'List every .ipynb in the workspace (workspace-relative paths). Each entry is flagged `working` (THIS session\'s notebook — where your edits land) and `active` (the one the USER is looking at); the two differ whenever you pinned your own. Set yours with use_notebook.', inputSchema: {} }, async (_args, extra: ToolExtra) => text(svc.listNotebooks(extra?.sessionId)));
	server.registerTool('use_notebook', { description: 'DECLARE this session\'s working notebook (a workspace .ipynb) — OPEN-OR-CREATE: opens the named notebook, or creates it if it does not exist (omit name for an untitled one). From then on your read/write/run tools default to it, independent of which tab the USER focuses and of what any OTHER agent is doing — and it does NOT steal the user\'s focus (the notebook is surfaced as an available tab). Call this FIRST when you start working, especially when several agents share one Cellar. Pass create_if_missing:false for open-only (error if it does not exist). To reach another notebook just once, pass that tool\'s `notebook` param instead.', inputSchema: { name: z.string().optional(), create_if_missing: z.boolean().optional() } }, async ({ name, create_if_missing }, extra: ToolExtra) => { try { return text(svc.useNotebook(extra?.sessionId, name, create_if_missing ?? true)); } catch (e) { return notFound(String((e as Error)?.message ?? e)); } });
	server.registerTool('current_notebook', { description: 'Report THIS session\'s working notebook (where your edits land) and whether it is a genuine pin or the fallback to the user\'s active tab. When unpinned, your target follows the user\'s tab switches — call use_notebook to pin your own.', inputSchema: {} }, async (_args, extra: ToolExtra) => text(svc.currentNotebook(extra?.sessionId)));

	// --- read ---
	server.registerTool('get_notebook_map', { description: 'Compact hierarchical section tree (from markdown headers), NOT full content: per cell id, type, header level/title, one-line summary, run status, staleness, has_output, visibility. Plus a `kernel` header {started, session_id, execs_this_session} and a `display` header {header_numbering, report_view, export_target}. header_numbering = the heading levels Cellar auto-numbers ([] = off); a numbered section also carries the `number` it renders with — that number is NOT in the cell source, so never write one there yourself (see set_header_numbering). report_view:true = every code cell is displayed output-only; a code cell carries code_hidden:true when its input is EFFECTIVELY hidden, and hide_input only when it EXPLICITLY overrides report_view — so hide_input:false with no code_hidden is a cell the user deliberately keeps shown; leave it (set_hide_input). export_target = the nbdev `#|default_exp` .py path, null when unset (set_export_target). run_status separates LIVE from SAVED: ok_session/error_session ran in the CURRENT kernel session (ran_this_session:true); ok_persisted/error_persisted are LEFTOVERS loaded from the .ipynb (ran_this_session:false — nothing they define exists in the kernel); error_kernel_unavailable = the run never reached a kernel, so that failure is live, not leftover. stale_state = not_run|fresh|stale|n/a; stale:true (+ stale_reason, stale_upstream) = it ran this session but an upstream has changed since, so its output is OUT OF DATE — re-run before trusting it. stale_state is a FLOOR: static dataflow plus run timestamps, never a kernel check, so a dependency through a conditional bind or exec/globals() leaves a cell reported fresh while it is already out of date (see cell_impact). has_output means saved output, never that the cell ran — kernel_state is the live truth.', inputSchema: { ...notebookParam } }, async ({ notebook }, extra: ToolExtra) => text(await svc.getNotebookMap(targetOf(extra, notebook))));
	server.registerTool('kernel_state', { description: 'THE LIVE TRUTH about what is defined right now in YOUR working notebook\'s kernel (each notebook has its own, isolated): imports already loaded, user-defined functions/classes, variables (types, shapes, dataframe columns), a `databricks` block (whether a Connect session is bound, and to which profile/cluster), and `stale_cells` ([{id, reason, upstream}]) whose output is now OUT OF DATE because an upstream changed since they ran. Returns {started:false} if no kernel is running (never boots one); stale:true means the kernel restarted while reading, so the namespace below belongs to session_id and is already gone. Call it BEFORE writing code (do not re-import or redefine what already exists) and BEFORE depending on a variable an earlier cell defines — a cell can show saved outputs yet never have run in this session. If a name is missing here, re-run the cell that defines it; re-run everything in stale_cells before relying on it. If databricks.connected, `spark` and `w` are live: use them, never re-create them.', inputSchema: { ...notebookParam } }, async ({ notebook }, extra: ToolExtra) => text(await svc.getKernelState(targetOf(extra, notebook))));
	server.registerTool('list_variables', { description: 'YOUR working notebook\'s kernel namespace as structured data: every user DATA variable (modules/functions/classes/dunders filtered out) with {name, type, repr_short, size}, plus the SCHEMA for pandas/spark DataFrames {shape, columns:[{name, dtype}]}, pandas Series {dtype, shape} and numpy arrays {dtype, shape}. Read-only — runs NO user code and does not inflate execs_this_session. Use it to SEE the data instead of guessing, or adding a throwaway df.head() cell. Reflects only the LIVE session: {started:false} if your kernel is not running (never boots one); stale:true means it restarted while reading, so nothing listed exists any more.', inputSchema: { ...notebookParam } }, async ({ notebook }, extra: ToolExtra) => text(await svc.getVariables(targetOf(extra, notebook))));
	server.registerTool('inspect_variable', { description: `Detailed view of ONE live variable by name in YOUR working notebook's kernel: full type, shape/len, and kind-specific detail — a DataFrame's columns+dtypes plus a head sample, a Series' dtype+head, a numpy array's dtype/shape/stats+head, a dict's keys, a sequence's first items. A Spark DataFrame returns its schema only (never collected, so no job is triggered). Read-only — runs NO user code, exec count unaffected. Prefer it over adding a df.head() cell just to look. BOUNDED, and it says so: normally ${INSPECT_HEAD_ROWS} rows, but when the values are ARRAYS (an embedding column, a list-of-lists frame) the sample drops to ${INSPECT_ARRAY_HEAD_ROWS} rows, each array to its first ${INSPECT_ARRAY_ITEMS} items ("… N more (M total)"), each string to ${INSPECT_STR_CHARS} chars, and the head as a whole to ${INSPECT_HEAD_BUDGET} chars; head_truncated + head_note then name the bounds that applied. Every column stays present ("…" marks a dropped value), so read full values in a cell when you need them. {found:false} when the name is undefined, {started:false} when your kernel is not running. LIVE session only.`, inputSchema: { name: z.string(), ...notebookParam } }, async ({ name, notebook }, extra: ToolExtra) => text(await svc.inspectVariable(name, targetOf(extra, notebook))));
	server.registerTool('read_cells', { description: 'Read ONE OR SEVERAL cells by id/handle (a single-element ids array reads one cell; many reads many). Returns each cell\'s source + summarized outputs, carrying the same per-cell ran_this_session/run_status/stale semantics as get_notebook_map (ok_session = ran live this session; ok_persisted = saved leftover; error_kernel_unavailable = a LIVE kernel-down failure; stale ⇒ re-run before trusting the output).', inputSchema: { ids: z.array(z.string()), ...notebookParam } }, async ({ ids, notebook }, extra: ToolExtra) => { const target = targetOf(extra, notebook); const res = resolveMany(target, ids); if ('error' in res) return res.error; return text(await svc.readCells(res.ids, target)); });
	server.registerTool('read_by_location', { description: 'Read a cell by location: index (0-based over visible cells), position first/last, or next/prev of a cell.', inputSchema: { index: z.number().int().optional(), position: z.enum(['first', 'last']).optional(), relative_to: z.string().optional(), direction: z.enum(['next', 'prev']).optional(), ...notebookParam } }, async ({ index, position, relative_to, direction, notebook }, extra: ToolExtra) => { const target = targetOf(extra, notebook); let relTo = relative_to; if (relative_to != null) { const res = resolveOne(target, relative_to); if ('error' in res) return res.error; relTo = res.id; } const r = await svc.readByLocation({ index, position, relativeTo: relTo, direction }, target); return r ? text(r) : notFound('no cell at that location'); });
	server.registerTool('read_section', { description: 'Read all cells under a markdown header (until the next same-or-higher header). The header carries its display-only auto-`number` when its level is numbered; that number is rendered, not stored, so it is absent from the cell source the read returns.', inputSchema: { header_id: z.string(), ...notebookParam } }, async ({ header_id, notebook }, extra: ToolExtra) => { const target = targetOf(extra, notebook); const res = resolveOne(target, header_id); if ('error' in res) return res.error; const r = await svc.readSection(res.id, target); return r ? text(r) : notFound(`${header_id} is not a visible header cell`); });
	server.registerTool('search_cells', { description: 'Free-text search over cell SOURCE and saved OUTPUT text; returns ids + snippets. Substring match, NOT scope-aware — a hit in a comment, a string literal or an output counts. For "where is <name> defined / which cells use it", prefer find_symbol (dataflow-precise). Snippets carry the same ran_this_session/run_status semantics as read_cells (false ⇒ the output is a leftover from a previous session).', inputSchema: { query: z.string(), in: z.enum(['input', 'output', 'both']).optional(), ...notebookParam } }, async ({ query, in: where, notebook }, extra: ToolExtra) => text(svc.searchCells(query, where ?? 'both', targetOf(extra, notebook))));
	server.registerTool('find_symbol', { description: 'Locate a Python name across the notebook by DATAFLOW, not text: the cells that DEFINE it (assignment/import/def/class, document order) and the cells that USE it, each resolved to the definition it binds to. Scope-aware, so a match in a comment or string is never reported and a definition is never confused with a use (unlike search_cells). Returns {symbol, defined_in:[ids], used_in:[{cell, binds_to}], live_definer?, live_in_kernel?, hidden_definer?}. binds_to = the nearest PRECEDING definer (null = a forward reference, or the binding definer is hidden). live_definer = the last visible definer whose value is live in the current kernel session. live_in_kernel: true = defined in the namespace now, false = only in source (unrun or redefined since), ABSENT = no live kernel to check. Use it for "where is df defined?" and "what would I touch renaming it?" without reading the whole notebook. Static analysis, so it under-reports: a conditional bind hides that cell\'s later read, and names made by exec/globals()/star-import are invisible — kernel_state is the live-truth fallback. get_notebook_map\'s stale_state and cell_impact come from this SAME static graph plus run timestamps, so treat none of the three as a runtime check of the kernel.', inputSchema: { name: z.string(), ...notebookParam } }, async ({ name, notebook }, extra: ToolExtra) => text(await svc.findSymbol(name, targetOf(extra, notebook))));
	server.registerTool('cell_impact', { description: 'The dependency blast radius of ONE cell, by dataflow: depends_on = the cells whose definitions it READS; dependents = the cells that go STALE if you EDIT it (transitive downstream, document order). Returns {cell, depends_on:[ids], dependents:[ids]}. Call it before editing a cell others build on, to see what run_stale will re-run. It can OVER-report: this is the blast radius of the WHOLE cell before any edit exists, so it assumes every name the cell defines may move — for the imports cell, dependents lists everything reading any of its imports, while only the readers of an import your edit actually changed go stale. Static source analysis, so it also UNDER-reports: a dependency carried only through a conditional bind (if flag: df = load()) or exec/globals() is invisible, and NOTHING catches this at run time — stale_state comes from the SAME static graph plus run timestamps and never inspects the kernel namespace, so it under-reports identically. After editing a definition, re-run the downstream cells yourself even when none is listed. A markdown cell yields empty lists.', inputSchema: { id: z.string(), ...notebookParam } }, async ({ id, notebook }, extra: ToolExtra) => { const target = targetOf(extra, notebook); const res = resolveOne(target, id); if ('error' in res) return res.error; return text(await svc.cellImpact(res.id, target)); });
	server.registerTool('get_errors', { description: 'List cells whose latest output is an error (ename/evalue/traceback), with the same run_status/ran_this_session semantics as read_cells: ran_this_session:false errors are leftovers from a previous session — EXCEPT kernel_unavailable:true, a LIVE kernel-down failure to fix, not ignore as stale.', inputSchema: { ...notebookParam } }, async ({ notebook }, extra: ToolExtra) => text(svc.getErrors(targetOf(extra, notebook))));
	server.registerTool('get_full_output', { description: 'Fuller cell outputs. Medium-capped by default; size=full returns everything - including a figure at its ORIGINAL resolution (the default path downscales it, see below).' + IMAGE_DOC + ' Output fields carry the same ran_this_session/run_status semantics as read_cells/get_notebook_map (ran_this_session:false ⇒ leftover from a previous session; kernel_state is the live truth).', inputSchema: { id: z.string(), size: z.enum(['medium', 'full']).optional(), images_from: z.number().int().min(0).optional(), ...notebookParam } }, async ({ id, size, images_from, notebook }, extra: ToolExtra) => {
		const target = targetOf(extra, notebook);
		const res = resolveOne(target, id);
		if ('error' in res) return res.error;
		const r = svc.getFullOutput(res.id, size ?? 'medium', target, images_from);
		if (!r) return notFound(`cell ${id} not found or hidden`);
		return textWithImages(r);
	});

	// --- write ---
	server.registerTool('add_cell', { description: `Add a code|sql|markdown cell (optionally after a cell) with optional source. A sql cell holds a SQL query that runs against the connected Databricks spark session (doctrine clause 10). Adds ONLY — it does not run or render, so a markdown cell added this way stays raw source; prefer add_and_run for markdown/sql.${ROUTE_IMPORTS_PTR}`, inputSchema: { after_id: z.string().optional(), cell_type: z.enum(['code', 'sql', 'markdown']).optional(), source: z.string().optional(), route_imports: z.boolean().optional(), ...notebookParam } }, async ({ after_id, cell_type, source, route_imports, notebook }, extra: ToolExtra) => {
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
	server.registerTool('consolidate_imports', { description: 'Sweep every MODULE-LEVEL import in your working notebook into its single "imports" cell (deduplicated, __future__ first, canonically ordered), strip those lines from the cells they came from, and run the imports cell so the kernel has them. Imports nested in a def/class/if/try body are left alone — a nested import is a choice (lazy loading, TYPE_CHECKING), not an accident. Idempotent: a second run changes nothing and re-runs nothing.', inputSchema: { ...notebookParam } }, async ({ notebook }, extra: ToolExtra) => text(await svc.consolidate(targetOf(extra, notebook))));
	server.registerTool('create_checkpoint', { description: 'Snapshot your working notebook (cells + source + outputs + metadata) to a checkpoint the human can revert to. Cellar already checkpoints automatically before your mutations and runs, so call this only to mark a deliberate restore point before a risky change. Returns {id, at, trigger, label, cellCount}.', inputSchema: { label: z.string().optional(), ...notebookParam } }, async ({ label, notebook }, extra: ToolExtra) => text(svc.checkpoint(label, targetOf(extra, notebook))));
	server.registerTool('export_html', { description: 'Export your working notebook to ONE self-contained HTML file on disk (rendered markdown, highlighted code, every persisted output inlined — no server or network needed to open it). Renders the LAST-RUN saved outputs; never touches the kernel. hide_code:true produces a clean REPORT (markdown + outputs, no code) — note a report DROPS code cells that have no output (imports, `df = load()`); hide_code:false forces code shown; OMIT it to follow the notebook\'s own setting. Writes alongside the notebook as <name>.html, or to a workspace-relative `path` (`.html` added if missing); both confined to the workspace. Returns the file LOCATION + {path, bytes, hide_code}, NOT the HTML body — read the file if you need its contents.', inputSchema: { hide_code: z.boolean().optional(), path: z.string().optional(), ...notebookParam } }, async ({ hide_code, path, notebook }, extra: ToolExtra) => text(svc.exportHtml({ hideCode: hide_code, path, nb: targetOf(extra, notebook) })));
	server.registerTool('delete_cells', { description: 'Delete ONE OR SEVERAL cells by handle in one call (a single-element ids array deletes one cell). Nothing is deleted unless every id resolves, and the whole batch is one undoable checkpoint. Returns {ok, deleted:[ids], count}.', inputSchema: { ids: z.array(z.string()), ...notebookParam } }, async ({ ids, notebook }, extra: ToolExtra) => {
		const target = targetOf(extra, notebook);
		const res = resolveMany(target, ids);
		if ('error' in res) return res.error;
		const r = svc.removeCells(res.ids, target);
		return r.ok ? text(r) : notFound(r.missing ? `cell ${r.missing} not found` : 'ids must not be empty');
	});
	server.registerTool('move_cell', { description: 'Move a cell. Give exactly ONE destination: after_id / before_id (another cell\'s handle — no map fetch needed) or position (the 0-based index the cell ends up at). Returns {ok, id, index}.', inputSchema: { id: z.string(), after_id: z.string().optional(), before_id: z.string().optional(), position: z.number().int().optional(), ...notebookParam } }, async ({ id, after_id, before_id, position, notebook }, extra: ToolExtra) => {
		const target = targetOf(extra, notebook);
		const res = resolveOne(target, id);
		if ('error' in res) return res.error;
		// "Give exactly ONE destination" is enforced, not merely documented: an
		// anchor plus a position is a move the caller under-specified, and silently
		// letting the anchor win (destIndex ignores position when an anchor is
		// present) hides that from them. Reject the combination up front, exactly
		// like after_id + before_id below.
		if (position != null && (after_id != null || before_id != null))
			return notFound('give exactly one destination: after_id, before_id, OR position — not position together with an anchor');
		// Resolve the anchor at the same boundary as every other cell ref, so an
		// ambiguous prefix errors here rather than silently missing below.
		const dest: svc.MoveDest = { position };
		for (const [key, ref] of [['afterId', after_id], ['beforeId', before_id]] as const) {
			if (ref == null) continue;
			const a = resolveOne(target, ref);
			if ('error' in a) return a.error;
			dest[key] = a.id;
		}
		if (dest.afterId != null && dest.beforeId != null) return notFound('give only one of after_id / before_id');
		const r = svc.moveCell(res.id, dest, target);
		if (r.ok) return text(r);
		return notFound(
			r.error === 'no_destination' ? 'move_cell needs a destination: after_id, before_id, or position'
				: r.error === 'same_cell' ? 'after_id/before_id must name a different cell'
					: r.error === 'unknown_anchor' ? 'the destination cell was not found'
						: `cell ${id} not found`
		);
	});
	server.registerTool('set_cell_type', { description: 'Set a cell type to code, sql, or markdown. sql tags the code cell as a SQL query (runs against the connected Databricks spark session); code reverts it to Python.', inputSchema: { id: z.string(), cell_type: z.enum(['code', 'sql', 'markdown']), ...notebookParam } }, async ({ id, cell_type, notebook }, extra: ToolExtra) => { const target = targetOf(extra, notebook); const res = resolveOne(target, id); if ('error' in res) return res.error; return svc.setType(res.id, cell_type, target) ? text({ ok: true }) : notFound(`cell ${id} not found`); });
	server.registerTool('set_cell_visibility', { description: 'Show/hide a cell from the agent (cellar.hidden_from_agent).', inputSchema: { id: z.string(), hidden: z.boolean(), ...notebookParam } }, async ({ id, hidden, notebook }, extra: ToolExtra) => { const target = targetOf(extra, notebook); const res = resolveOne(target, id); if ('error' in res) return res.error; return svc.setCellVisibility(res.id, hidden, target) ? text({ ok: true, id: svc.handleFor(target, res.id), hidden }) : notFound(`cell ${id} not found`); });

	server.registerTool('set_header_numbering', { description: 'Set WHICH markdown heading levels render with an automatic number (levels:[2] numbers every H2 "1.", "2."; levels:[1,2] numbers hierarchically "1.", "1.1"; levels:[] turns it off). Notebook-level and DISPLAY-ONLY: numbers are computed at render time and no cell source is ever edited, so never type one into a header yourself. Returns the sanitized levels stored (deduped, 1-6, ascending) and how many headings now carry a number.', inputSchema: { levels: z.array(z.number().int().min(1).max(6)), ...notebookParam } }, async ({ levels, notebook }, extra: ToolExtra) => text(svc.setHeaderNumbering(levels, targetOf(extra, notebook))));
	server.registerTool('set_report_view', { description: 'Turn the notebook-wide report view on/off: enabled:true renders every code cell OUTPUT-only, so a human reads results and markdown without the code; enabled:false shows code again. Display-only — no source is touched and cells still run. A per-cell set_hide_input override beats it in either direction. Returns the resulting report_view.', inputSchema: { enabled: z.boolean(), ...notebookParam } }, async ({ enabled, notebook }, extra: ToolExtra) => text(svc.setReportView(enabled, targetOf(extra, notebook))));
	server.registerTool('set_hide_input', { description: 'Show or hide ONE code cell\'s input, overriding report view for that cell: hidden:true forces its code hidden, hidden:false forces it shown even under report view, hidden:null clears the choice so it follows the notebook-wide report_view again. The per-cell value ALWAYS wins over set_report_view, so this is how you keep one cell visible in a report, or hide a single cell without one. Display-only — no source is touched and the cell still runs; code cells only. Returns {hide_input (explicit value or null), code_hidden (effective), report_view (notebook default)}.', inputSchema: { id: z.string(), hidden: z.boolean().nullable(), ...notebookParam } }, async ({ id, hidden, notebook }, extra: ToolExtra) => { const target = targetOf(extra, notebook); const res = resolveOne(target, id); if ('error' in res) return res.error; const r = svc.setHideInput(res.id, hidden, target); return r.ok ? text({ id: svc.handleFor(target, res.id), ...r }) : notFound(`cell ${id} is not a code cell (only a code cell can hide its input)`); });
	server.registerTool('set_export_target', { description: 'Set (or clear) your working notebook\'s EXPORT TARGET — the nbdev-style `#|default_exp` module: the workspace-relative `.py` file the cells marked for export (metadata.cellar.export) are written to. path:"lib/foo.py" sets it; path:null or "" clears it. Persisted in the notebook metadata and regenerates the `.py` immediately; no cell source is touched. Returns {export_target}, the same value get_notebook_map\'s `display` block reports.', inputSchema: { path: z.string().nullable(), ...notebookParam } }, async ({ path, notebook }, extra: ToolExtra) => text(svc.setExportTarget(path, targetOf(extra, notebook))));

	// --- execute ---
	server.registerTool('add_and_run', { description: `PREFERRED write-and-execute: create a cell AND run it in one call (fewer round-trips than add_cell then run_cell). Adds a code|sql|markdown cell (default code) with the given source, after a cell (after_id) or at the end, runs it, and returns run_cell's result (status + outputs) plus the new cell id. Code that raises returns the error as the result — the cell still exists. A markdown cell is created AND rendered (status "rendered"), which is how to add markdown so it shows rendered rather than raw source. Reserve add_cell for a cell you want left un-run.${ROUTE_IMPORTS_DOC} Routing happens BEFORE this cell runs, so an import it needs is already in the kernel. Source that is ONLY imports creates no cell at all and returns routed_to_imports:true.${IMAGE_DOC}`, inputSchema: { source: z.string(), cell_type: z.enum(['code', 'sql', 'markdown']).optional(), after_id: z.string().optional(), route_imports: z.boolean().optional(), ...notebookParam } }, async ({ source, cell_type, after_id, route_imports, notebook }, extra: ToolExtra) => { const target = targetOf(extra, notebook); let after = after_id; if (after_id != null) { const res = resolveOne(target, after_id); if ('error' in res) return res.error; after = res.id; } return textWithImages(await withProgress(extra, () => svc.addAndRun({ source, cellType: cell_type, afterId: after, routeImports: route_imports ?? true, nb: target }))); });
	server.registerTool('run_cell', { description: 'Run one cell by handle. Running a MARKDOWN cell renders it (no code executes) and returns status "rendered" — use this (or add_and_run) so markdown shows rendered rather than raw source. Your notebook\'s kernel runs one cell at a time: if it is busy your run is QUEUED (never dropped) and this call waits its turn, then returns the real outputs annotated queued:true + queue_position + waited_ms; another notebook\'s run never queues yours (parallel kernels). A cell already queued or running is not enqueued twice — the call returns immediately with status "queued"/"running" and its queue_position, and a pending run has its source refreshed. status "cancelled" = an interrupt/restart dropped the queued run before it started; nothing executed. See run_queue.' + IMAGE_DOC, inputSchema: { id: z.string(), ...notebookParam } }, async ({ id, notebook }, extra: ToolExtra) => { const target = targetOf(extra, notebook); const res = resolveOne(target, id); if ('error' in res) return res.error; const r = await withProgress(extra, () => svc.runCell(res.id, target)); return r ? textWithImages(r) : notFound(`cell ${id} not found`); });
	server.registerTool('run_cells', { description: 'Run several cells in order, each waiting its turn in your notebook\'s kernel queue. Returns a COMPACT batch summary {ran, errored, results}, one record per cell. An OK cell is a status line only — {id, run_status, has_output, has_image, + stale fields if still stale} — its output is one get_full_output(id) away. A batch never inlines figures (a huge token bill across N cells): has_image:true flags a cell that DREW one. An ERRORED cell carries its {ename, evalue, traceback} in full (capped, library frames elided; whole stack via get_full_output(id, size:"full")), so a batch failure is actionable without a second call. Stops at the first cell whose queued run an interrupt/restart cancelled (status "cancelled") — the rest would run against a namespace their predecessors never populated.', inputSchema: { ids: z.array(z.string()), ...notebookParam } }, async ({ ids, notebook }, extra: ToolExtra) => { const target = targetOf(extra, notebook); const res = resolveMany(target, ids); if ('error' in res) return res.error; return text(await withProgress(extra, () => svc.runCells(res.ids, target))); });
	server.registerTool('run_all', { description: 'Run all code cells in document order. Returns the same compact {ran, errored, results} batch summary as run_cells (OK cells as status lines with output one get_full_output away; errored cells with full traceback), and the same queueing + cancellation semantics.', inputSchema: { ...notebookParam } }, async ({ notebook }, extra: ToolExtra) => text(await withProgress(extra, () => svc.runAll(targetOf(extra, notebook)))));
	server.registerTool('run_stale', { description: 'Re-run every STALE code cell (ran this session, but its inputs changed since) in dependency order, bringing the notebook back in sync with its code. Use it after editing an upstream cell instead of hunting downstream cells by hand (kernel_state\'s stale_cells / get_notebook_map\'s stale_state say what is stale). Returns the same compact {ran, errored, results} summary as run_cells, with the same queueing and cancellation semantics.', inputSchema: { ...notebookParam } }, async ({ notebook }, extra: ToolExtra) => text(await withProgress(extra, () => svc.runStale(targetOf(extra, notebook)))));
	server.registerTool('run_range', { description: 'Run code cells in the inclusive range from one cell to another. Returns the same compact {ran, errored, results} batch summary as run_cells (OK cells as status lines with output one get_full_output away; errored cells with full traceback), and the same queueing + cancellation semantics.', inputSchema: { from_id: z.string(), to_id: z.string(), ...notebookParam } }, async ({ from_id, to_id, notebook }, extra: ToolExtra) => { const target = targetOf(extra, notebook); const rf = resolveOne(target, from_id); if ('error' in rf) return rf.error; const rt = resolveOne(target, to_id); if ('error' in rt) return rt.error; return text(await withProgress(extra, () => svc.runRange(rf.id, rt.id, target))); });

	// --- databricks (reconnect + gated connect; compute lifecycle stays human-only) ---
	server.registerTool('databricks_status', { description: 'Whether a Databricks Connect session is LIVE in YOUR working notebook\'s kernel, and against which profile/cluster/host (each notebook has its own kernel and its own session). connected:true means `spark` (a Spark session on that cluster) and `w` (a databricks.sdk WorkspaceClient) are bound AND verified reachable — use them directly, never write connection boilerplate. Liveness uses a cheap cached `SELECT 1` (skipped while the kernel is busy) plus the client\'s synchronous is_closed flag, so a session that expired server-side or was closed locally is caught even though `spark` is still bound. On expiry Cellar AUTO-RECONNECTS: connected:true with reconnected:true (re-run whatever failed with SESSION_CLOSED). If that fails you get connected:false with expired:true — call databricks_reconnect (it also repairs a dropped kernel socket the probe cannot get through) or ask the user. reauth_required:true overrides that: the named ~/.databrickscfg profile\'s saved sign-in EXPIRED, so no reconnect can succeed — relay the exact reauth_command (`databricks auth login --profile <name>`) for the user to run in a terminal, and do NOT use the sidebar sign-in (it cannot refresh a CLI-managed profile). liveness_unverified:true means liveness could not be confirmed (kernel busy, transient error), NOT that it is dead. connected:false without expired = no session at all: ask the user, or databricks_connect a chosen cluster. Never boots a kernel. The same block appears in kernel_state and get_notebook_map.', inputSchema: { ...notebookParam } }, async ({ notebook }, extra: ToolExtra) => text(await svc.databricks.status(targetOf(extra, notebook))));
	server.registerTool('databricks_reconnect', { description: 'RESTORE a dead Databricks Connect session in YOUR working notebook against the cluster it was LAST connected to (the one the USER chose — it NEVER picks a new one). Use it when a `spark.*` cell fails and databricks_status cannot heal it: a dropped kernel socket (the status probe cannot get through), a server-side expiry (SESSION_CLOSED / NO_ACTIVE_SESSION), or a kernel restart. Walks the recovery ladder cheapest-first: refresh the socket in place (namespace intact), else rebuild the session, else re-establish after a kernel restart. connected:true with reconnected:true = `spark`/`w` are live again, so re-run whatever failed. IT CAN RESTART YOUR KERNEL: kernel_restarted + namespace_cleared true means every variable is GONE (re-run your cells); both false means your namespace was preserved. Errors: not_connected (nothing to restore — ask the user, or databricks_connect a chosen cluster), profile_reauth_required (the named ~/.databrickscfg profile\'s saved sign-in expired — relay the exact `databricks auth login --profile <name>` command from the error message; the sidebar sign-in cannot refresh a CLI-managed profile), cluster_terminated (agents cannot start compute — ask the user), kernel_unavailable (run a cell to boot one). May take a while while re-pinning. Prefer this over restart_kernel, which just destroys the session.', inputSchema: { ...notebookParam } }, async ({ notebook }, extra: ToolExtra) => databricksTool(() => withProgress(extra, () => svc.databricks.reconnect(targetOf(extra, notebook)))));
	server.registerTool('databricks_list_clusters', { description: 'List the workspace\'s attachable clusters so you can pick one for databricks_connect (or report their state): [{cluster_id, name, state, spark_version, node_type}], RUNNING first. Auth comes from an explicit `profile` (a ~/.databrickscfg name) or `host`, else your working notebook\'s existing connection. READ-ONLY: it never starts, stops or restarts a cluster — compute lifecycle is human-only, so a TERMINATED cluster you need is the user\'s to start. Runs server-side, not in the kernel. Errors: oauth_login_required (needs a human browser sign-in), profile_reauth_required (that named profile\'s saved sign-in expired — relay the exact `databricks auth login --profile <name>` command from the error message; Cellar\'s browser sign-in cannot refresh it), not_connected (give a `profile`, or ask the user to connect).', inputSchema: { profile: z.string().optional(), host: z.string().optional(), ...notebookParam } }, async ({ profile, host, notebook }, extra: ToolExtra) => databricksTool(() => svc.databricks.listClusters({ profile, host }, targetOf(extra, notebook))));
	server.registerTool('databricks_connect', { description: 'CONNECT your working notebook to a CHOSEN cluster (find one with databricks_list_clusters), binding `spark` + `w` through Cellar\'s normal connect path. Pass cluster_id plus a `profile` (a ~/.databrickscfg name) or `host`. GATED: it proceeds only when auth needs NO human browser — a profile the SDK authenticates itself (PAT, databricks-cli, cached OAuth) or an already-signed-in OAuth host; otherwise oauth_login_required, and the browser sign-in stays the user\'s job. A named profile whose saved sign-in EXPIRED returns profile_reauth_required — relay the exact `databricks auth login --profile <name>` command from the error message (the sidebar cannot refresh a CLI-managed profile). It does NOT start compute: a stopped cluster returns cluster_terminated (ask the user). SIDE EFFECT: matching the cluster runtime may reinstall databricks-connect (up to a minute) and, if the client was already imported, RESTART your kernel — kernel_restarted + namespace_cleared then true, so re-run your cells. To merely RESTORE the session the user already had, use databricks_reconnect.', inputSchema: { cluster_id: z.string(), cluster_name: z.string().optional(), profile: z.string().optional(), host: z.string().optional(), ...notebookParam } }, async ({ cluster_id, cluster_name, profile, host, notebook }, extra: ToolExtra) => databricksTool(() => withProgress(extra, () => svc.databricks.connect({ clusterId: cluster_id, clusterName: cluster_name, profile, host, nb: targetOf(extra, notebook) }))));
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
