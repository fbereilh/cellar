/**
 * Cellar - shared server-side domain types.
 *
 * One cohesive home for the types that cross module boundaries: the canonical
 * notebook document + cell shapes, nbformat output objects, the kernel session /
 * status model, the run-stream frames, the SSE event bus payloads, and the run
 * queue snapshot. Module-local types stay in their own files; anything two
 * server modules must agree on lives here.
 *
 * Where the data genuinely arrives untyped from a dynamic boundary (a Jupyter
 * wire message, a child-process JSON line) the type is `unknown` and narrowed at
 * the use site, never a blanket `any`.
 */

import type { ImportChangeStamps } from './importBindings';
import type { ExportHazard } from '../exportHazard';

export type { ImportChangeStamps };

// --- cells + notebook document --------------------------------------------

/** nbformat cell type as stored on disk. All THREE nbformat 4.5 types are real
 * Cellar types; `sql`, `chat` and `mojo` are logical Cellar types that map onto a
 * `code` cell tagged `cellar.language` (see `$lib/cellLanguage` for why the
 * reasoning inverts between those and `raw`). */
export type CellType = 'code' | 'markdown' | 'raw';

/** The logical cell types the UI chooses between (the agent write tools speak
 * all but `chat`). `sql`, `chat` and `mojo` are `code` cells;
 * `code`/`markdown`/`raw` are nbformat types of their own. Keep `CellType` a
 * SUBSET of this - the clipboard, the undo stack and the insert specs all assign
 * one into the other. */
export type LogicalCellType = 'code' | 'markdown' | 'sql' | 'raw' | 'chat' | 'mojo';

/** Who initiated a run: a human via the UI, or an agent via MCP. */
export type Actor = 'user' | 'agent';

/** The kernel-session epoch a run executed in (see kernel.js). `null` = no
 * kernel/session. Monotonic; 0 means no kernel has ever started. */
export type SessionId = number;

/**
 * Runtime-only run stamp recorded in `metadata.cellar.lastRun`. Never persisted
 * to disk (clean.js strips it) - the `session` epoch is the sole evidence a cell
 * ran against the namespace that is live right now.
 */
export interface LastRun {
	/** Wall-clock ms when the run started. */
	at: number;
	/** How long the run took, in ms. */
	durationMs: number;
	actor: Actor;
	/** Jupyter execute-reply status ('ok' | 'error' | 'abort'). */
	status: string;
	/** Kernel-session epoch the run started in, or null if no kernel existed. */
	session: SessionId | null;
	/** Set when execute() threw before any kernel existed (a live kernel-down failure). */
	kernel_unavailable?: boolean;
}

/**
 * Cellar's allowlisted `cellar` metadata namespace. Round-trips through
 * clean-on-save except the runtime-only keys (`lastRun`, `editedAt`,
 * `importBindings`), which are stripped symmetrically on read + write.
 */
export interface CellarNamespace {
	/** Reserved: mark a cell for future extract-to-.py. */
	extract?: boolean;
	/** Reserved visibility placeholder. */
	visible?: boolean;
	/** Hide a cell from the MCP agent surface (visible by default). */
	hidden_from_agent?: boolean;
	/** Explicit "scroll outputs" choice; undefined = auto height heuristic. */
	output_scrolled?: boolean;
	/**
	 * Explicit per-cell "hide code input" choice for a code cell (the editor is
	 * hidden, the output stays). Tri-state: undefined = inherit the notebook-wide
	 * `hide_all_code` default, true = force hidden, false = force shown. Display
	 * only - the cell's source is never touched and it still runs.
	 */
	hide_input?: boolean;
	/** Logical cell language ('sql' | 'chat' | 'mojo'). Absent = Python. */
	language?: string;
	/** Cell role, e.g. the pinned imports cell ('imports'). */
	role?: string | null;
	/**
	 * nbdev-style export flag: include this cell in the `.py` module. Only a PYTHON
	 * code cell may carry it - a SQL cell is an nbformat `code` cell too, so the
	 * eligibility test lives in `exportRole.ts` (`canExportCell`/`isExportCell`),
	 * which every surface reads; a stale or hand-edited flag anywhere else is inert.
	 */
	export?: boolean;
	/** Runtime-only run stamp (never persisted). */
	lastRun?: LastRun;
	/** Runtime-only wall-clock ms the source last changed (never persisted). */
	editedAt?: number;
	/**
	 * Runtime-only, never persisted: this cell's last KNOWN-GOOD module-level import
	 * bindings - per name, the canonical statement that bound it, the wall-clock ms
	 * it last CHANGED (0 / an absent name = unchanged since this document was
	 * loaded), and, once the name leaves a knowable source, when it was dropped. It
	 * is the baseline every later edit is diffed against, so neither a transient
	 * unparseable snapshot nor a momentarily emptied cell can re-stamp everything.
	 * Feeds the staleness rule so an imports-cell edit stales only the cells that
	 * read a name whose binding actually moved - see `importBindings.ts`.
	 */
	importBindings?: ImportChangeStamps;
	[key: string]: unknown;
}

