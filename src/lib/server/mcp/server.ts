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

const text = (obj: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }] });
const notFound = (msg: string) => ({ content: [{ type: 'text' as const, text: msg }], isError: true });

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
		return { content: [{ type: 'text' as const, text: JSON.stringify({ error: e?.code ?? 'error', message: String(e?.message ?? err) }, null, 2) }], isError: true };
	}
}

/**
 * The `route_imports` contract, appended verbatim to every write tool that
 * accepts it. One string so the four descriptions cannot drift apart.
 */
const ROUTE_IMPORTS_DOC = ` IMPORT ROUTING (default ON): any MODULE-LEVEL import in your source is moved into the notebook's single "imports" cell (the user-designated cell wherever it sits, or created on demand), deduplicated against what is already there, removed from the code you submitted, and the imports cell is RUN so the kernel has it immediately. Imports nested inside a def/class/if/try body are never touched. The result carries an "imports" report {cell_id, added, run_status}. Pass route_imports:false to keep the import lines inline in this cell instead — do that when the import is deliberately local (a lazy or conditional import, or a cell demonstrating an import).`;

/**
 * House-style doctrine handed to the agent once at connect (MCP server
 * `instructions`). Sets the frame — build ONE coherent notebook, not a pile of
 * snippets — before the first tool call. Advisory: the host injects it into the
 * model's context. Reference only tools that ship today.
 */
const INSTRUCTIONS = `You are authoring ONE coherent, human-readable Python notebook in Cellar — not a
pile of independent snippets. Notebooks here read top-to-bottom as a single
narrative where each cell builds on the last.

Follow this house style:

1. IMPORTS ARE COLLECTED IN ONE CELL — AND CELLAR PUTS THEM THERE FOR YOU. The
   notebook has a single "imports" cell (the user may designate any code cell, and
   it can live at any position; one is created on demand if none is designated).
   When you write code through add_cell, add_cells, edit_cell or add_and_run, any
   module-level import in it is moved into that cell, deduplicated, and the cell is
   run — so just write the import where
   the code needs it and let it be routed. Your cell keeps only the real work.
   Imports inside a def/class/if/try body are left exactly where you put them.
   Pass route_imports:false when you mean an import to stay inline (a lazy or
   conditional import, or a cell whose subject IS the import). consolidate_imports
   sweeps an existing notebook's scattered imports into that cell in one call.
   Before adding an import, check kernel_state (below) to see whether the module is
   already loaded.

2. CHECK STATE BEFORE YOU WRITE. Call kernel_state to see what is already
   imported and which variables/functions/classes already exist in the live
   kernel. Do not re-import a module that is already loaded, and do not recompute
   or redefine a value that already exists — build on it.

   INSPECT THE DATA, DO NOT GUESS IT. To understand the data state, use
   list_variables (every live variable with its type + schema — a DataFrame's
   shape and columns/dtypes, an array's dtype/shape) and inspect_variable(name)
   (one variable in detail — a DataFrame's columns plus a small head sample, an
   array's stats, a dict's keys). Both are read-only: they run NO code and do not
   change exec counts. Reach for them instead of guessing a column name or adding
   a throwaway df.head()/df.columns cell to the notebook. Like kernel_state, they
   reflect only the LIVE kernel session — a variable absent from list_variables is
   not defined right now, whatever a cell's saved output shows.

3. KERNEL_STATE IS THE LIVE TRUTH; SAVED OUTPUTS ARE NOT. A cell's outputs are
   saved in the .ipynb file and outlive both the kernel and previous sessions, so
   "this cell has output" NEVER means "this cell has run in the kernel you are
   talking to". Only kernel_state says what is actually defined right now.

   get_notebook_map and read_cell make the difference explicit:
     - run_status "ok_session" / "error_session", ran_this_session: true
       — the cell really executed in the current kernel session.
     - run_status "ok_persisted" / "error_persisted", ran_this_session: false
       — those outputs are LEFTOVER from a previous session. Nothing that cell
       defines exists in the kernel.
     - run_status "error_kernel_unavailable" - the kernel could not be reached;
       this failure is LIVE, not leftover. Nothing executed (ran_this_session is
       still false), so do not ignore it as stale: fix the kernel, then re-run.
   The map's kernel header ({started, session_id, execs_this_session}) tells you
   whether any of it ran this session at all.

   So: before you depend on a variable an earlier cell defines, confirm it in
   kernel_state. If it is missing, RE-RUN the upstream cells that define it
   (run_cell / run_range / run_all) before running anything downstream — otherwise
   you get a NameError on a cell whose saved output looked perfectly fine.
   Restarting the kernel resets every cell to "not run this session".

   STALENESS — WATCH IT, YOU CREATE IT. Because you run cells out of order and edit
   upstream cells, a cell's output routinely goes OUT OF DATE: it ran this session,
   but a cell it DEPENDS ON (one that defines a name it uses) has since been edited
   or re-run. Cellar tracks this from the dependency graph. get_notebook_map marks
   each cell stale_state (not_run/fresh/stale), kernel_state lists stale_cells
   ([{id, reason, upstream}]), and read_cell/run_cell carry stale + stale_reason.
   A stale cell's output is NOT trustworthy — it was computed from an older version
   of its inputs. Before you rely on a stale cell's result (or build downstream of
   it), re-run it and its upstreams; run_stale re-runs everything stale in the right
   order in one call. When you edit a cell, expect the cells below it that use its
   names to go stale — re-run them so the notebook you leave behind is coherent.

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

6. PICK THE RIGHT NOTEBOOK. Your read/write/run tools target the active notebook.
   Call list_notebooks to discover the workspace's notebooks; open_notebook(name)
   to open and focus an EXISTING one (this makes it active and surfaces it in the
   UI); create_notebook(name) only for a genuinely NEW notebook. Do not reach for
   create_notebook to open something that already exists.

7. WRITE AND RUN TOGETHER. When you add a code cell you intend to execute, use
   add_and_run — it creates the cell and runs it in one call, returning the new
   cell id and the run result (outputs/errors) together, with fewer round-trips
   than add_cell followed by run_cell. Use add_and_run for markdown cells too, so
   they render instead of sitting as raw source. Reserve add_cell for code you are
   adding but will run later (a cell you want left un-run).

8. ONE KERNEL, ONE RUN AT A TIME. Every open notebook shares a single kernel, and
   a human may be running a cell in it right now. Your run is never dropped: it
   joins a FIFO queue, so run_cell simply takes longer to return when the kernel
   is busy (its result then carries queued:true and the position it waited at).
   run_queue shows what is running and what is waiting. Do not interrupt or
   restart the kernel just because a run is slow to come back — that also drops
   every queued run, the user's included.

9. DATABRICKS: USE THE SESSION, DO NOT BUILD ONE. kernel_state and
   get_notebook_map both carry a "databricks" block. When it says connected:true,
   a live Databricks Connect session is ALREADY bound in the kernel namespace:
     - spark - a Spark session against the named cluster
     - w     - a databricks.sdk WorkspaceClient against the named profile
   Use those names directly. Never write connection boilerplate (no
   DatabricksSession.builder, no WorkspaceClient(...), no fiddling with
   DATABRICKS_* environment variables) - Cellar already did it, and a second
   session would fight the first.

   Explore data with the databricks_* tools (databricks_list_catalogs,
   databricks_list_schemas, databricks_list_tables, databricks_preview_table).
   They read Unity Catalog directly and return structured JSON, so prefer them
   over adding a cell just to look at a table. Add a cell when the query is part
   of the notebook's story; use the tools when you are only orienting yourself.

   When databricks says connected:false WITHOUT expired:true, spark does not exist
   and every databricks_* tool fails with error "not_connected". A first-time
   connect is a HUMAN action: ask the user to connect from the Databricks section
   of the Cellar sidebar. Do not try to connect yourself, and do not restart the
   kernel while a session is connected - that destroys it.

   EXPIRED SESSIONS SELF-HEAL. A Spark Connect session can die server-side (idle
   timeout or cluster GC) while spark is still bound - a spark.* cell then fails
   with [INVALID_HANDLE.SESSION_CLOSED] / "Spark Connect Session expired". This is
   RECOVERABLE, not a dead end: Cellar detects the expiry via a liveness probe and
   automatically reconnects against the same profile+cluster. So when a cell fails
   that way, call databricks_status (or kernel_state) - that both reports the
   truth and triggers the auto-reconnect. A response with reconnected:true (or
   connected:true after a retry) means spark is live again: simply re-run the cell
   that failed. Only if it comes back connected:false, expired:true did the
   automatic heal fail - then ask the user to reconnect from the sidebar and re-run.
   Never treat connected:true as proof a stale cell's SESSION_CLOSED is permanent;
   re-check status and re-run.

10. SQL CELLS RUN AGAINST spark. A cell can be type "sql" (add_cell / add_cells /
   add_and_run with cell_type:"sql", or set_cell_type to "sql"). Its source is raw
   SQL - do NOT wrap it in spark.sql() or Python quotes; Cellar compiles it to
   spark.sql(<your query>) at run time and renders the result as an interactive
   table. Use a SQL cell when the notebook's story is a query and you want the
   result shown as a grid; the result's Spark DataFrame is also bound to _sql_df in
   the kernel, so a following Python cell can chain off it. SQL cells need the same
   live spark session as clause 9: with databricks connected:false they fail with a
   clear "connect Databricks" message. Only the first ~500 rows are fetched for
   display. Prefer a normal python cell (or the databricks_* tools) when you need
   Python around the query; prefer a sql cell when the query itself is the point.

The goal: a notebook a human would be happy to have written — imports up top,
shared state, a clean section outline, and a continuous line of reasoning from
first cell to last.`;