/**
 * Cell metadata. A clean keeps only the named allowlist in `clean.ts`
 * (`ALLOWED_CELL_METADATA`: Cellar's own `cellar` namespace plus nbdev's base cell
 * keys `nbdev` and `hide_input`, and on a `raw` cell additionally
 * `ALLOWED_RAW_CELL_METADATA`); everything else is dropped.
 */
export interface CellMetadata {
	cellar?: CellarNamespace;
	[key: string]: unknown;
}

/** A canonical in-memory cell (source is a single string, not nbformat lines). */
export interface Cell {
	id: string;
	cell_type: CellType;
	source: string;
	/** Present for code cells; markdown cells carry none. */
	outputs?: CellOutput[];
	metadata?: CellMetadata;
}

/** Serializable cell view handed to the browser / MCP (metadata always present). */
export interface CellView {
	id: string;
	cell_type: CellType;
	source: string;
	outputs: CellOutput[];
	metadata: CellMetadata;
}

/**
 * The server-owned document. `metadata` is nbformat notebook metadata (kept as
 * `undefined` until materialized). `jpFormat` records the jupytext/Databricks
 * format a `.py` notebook was opened in; absent for `.ipynb`.
 */
export interface NotebookDoc {
	path: string;
	cells: Cell[];
	metadata?: NotebookMetadata;
	jpFormat?: string;
	/**
	 * Runtime-only (never serialized): why the last EXPLICIT export of the
	 * nbdev-style `.py` module threw, or null when it wrote / had nothing to write.
	 * See `notebook.ts`'s `regenerateExportModule` - best-effort must not mean
	 * silent. Only the explicit export paths write it (an ordinary save does not
	 * export), so it describes the last time the module was actually asked for.
	 */
	lastExportError?: string | null;
	/**
	 * Runtime-only (never serialized): the compile hazards last BROADCAST for this
	 * doc, joined into one comparison key. Held ONLY so `publishExportHazards` can
	 * tell a change from a no-op - the hazards themselves are always recomputed
	 * fresh, so nothing ever reads a stale value out of this.
	 *
	 * ABSENT means nothing has been broadcast YET, which is NOT the same as having
	 * broadcast no hazards (`''`) - a doc loaded from disk already holding one
	 * seeds the browser through `getNotebook` without ever publishing. Compare
	 * strictly; coercing the sentinel swallows the event that CLEARS such a
	 * hazard.
	 */
	lastExportHazardKey?: string;
}

/** Serializable notebook view for the browser (SSR + REST). */
export interface NotebookView {
	workspace: string;
	path: string;
	cells: CellView[];
	/**
	 * nbdev-style export target (`.py` module path), or null when unset. The STORED
	 * setting (what the target input edits), not the EFFECTIVE target the exporter
	 * resolves - a `#|default_exp` directive written in a cell is absent here; see
	 * `exportTargetInfo` (`resolveExportTarget`) for that.
	 */
	exportTarget: string | null;
	/**
	 * The base `exportTarget` is measured from: `workspace` (an absent
	 * `export_base` - the legacy default), `notebook`, or `git`. Reported
	 * verbatim, so an unknown hand-edited value reaches the select unmatched
	 * rather than masquerading as `workspace` (see `readExportBase`).
	 */
	exportBase: string;
	/**
	 * The workspace-relative path the EFFECTIVE target (a `#|default_exp`
	 * directive included) resolves to, or null when none is configured or it
	 * cannot resolve. What the importability warning is decided from.
	 */
	exportResolved: string | null;
	/** Why a CONFIGURED target cannot resolve (base `git` with no repo, an escape, an unknown base), else null. */
	exportResolveError: string | null;
	/**
	 * Constructs in the marked cells that make the generated module uncompilable
	 * (`$lib/exportHazard`) - what the export bar's standing warning renders.
	 * Empty on every ordinary notebook, and empty when no target is configured.
	 *
	 * A POSITIVE finding, never a compile verdict: the class of module that fails
	 * `compile` is wider than what is detected, so an empty list means "none of the
	 * things Cellar checks for", never "this module compiles".
	 */
	exportHazards: ExportHazard[];
	/**
	 * Declared code root: the workspace-relative directory this notebook's KERNEL
	 * resolves code from (cwd + `sys.path`), or null for the workspace root.
	 */
	root: string | null;
	/**
	 * True for a `.py` (jupytext / Databricks source) notebook, which is written
	 * back from its cells alone and so stores no notebook-level metadata: the
	 * browser needs this to hide the settings such a notebook cannot keep (the
	 * code-root picker).
	 */
	isPy: boolean;
	/** Heading levels (1-6) rendered with a display-only auto-number. */
	headerNumbering: number[];
	/** Notebook-wide "hide all code inputs" (report view) default. */
	hideAllCode: boolean;
}