function registerTools(server: McpServer) {
	// --- lifecycle ---
	server.registerTool('restart_kernel', { description: 'Restart the kernel (clears the namespace and opens a new kernel session, so every cell reverts to ran_this_session:false). Also DROPS every queued run: queued work was submitted against the namespace you are clearing. Does NOT affect the MCP connection or document.', inputSchema: {} }, async () => text(await svc.kernel.restart()));
	server.registerTool('interrupt_kernel', { description: 'Interrupt the running kernel, and drop every queued run (stop means stop).', inputSchema: {} }, async () => text(await svc.kernel.interrupt()));
	server.registerTool('kernel_status', { description: 'Current kernel status, plus the live kernel session: {started, session_id, execs_this_session}. execs_this_session:0 means no cell has run against this namespace yet, whatever the notebook\'s saved outputs suggest.', inputSchema: {} }, async () => text(svc.kernel.status()));
	server.registerTool('run_queue', { description: 'The kernel run queue: {running, queue}. There is ONE kernel behind every open notebook, so one cell runs at a time app-wide and everything else waits in a FIFO - a run you request while a user\'s (or another notebook\'s) cell is executing is QUEUED, never dropped. Each entry carries {nb, cellId, actor, position} (position 1 = next up). Reads only; it never boots a kernel.', inputSchema: {} }, async () => text(svc.getRunQueue()));
	server.registerTool('list_notebooks', { description: 'List every .ipynb in the workspace (workspace-relative paths) so you can discover notebook names to open, and which one is currently active. Use open_notebook to focus one of these.', inputSchema: {} }, async () => text(svc.listNotebooks()));
	server.registerTool('open_notebook', { description: 'Open and focus an existing workspace notebook by name; surfaces it live in the UI. Use create_notebook to make a new one.', inputSchema: { name: z.string() } }, async ({ name }) => { try { return text(svc.openNotebook(name)); } catch (e) { return notFound(String((e as Error)?.message ?? e)); } });
	server.registerTool('create_notebook', { description: 'Create a NEW workspace notebook by name (a .ipynb file), make it active, and surface it live in the open UI. Omit name for an untitled notebook. To open a notebook that already exists, use open_notebook instead.', inputSchema: { name: z.string().optional() } }, async ({ name }) => text(svc.createNotebook(name)));

	// --- read ---
	server.registerTool('get_notebook_map', { description: 'Compact hierarchical section tree (from markdown headers): id, type, header level/title, one-line summary, run status, staleness, has-output, visibility, plus a `kernel` header {started, session_id, execs_this_session}. Not full content. run_status separates LIVE from SAVED execution: ok_session/error_session = the cell ran in the CURRENT kernel session (ran_this_session:true); ok_persisted/error_persisted = the outputs were loaded from the .ipynb and are LEFTOVER from a previous session (ran_this_session:false) — nothing those cells define exists in the kernel. error_kernel_unavailable = the run could not reach a kernel at all, so this failure is LIVE, not leftover (nothing executed, so ran_this_session stays false). stale_state = not_run|fresh|stale|n/a; stale:true (with stale_reason + stale_upstream) means the cell ran this session but a cell it depends on has since changed (edited or re-run), so its output is OUT OF DATE — re-run it before trusting it. has_output means a cell has saved output, never that it ran. Trust kernel_state, not saved outputs, for what is actually defined.', inputSchema: {} }, async () => text(await svc.getNotebookMap()));
	server.registerTool('kernel_state', { description: 'THE LIVE TRUTH about what is defined right now: the kernel namespace - imports already loaded, user-defined functions/classes, and variables (with types, shapes, dataframe columns), plus a `databricks` block saying whether a Databricks Connect session is bound (and to which profile/cluster), and `stale_cells` - the cells whose live output is now OUT OF DATE ([{id, reason, upstream}]) because a cell they depend on changed since they ran. Returns {started:false} if no kernel is running (does not boot one); stale:true means the kernel restarted while reading, so the namespace below belongs to session_id and is already gone. Call this BEFORE writing code so you do not re-import modules or redefine names that already exist, and BEFORE depending on a variable an earlier cell defines - a cell can show saved outputs (run_status ok_persisted) yet never have run in this session. If a name is missing here, re-run the cell that defines it. Re-run (or distrust) everything in stale_cells before relying on it. If databricks.connected is true, `spark` and `w` are live: use them, never re-create them.', inputSchema: {} }, async () => text(await svc.getKernelState()));
	server.registerTool('list_variables', { description: 'The live kernel namespace as structured data: every user DATA variable (modules/functions/classes/dunders are filtered out) with {name, type, repr_short, size}, and for pandas/spark DataFrames the SCHEMA {shape, columns:[{name, dtype}]}, for pandas Series {dtype, shape}, for numpy arrays {dtype, shape}. Read-only introspection - it runs NO user code and does not inflate execs_this_session. Use it to SEE the data (a DataFrame\'s columns, an array\'s shape) instead of guessing or adding a throwaway df.head() cell. Reflects only the LIVE kernel session: {started:false} if no kernel is running (it does not boot one); stale:true means the kernel restarted while reading, so nothing listed exists any more.', inputSchema: {} }, async () => text(await svc.getVariables()));
	server.registerTool('inspect_variable', { description: 'Detailed view of ONE live variable by name: full type, shape/len, and kind-specific detail - a DataFrame\'s columns+dtypes plus a small head sample (first rows), a Series\' dtype+head, a numpy array\'s dtype/shape/stats+head, a dict\'s keys, a sequence\'s first items. Bounded (rows/keys/items capped) so a huge object never floods output; a Spark DataFrame returns its schema only (never collected, so no job is triggered). Read-only - runs NO user code, exec count unaffected. Prefer this over adding a df.head() cell just to look. Returns {found:false} when the name is not defined in the live namespace, {started:false} when no kernel is running. Reflects only the LIVE kernel session.', inputSchema: { name: z.string() } }, async ({ name }) => text(await svc.inspectVariable(name)));
	server.registerTool('read_cell', { description: 'Read one cell by UUID (source + summarized outputs). ran_this_session/run_status tell you whether the outputs came from the CURRENT kernel session (ok_session) or are saved leftovers from a previous one (ok_persisted). run_status error_kernel_unavailable means the kernel could not be reached; that failure is LIVE, not leftover. stale_state/stale say whether a dependency changed since this cell ran (stale ⇒ re-run before trusting the output).', inputSchema: { id: z.string() } }, async ({ id }) => { const r = await svc.readCell(id); return r ? text(r) : notFound(`cell ${id} not found or hidden`); });
	server.registerTool('read_cells', { description: 'Read multiple cells by UUID (same per-cell ran_this_session/run_status/stale semantics as read_cell).', inputSchema: { ids: z.array(z.string()) } }, async ({ ids }) => text(await svc.readCells(ids)));
	server.registerTool('read_by_location', { description: 'Read a cell by location: index (0-based over visible cells), position first/last, or next/prev of a cell.', inputSchema: { index: z.number().int().optional(), position: z.enum(['first', 'last']).optional(), relative_to: z.string().optional(), direction: z.enum(['next', 'prev']).optional() } }, async ({ index, position, relative_to, direction }) => { const r = await svc.readByLocation({ index, position, relativeTo: relative_to, direction }); return r ? text(r) : notFound('no cell at that location'); });
	server.registerTool('read_section', { description: 'Read all cells under a markdown header (until the next same-or-higher header).', inputSchema: { header_id: z.string() } }, async ({ header_id }) => { const r = await svc.readSection(header_id); return r ? text(r) : notFound(`${header_id} is not a visible header cell`); });
	server.registerTool('search_cells', { description: 'Search cells; returns ids + snippets. An output snippet from a cell with ran_this_session:false was loaded from the .ipynb and is LEFTOVER from a previous session - kernel_state is the live truth about what is defined now.', inputSchema: { query: z.string(), in: z.enum(['input', 'output', 'both']).optional() } }, async ({ query, in: where }) => text(svc.searchCells(query, where ?? 'both')));
	server.registerTool('get_errors', { description: 'List cells whose latest output is an error (ename/evalue/traceback). ran_this_session:false means the error was loaded from the .ipynb and was raised by a PREVIOUS session, not the live kernel. The exception is kernel_unavailable:true (run_status error_kernel_unavailable): the kernel could not be reached, so this failure is LIVE, not leftover - fix the kernel rather than ignoring it as stale.', inputSchema: {} }, async () => text(svc.getErrors()));
	server.registerTool('get_full_output', { description: 'Fuller cell outputs. Medium-capped by default; size=full returns everything. Images passed through. ran_this_session:false means these outputs were loaded from the .ipynb and are LEFTOVER from a previous session - kernel_state is the live truth about what is defined now.', inputSchema: { id: z.string(), size: z.enum(['medium', 'full']).optional() } }, async ({ id, size }) => {
		const r = svc.getFullOutput(id, size ?? 'medium');
		if (!r) return notFound(`cell ${id} not found or hidden`);
		// Tool result content is a text summary plus one image block per image output.
		type TextBlock = { type: 'text'; text: string };
		type ImageBlock = { type: 'image'; data: string; mimeType: string };
		const content: Array<TextBlock | ImageBlock> = [{ type: 'text', text: JSON.stringify({ id: r.id, size: r.size, ran_this_session: r.ran_this_session, outputs: r.outputs.map((o) => (o.data ? { type: o.type, image: o.image } : o)) }, null, 2) }];
		for (const o of r.outputs) if (o.data) content.push({ type: 'image', data: String(o.data), mimeType: String(o.image) });
		return { content };
	});

	// --- write ---
	server.registerTool('add_cell', { description: `Add a cell (optionally after a cell), of type code|sql|markdown, with optional source. A sql cell holds a SQL query that runs against the connected Databricks spark session (see doctrine clause 10). Adds only - it does NOT run or render the cell (a markdown cell added this way stays raw source until rendered; prefer add_and_run for markdown/sql).${ROUTE_IMPORTS_DOC}`, inputSchema: { after_id: z.string().optional(), cell_type: z.enum(['code', 'sql', 'markdown']).optional(), source: z.string().optional(), route_imports: z.boolean().optional() } }, async ({ after_id, cell_type, source, route_imports }) => {
		const { ids, imports } = await svc.addCells([{ cell_type, source }], after_id, { routeImports: route_imports ?? true });
		// Source that was nothing but imports creates no cell of its own — they went
		// straight to the imports cell, which is then the cell this call produced.
		return ids.length
			? text({ id: ids[0], ...(imports ? { imports } : {}) })
			: text({ id: imports!.cell_id, routed_to_imports: true, imports });
	});
	server.registerTool('add_cells', { description: `Add multiple cells in order (optionally after a cell).${ROUTE_IMPORTS_DOC}`, inputSchema: { cells: z.array(z.object({ cell_type: z.enum(['code', 'sql', 'markdown']).optional(), source: z.string().optional() })), after_id: z.string().optional(), route_imports: z.boolean().optional() } }, async ({ cells, after_id, route_imports }) => text(await svc.addCells(cells, after_id, { routeImports: route_imports ?? true })));
	server.registerTool('edit_cell', { description: `Replace a cell source in place.${ROUTE_IMPORTS_DOC} (Editing the imports cell itself never routes — you are already writing into it.)`, inputSchema: { id: z.string(), source: z.string(), route_imports: z.boolean().optional() } }, async ({ id, source, route_imports }) => {
		const r = await svc.editCell(id, source, { routeImports: route_imports ?? true });
		return r ? text(r) : notFound(`cell ${id} not found`);
	});
	server.registerTool('consolidate_imports', { description: 'Sweep every MODULE-LEVEL import in the active notebook into its single "imports" cell (the user-designated cell wherever it sits, or created at the top on demand; deduplicated, __future__ first, canonically ordered), strip those lines from the cells they came from, and run the imports cell so the kernel has them. Imports nested inside a def/class/if/try body are deliberately left alone — a nested import is a choice (lazy loading, TYPE_CHECKING), not an accident. Idempotent: running it twice changes nothing and re-runs nothing.', inputSchema: {} }, async () => text(await svc.consolidate()));
	server.registerTool('create_checkpoint', { description: 'Snapshot the active notebook (cells + source + outputs + metadata) to a restorable checkpoint the human can revert to. Cellar already takes an automatic checkpoint before your mutations and runs (throttled to one per several actions), so you rarely need this — call it only to mark a deliberate restore point before a risky change. Returns the checkpoint metadata {id, at, trigger, label, cellCount}.', inputSchema: { label: z.string().optional() } }, async ({ label }) => text(svc.checkpoint(label)));
	server.registerTool('delete_cell', { description: 'Delete a cell.', inputSchema: { id: z.string() } }, async ({ id }) => (svc.removeCell(id) ? text({ ok: true }) : notFound(`cell ${id} not found`)));
	server.registerTool('move_cell', { description: 'Move a cell to an absolute index.', inputSchema: { id: z.string(), position: z.number().int() } }, async ({ id, position }) => (svc.moveCell(id, position) ? text({ ok: true }) : notFound(`cell ${id} not found`)));
	server.registerTool('set_cell_type', { description: 'Set a cell type to code, sql, or markdown. sql tags the code cell as a SQL query (runs against the connected Databricks spark session); code reverts it to Python.', inputSchema: { id: z.string(), cell_type: z.enum(['code', 'sql', 'markdown']) } }, async ({ id, cell_type }) => (svc.setType(id, cell_type) ? text({ ok: true }) : notFound(`cell ${id} not found`)));
	server.registerTool('set_cell_visibility', { description: 'Show/hide a cell from the agent (cellar.hidden_from_agent).', inputSchema: { id: z.string(), hidden: z.boolean() } }, async ({ id, hidden }) => (svc.setCellVisibility(id, hidden) ? text({ ok: true, id, hidden }) : notFound(`cell ${id} not found`)));

	// --- execute ---
	server.registerTool('add_and_run', { description: `PREFERRED write-and-execute: create a cell AND run it in one call (fewer round-trips than add_cell then run_cell). Adds a code|sql|markdown cell (default code) with the given source, after a cell (after_id) or appended at the end, runs it, and returns run_cell's result (status + outputs) plus the new cell id. Code that raises returns the error as the result (does not fail — the cell still exists). A markdown cell_type is created AND rendered (markdown does not execute on the kernel - running it renders it, status "rendered"); this is the way to add markdown so it shows rendered rather than raw source. Use add_cell (no run) only when you want to add a cell WITHOUT running/rendering it.${ROUTE_IMPORTS_DOC} Routing happens BEFORE this cell runs, so an import it needs is already in the kernel. Source that is ONLY imports creates no cell at all (they go straight to the imports cell) and returns routed_to_imports:true.`, inputSchema: { source: z.string(), cell_type: z.enum(['code', 'sql', 'markdown']).optional(), after_id: z.string().optional(), route_imports: z.boolean().optional() } }, async ({ source, cell_type, after_id, route_imports }) => text(await svc.addAndRun({ source, cellType: cell_type, afterId: after_id, routeImports: route_imports ?? true })));
	server.registerTool('run_cell', { description: 'Run one cell by UUID. Running a markdown cell RENDERS it (no code executes) and returns status "rendered"; use this (or add_and_run) so markdown shows rendered rather than raw source. One shared kernel means one run at a time app-wide: if the kernel is busy your run is QUEUED (never dropped) and this call waits its turn, then returns the real outputs annotated queued:true + queue_position + waited_ms. If that cell is ALREADY queued (or running) it is not enqueued twice - the call returns immediately with status "queued" (or "running") and its queue_position; a pending run has its source refreshed to the current one. status "cancelled" means an interrupt/restart dropped the queued run before it started; nothing executed. See run_queue.', inputSchema: { id: z.string() } }, async ({ id }) => { const r = await svc.runCell(id); return r ? text(r) : notFound(`cell ${id} not found`); });
	server.registerTool('run_cells', { description: 'Run multiple cells in order, each waiting its turn in the kernel queue. Stops at the first cell whose queued run an interrupt/restart cancelled (status "cancelled") - the rest would run against a namespace their predecessors never populated.', inputSchema: { ids: z.array(z.string()) } }, async ({ ids }) => text(await svc.runCells(ids)));
	server.registerTool('run_all', { description: 'Run all code cells in document order (same queueing + cancellation semantics as run_cells).', inputSchema: {} }, async () => text(await svc.runAll()));
	server.registerTool('run_stale', { description: 'Re-run every STALE code cell (a cell that ran this session but whose inputs changed since) in dependency order, bringing the notebook back in sync with its current code. Returns {ran:[ids], results}. Use this after editing an upstream cell instead of hunting down every downstream cell by hand; see stale_cells in kernel_state / stale_state in get_notebook_map for what is stale. Same queueing + cancellation semantics as run_cells.', inputSchema: {} }, async () => text(await svc.runStale()));
	server.registerTool('run_range', { description: 'Run code cells in the inclusive range from one cell to another (same queueing + cancellation semantics as run_cells).', inputSchema: { from_id: z.string(), to_id: z.string() } }, async ({ from_id, to_id }) => text(await svc.runRange(from_id, to_id)));

	// --- databricks (read-only; connecting stays a human action in the sidebar) ---
	server.registerTool('databricks_status', { description: 'Whether a Databricks Connect session is LIVE in the kernel, and against which profile/cluster/host. When connected:true, `spark` (a Spark session on that cluster) and `w` (a databricks.sdk WorkspaceClient) are bound in the kernel namespace and verified reachable - use them directly instead of writing connection boilerplate. Liveness is checked with a cheap cached `SELECT 1` probe (short TTL, skipped while the kernel is busy), so a session that expired server-side (idle timeout / cluster GC) is caught even though `spark` is still bound. On expiry Cellar AUTO-RECONNECTS against the same profile+cluster: a healed response is connected:true with reconnected:true (re-run any cell that failed with SESSION_CLOSED). If auto-reconnect fails it returns connected:false with expired:true - ask the user to reconnect from the Databricks sidebar, then re-run. connected:true with liveness_unverified:true means liveness could not be confirmed (kernel busy or a transient error), not that it is dead. connected:false without expired means no session at all: ask the user to connect. May run a tiny kernel probe; never boots a kernel. The same block appears in kernel_state and get_notebook_map.', inputSchema: {} }, async () => text(await svc.databricks.status()));
	server.registerTool('databricks_list_catalogs', { description: 'List the Unity Catalog catalogs the connected workspace exposes: [{name, comment}]. Runs the Databricks SDK server-side (not in the kernel), so it never queues behind a running cell. Fails with error "not_connected" when there is no live session.', inputSchema: {} }, async () => databricksTool(() => svc.databricks.catalogs()));
	server.registerTool('databricks_list_schemas', { description: 'List the schemas in one Unity Catalog catalog: [{name, comment}]. Server-side SDK call. Fails with error "not_connected" when there is no live session, "not_found" when the catalog does not exist, "permission_denied" when you cannot see it.', inputSchema: { catalog: z.string() } }, async ({ catalog }) => databricksTool(() => svc.databricks.schemas(catalog)));
	server.registerTool('databricks_list_tables', { description: 'List the tables in one Unity Catalog schema: [{name, full_name, table_type, format}]. Use full_name with databricks_preview_table or spark.read.table(). Server-side SDK call. Fails with error "not_connected" when there is no live session.', inputSchema: { catalog: z.string(), schema: z.string() } }, async ({ catalog, schema }) => databricksTool(() => svc.databricks.tables(catalog, schema)));
	server.registerTool('databricks_preview_table', { description: 'Read the first `limit` rows of a table (default 20, max 1000) through the kernel\'s live `spark`, and return {name, limit, schema:[{name,type}], rows:[{column: value}]}. Prefer this over adding a cell when you are only orienting yourself: it reads the table WITHOUT touching the notebook. When the query belongs in the notebook\'s story, add_and_run a cell with spark.read.table(...) instead. `name` is catalog.schema.table (a two-part schema.table is accepted for legacy metastores). Fails with error "not_connected" when there is no live session, "read_failed" when Spark rejects the read.', inputSchema: { name: z.string(), limit: z.number().int().min(1).max(1000).optional() } }, async ({ name, limit }) => databricksTool(() => svc.databricks.preview(name, limit ?? 20)));

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
	const transports: Record<string, StreamableHTTPServerTransport> = {}; // sessionId -> transport

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
				let transport = sid ? transports[sid] : undefined;
				if (!transport && isInitializeRequest(body)) {
					const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
						sessionIdGenerator: () => randomUUID(),
						onsessioninitialized: (id: string) => {
							transports[id] = created;
						}
					});
					created.onclose = () => {
						if (created.sessionId) delete transports[created.sessionId];
					};
					transport = created;
					const server = new McpServer({ name: 'cellar', version: '0.1.0' }, { instructions: INSTRUCTIONS });
					registerTools(server);
					await server.connect(created);
				}
				if (!transport) {
					res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session; send an initialize request first.' }, id: null }));
					return;
				}
				await transport.handleRequest(req, res, body);
			} else if (req.method === 'GET' || req.method === 'DELETE') {
				const sid = req.headers['mcp-session-id'] as string | undefined;
				const transport = sid ? transports[sid] : undefined;
				if (!transport) {
					res.writeHead(400).end('missing or unknown session');
					return;
				}
				await transport.handleRequest(req, res);
			} else {
				res.writeHead(405).end('method not allowed');
			}
		} catch (err) {
			if (!res.headersSent) res.writeHead(500).end('mcp error: ' + String(err));
		}
	});

	httpServer.on('error', (err) => console.error('[cellar-mcp] server error:', err));
	httpServer.listen(port, '127.0.0.1', () => {
		console.log(`[cellar-mcp] MCP agent interface on http://127.0.0.1:${port}/mcp`);
	});
}