/** nbformat kernelspec. */
export interface KernelSpec {
	name: string;
	display_name?: string;
	language?: string;
	[key: string]: unknown;
}

/** Notebook-level `cellar` metadata namespace (round-trips through clean-on-save). */
export interface NotebookCellarNamespace {
	/**
	 * nbdev-style export target: a `.py` module path, relative to the recorded
	 * `export_base` (workspace-relative when that key is absent - the permanent
	 * legacy meaning). Always STORED relative to its base, whatever a caller
	 * passed - `setExportTarget` validates the path (resolving inside the
	 * workspace, and a `.py` file, since the exporter WRITES it) and normalizes
	 * it there, so the committed `.ipynb` stays portable.
	 */
	export_target?: string;
	/**
	 * The base `export_target` is measured from: `notebook` (the notebook's own
	 * folder) or `git` (the notebook's enclosing repository). ABSENT means
	 * workspace-relative - the pre-base shape, never migrated and never written
	 * as an explicit `workspace` - so legacy notebooks resolve unchanged forever.
	 */
	export_base?: string;
	/**
	 * Code root: the workspace-relative directory this notebook's kernel runs in
	 * and imports from. Absent = the workspace root. See `$lib/notebookRoot`.
	 */
	root?: string;
	/** Heading levels (1-6) rendered with a display-only auto-number. */
	header_numbering?: number[];
	/**
	 * Notebook-wide "hide all code inputs" default (a clean output-only report
	 * view). A cell's explicit `cellar.hide_input` overrides this per cell.
	 */
	hide_all_code?: boolean;
	[key: string]: unknown;
}

/**
 * nbformat notebook metadata. A clean keeps only the named allowlist in `clean.ts`
 * (`ALLOWED_NB_METADATA`, which carries Cellar's own keys alongside the foreign
 * ones the ecosystem defines); everything else is dropped.
 */
export interface NotebookMetadata {
	kernelspec?: KernelSpec;
	cellar?: NotebookCellarNamespace;
	[key: string]: unknown;
}

// --- nbformat outputs ------------------------------------------------------

/** A MIME bundle: mime type → payload (string, string[], or JSON for app/json). */
export type MimeBundle = Record<string, unknown>;

export interface StreamOutput {
	output_type: 'stream';
	name: string;
	text: string | string[];
}

export interface ExecuteResultOutput {
	output_type: 'execute_result';
	data: MimeBundle;
	metadata: Record<string, unknown>;
	execution_count: number | null;
}

export interface DisplayDataOutput {
	output_type: 'display_data';
	data: MimeBundle;
	metadata: Record<string, unknown>;
}

export interface ErrorOutput {
	output_type: 'error';
	ename: string;
	evalue: string;
	traceback: string[];
}

/** Any nbformat cell output. */
export type CellOutput =
	| StreamOutput
	| ExecuteResultOutput
	| DisplayDataOutput
	| ErrorOutput;

/** An nbformat cell as stored on disk (source is multiline; outputs on code cells). */
export interface NbCell {
	cell_type: CellType;
	id?: string;
	metadata?: CellMetadata;
	source: string | string[];
	outputs?: CellOutput[];
	execution_count?: number | null;
}

/** An nbformat 4.5 notebook object. */
export interface NbNotebook {
	cells: NbCell[];
	metadata: NotebookMetadata;
	nbformat: number;
	nbformat_minor: number;
}

// --- kernel + run stream ---------------------------------------------------

/** Jupyter kernel status (superset of the states we surface). */
export type KernelStatus =
	| 'not_started'
	| 'not started'
	| 'starting'
	| 'idle'
	| 'busy'
	| 'restarting'
	| 'autorestarting'
	| 'terminating'
	| 'dead'
	| 'unknown'
	| string;

/** A frame emitted by `execute()`'s onEvent during a run. */
export type RunStreamEvent =
	| { type: 'kernel'; id: string; session: SessionId }
	| { type: 'status'; execution_state: string }
	| { type: 'output'; output: CellOutput; index?: number }
	| { type: 'done'; status: string; execution_count: number | null; session: SessionId };

/** Options for a single `execute()` call. */
export interface ExecuteOptions {
	/** A Cellar-issued probe (inspect/databricks): excluded from execs_this_session. */
	internal?: boolean;
}

/** Result of `executeCellRun` (run.js). */
export interface CellRunResult {
	outputs: CellOutput[];
	status: string;
	session: SessionId | null;
	kernelDown: boolean;
	lastRun: LastRun;
}

// --- SSE event bus ---------------------------------------------------------

/**
 * A per-notebook event published on the in-process bus (events.js). Producers
 * spread per-type extras (`cellId`, `output`, `source`, …) onto this shape, so
 * the base carries the common fields plus an open index signature. Consumers
 * discriminate on `type`.
 */
export interface CellarEvent {
	type: string;
	/** Canonical absolute notebook path the event belongs to. */
	nb: string;
	/** Initiating tab's id when a UI action; absent for agent (MCP) events. */
	originId?: string | null;
	[key: string]: unknown;
}

/** A published per-notebook event, stamped with its monotonic `seq`. */
export type PublishedEvent = CellarEvent & { seq: number };

/**
 * A global event that belongs to no single notebook (the kernel run queue). It
 * is a FULL state snapshot, so it carries no `seq` - a missed one self-heals on
 * the next. Dispatched before the per-notebook `nb`/`seq` filter.
 */
export interface GlobalEvent {
	type: string;
	global: true;
	[key: string]: unknown;
}

/** Anything delivered to a `subscribe()` listener. */
export type DispatchedEvent = PublishedEvent | GlobalEvent;

// --- run queue -------------------------------------------------------------

/** A pending run in the kernel queue snapshot; `position` is 1-based (1 = next). */
export interface QueueEntryView {
	nb: string;
	cellId: string;
	actor: Actor;
	position: number;
}

/** The cell holding the kernel right now. */
export interface RunningView {
	nb: string;
	cellId: string;
	actor: Actor;
	/**
	 * Wall-clock ms at which this run began EXECUTING — the same instant the
	 * `run:start` event carries as `at` and the closing `run:end` measures its
	 * `durationMs` from, reported by the run itself (`noteRunStarted`) so there is
	 * one origin rather than one per surface. It is how a client that missed
	 * `run:start` (a tab whose SSE stream connects, or a notebook that mounts,
	 * mid-run) still knows how long the running cell has been going.
	 *
	 * Absent for the sub-millisecond window between the kernel being claimed and the
	 * run reporting in — and for a claim whose owner then bails before executing
	 * (`cell_removed`). "Running, start unknown" is the honest reading; a consumer
	 * must render the run without an elapsed rather than inventing an origin.
	 */
	startedAt?: number;
}

/** The whole kernel-queue state (broadcast + the `run_queue` MCP tool). */
export interface QueueState {
	running: RunningView | null;
	queue: QueueEntryView[];
}

// --- ipywidgets (tqdm progress bars) --------------------------------------

/**
 * One ipywidgets model in the live kernel session. `state` is the raw trait
 * bundle received over the comm protocol (`_model_name`, `value`, `children`,
 * …); it is a dynamic Jupyter payload, narrowed by the frontend renderer.
 */
export interface WidgetModel {
	/** The comm id, which is also the model id a `widget-view` output references. */
	comm_id: string;
	/**
	 * Absolute path of the notebook whose kernel owns this widget. Comm ids are
	 * globally unique per kernel session, so this is provenance rather than a
	 * collision guard — it lets a per-notebook restart clear only its own widgets
	 * and lets a client associate a model with the tab it belongs to.
	 */
	nb?: string;
	state: Record<string, unknown>;
}

/** All widget models known to the server, for seeding a freshly-connected tab. */
export interface WidgetSnapshot {
	models: WidgetModel[];
}
