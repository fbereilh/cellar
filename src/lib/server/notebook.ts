/**
 * Cellar — notebook documents (server-owned).
 *
 * Cellar owns the live document(s) in memory and reconstitutes them from the
 * committed `.ipynb` on load (spec §4). The workspace has a default notebook
 * (`notebook.ipynb`), but any `.ipynb` under the workspace can also be opened
 * as a live, kernel-attached document — each keyed by its absolute path in
 * `docs`. Each notebook gets its OWN kernel; each doc persists to its own file.
 *
 * `activePath` tracks which notebook the agent-facing tools (MCP) operate on by
 * default: it starts as the default notebook and follows whichever notebook the
 * UI focuses. The browser addresses cell operations by explicit notebook path,
 * so it never races the active pointer.
 *
 * Cellar owns cell-ID generation and enforces uniqueness on every load/save —
 * it does NOT rely on nbformat's lenient auto-rename (spec §3, nbdev report §2).
 * IDs are readable slugs from a monotonic counter, never reused and never
 * regenerated on edit/run/reorder. Cell ids only need to be unique within a
 * single document (two open notebooks may legitimately share an id).
 */
import { dirname, join, resolve, isAbsolute, relative, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readNotebook, deserialize, writeNotebook, serialize, stringify } from './ipynb';
import { isPyPath, readPyNotebook, writePyNotebook } from './jupytext';
import { publish } from './events';
import { cancelRun } from './run-queue';
import { truncateActiveRunOutputs } from './run-output-registry';
import { IMPORTS_ROLE, isImportsCell, clampMoveIndex } from '../importsRole';
import { moveSelectionPlan } from '../cellSelection';
import {
	exportNotebookToPy,
	resolveExportTarget,
	docExportHazards,
	type ExportResult,
	type ResolvedExportTarget
} from './export-py';
import type { ExportHazard } from '../exportHazard';
import { canExportCell } from '../exportRole';
import { isHiddenFromAgent } from '../agentVisibility';
import { isExportBase, type ExportBase } from '../exportTarget';
import { gitRootOf } from './git';
import { resolveInWorkspace } from './fstree';
import { isLogicalCellType, isPyUnsupportedType, languageTagFor, logicalCellType, nbCellType, textNotebookCellTypeError } from '../cellLanguage';
import { foldImportChange, pruneImportBindings } from './importBindings';
import { stripRuntimeMeta } from './clean';
import { normalizeRootPath, textNotebookRootError } from '../notebookRoot';
import type {
	Cell,
	CellView,
	CellOutput,
	CellMetadata,
	CellarNamespace,
	ImportChangeStamps,
	LogicalCellType,
	LastRun,
	NotebookDoc,
	NotebookView
} from './types';

/** A freshly-minted cell always carries an initialized `cellar` namespace. */
type CellWithCellar = Cell & { metadata: CellMetadata & { cellar: CellarNamespace } };

const FILENAME = 'notebook.ipynb';

const docs = new Map<string, NotebookDoc>(); // absPath -> { path, cells, metadata }
let activePath: string | null = null; // absolute path of the notebook agent tools default to

function workspace(): string {
	return process.env.CELLAR_WORKSPACE || process.cwd();
}

function canonicalPath(): string {
	return join(workspace(), FILENAME);
}

/**
 * Resolve a notebook path argument to an absolute path inside the workspace.
 * `undefined`/`null` → the active notebook (or the default when none is set).
 * Relative paths resolve against the workspace root; the result must stay
 * within the workspace (mirrors the fs-route path guard).
 */
function resolveAbs(nb?: string | null): string {
	if (!nb) return activePath || canonicalPath();
	const abs = isAbsolute(nb) ? resolve(nb) : resolve(workspace(), nb);
	const rel = relative(workspace(), abs);
	if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
		// The workspace root itself is not a notebook; anything above it escapes.
		if (abs !== canonicalPath()) throw new Error('path escapes workspace');
	}
	return abs;
}

/**
 * Mint a fresh, unique cell id. UUIDs satisfy the nbformat id pattern
 * (`^[a-zA-Z0-9-_]+$`, ≤64 chars); Cellar still owns generation + uniqueness.
 */
function mintId(): string {
	return randomUUID();
}

/** Ensure every cell has a unique id; re-key missing/duplicate ones. */
function enforceUniqueIds(cells: Cell[]): void {
	const seen = new Set<string>();
	for (const c of cells) {
		if (!c.id || seen.has(c.id)) {
			c.id = mintId();
		}
		seen.add(c.id);
	}
}

/** The three nbformat 4.5 cell types. The vocabulary a foreign/stored cell type is
 * VALIDATED against (`replaceCells`), never coerced into - see that function. */
const NB_CELL_TYPES = new Set<string>(['code', 'markdown', 'raw']);

function starterCell(): Cell {
	return {
		id: mintId(),
		cell_type: 'code',
		source: "print('hello')\n6 * 7",
		outputs: [],
		// Reserve the `cellar` metadata namespace (future extract/visibility
		// flags). The placeholder proves the allowlist preserves it on clean.
		metadata: { cellar: { extract: false, visible: true } }
	};
}

function newCell(cellType: LogicalCellType = 'code', source = ''): CellWithCellar {
	// 'sql'/'chat'/'mojo' are LOGICAL types: an nbformat `code` cell tagged
	// cellar.language (see $lib/cellLanguage.js, whose `languageTagFor` is the ONE
	// tag rule). code/markdown/raw are nbformat types of their own, and
	// `nbCellType` is the ONE mapping.
	const lang = languageTagFor(cellType);
	const cell: CellWithCellar = {
		id: mintId(),
		cell_type: nbCellType(cellType),
		source: typeof source === 'string' ? source : '',
		outputs: [],
		metadata: { cellar: { extract: false, visible: true, ...(lang ? { language: lang } : {}) } }
	};
	// A cell born WITH a source (paste / split / undo-delete) introduces every
	// binding it holds right now, so it is stamped here for the same reason
	// `setSource` stamps an edit: without it the cell reads as "these bindings have
	// not changed since the document loaded", and a pasted `import polars as pd`
	// above a reader of `pd` would exempt the very edge it just rebound - the one
	// verdict staleness must never invent. Folded from an EMPTY previous source: the
	// cell did not exist before, so nothing about it was ever proven stable. A birth
	// records no removal, so there is nothing here for the prune to date (null).
	//
	// Only a CODE cell, though: a markdown or raw cell's source is not Python, so
	// it binds no module-level imports and stamping it as if it might would be a
	// claim nothing verified. (Staleness filters to code cells, so this is honesty
	// rather than a correctness fix - but the stamp rides `cell:edited` and every
	// checkpoint, so an invented one is not free either.)
	if (cell.cell_type === 'code') {
		setImportBindings(cell.metadata.cellar, foldImportChange('', cell.source, undefined, Date.now()), null);
	}
	return cell;
}

/**
 * The newest moment any cell in this notebook could have CONSUMED another cell's
 * import bindings: the latest `lastRun.at` in the document, or null when no cell
 * carries one.
 *
 * It dates `pruneImportBindings`. A per-cell stamp cannot: the "wipe variables" route
 * (`clearLastRunStamps`) deletes `lastRun` from cells that DID run, so reading only the
 * providing cell's own stamp made a wiped cell look like it had never bound anything.
 * A cell with no stamp reads `not_run` and never reaches the removal ledger, so the
 * document's newest stamp bounds every consumption the ledger can be asked about.
 */
function latestConsumeAt(doc: NotebookDoc): number | null {
	let latest: number | null = null;
	for (const c of doc.cells) {
		const at = c.metadata?.cellar?.lastRun?.at;
		if (typeof at === 'number' && (latest == null || at > latest)) latest = at;
	}
	return latest;
}

/**
 * Store (or clear) a cell's runtime-only import-binding baseline.
 *
 * Pruned on the way in, against the notebook's newest run, so the removal records a
 * debounced autosave mints for a name that was born and died after every run do not
 * accumulate for the life of the session - while a removal any cell could have read
 * is kept, whatever happened to this cell's own run stamp (see `pruneImportBindings`).
 *
 * An empty map is stored as ABSENT rather than `{}`: it says exactly the same
 * thing (nothing proven, nothing changed) and every ordinary code cell would
 * otherwise ship a useless object to the browser on each `cell:edited`, and carry
 * it into every deep-cloned checkpoint snapshot.
 */
function setImportBindings(
	cellar: CellarNamespace,
	stamps: ImportChangeStamps,
	consumedBefore: number | null
): void {
	const kept = pruneImportBindings(stamps, consumedBefore);
	if (Object.keys(kept).length) cellar.importBindings = kept;
	else delete cellar.importBindings;
}

/**
 * Write a doc back to its file in its native format: a `.py` notebook round-trips
 * through jupytext / the Databricks converter in the format it was opened in (no
 * outputs — text notebooks carry none), everything else through nbformat. A doc
 * whose `.py` format could not be determined on load (`jpFormat` unset) is never
 * silently rewritten as `.ipynb`.
 */
function persist(doc: NotebookDoc): void {
	if (doc.jpFormat) writePyNotebook(doc.path, doc.cells, doc.jpFormat);
	else writeNotebook(doc.path, doc);
	autoExportPy(doc);
}

/**
 * Auto-regenerate the nbdev-style `.py` module on every save, so the module
 * stays in lockstep with the notebook without a manual step. A no-op unless a
 * target is configured AND at least one cell is marked for export (see
 * `exportNotebookToPy`), and idempotent (skips the write when the bytes are
 * unchanged). Never lets an export failure break the notebook save: a bad target
 * must not cost the user their notebook write.
 *
 * Best-effort is NOT the same as silent, though: the failure is RECORDED on the
 * doc (`lastExportError`, read back by `lastExportError()`) instead of being
 * swallowed outright. Every export-flow caller reports the module conditionally -
 * present only when nothing was regenerated - so an absent `module` field reads
 * as "the module was written", and a thrown write (a target whose parent is a
 * file, EACCES, ENOSPC) would otherwise be indistinguishable from a success. The
 * record is refreshed on EVERY persist of this doc, so a later successful write
 * clears it.
 */
function autoExportPy(doc: NotebookDoc): void {
	if (doc.jpFormat) return; // `.py` text notebooks carry no cellar cell metadata
	try {
		exportNotebookToPy(doc);
		doc.lastExportError = null;
	} catch (err) {
		doc.lastExportError = String((err as Error)?.message ?? err);
	}
	publishExportHazards(doc);
}

/**
 * Give the auto-on-save export a UI HOME for its compile hazards: broadcast them
 * when - and only when - they CHANGE.
 *
 * The module regenerates on every save, so a hazard appears the moment a cell is
 * marked or edited into one, and the user is nowhere near the manual export
 * button when that happens. Recomputing in `getNotebook` alone would leave the
 * export bar stale until the next `load()` (a reconnect, a seq gap, a restore) -
 * i.e. usually never - so the change is pushed like any other structural fact.
 *
 * Cheap by construction: computed behind a `__future__` substring pre-check over
 * MARKED cells only, and compared before publishing, so an ordinary notebook's
 * every-keystroke autosave emits nothing at all. The event carries no `originId`
 * on purpose - this is DERIVED state, not an echo of one tab's action, so every
 * tab (the initiating one included) must render it.
 *
 * Deliberately NOT folded into `notebook:export-target`: that event is about the
 * target, this is about the marked cells' content, and they move independently.
 *
 * The comparison is STRICT against the raw field and may never coerce the
 * `undefined` sentinel to `''`: a doc that has NEVER broadcast is not a doc whose
 * last broadcast carried no hazards. `loadDoc` never persists, so a notebook that
 * arrives from disk ALREADY holding a hazard seeds the browser with it through
 * `getNotebook` -> `exportTargetView` while this field is still unset - and
 * coerced, the user's FIX (the first persist since load) compared `''` against
 * `''`, returned here, and left the bar asserting a module will not import after
 * it had been repaired. The cost of the strict test is exactly ONE extra
 * empty-hazards event per document lifetime; the change-only rule above exists to
 * spare an event per KEYSTROKE, not per document. Seeding the key from
 * `getNotebook` instead is the WRONG repair - that is a READ, served to SSR and
 * to the agent surface with no browser attached, so it would suppress the event
 * for a client that never received the seed.
 */
function publishExportHazards(doc: NotebookDoc): void {
	const hazards = docExportHazards(doc);
	const key = hazards.map((h) => h.message).join('\u0000');
	if (key === doc.lastExportHazardKey) return;
	doc.lastExportHazardKey = key;
	emit(doc, 'notebook:export-hazards', { hazards });
}

/**
 * Why the last auto-export of this notebook's `.py` module FAILED, or null when
 * the last attempt wrote (or had nothing to write). The one fact a caller needs
 * before it may let an absent `module` warning stand for a successful
 * regeneration - see `autoExportPy`.
 */
export function lastExportError(nb?: string | null): string | null {
	return docFor(nb).lastExportError ?? null;
}

/**
 * Load (or lazily create) the document for an absolute path. Loading NEVER
 * writes to disk — a `.ipynb` is persisted only on a genuine mutation (create /
 * add / edit / run / …), so opening Cellar in a folder drops no uninvited file
 * and opening an existing notebook produces no surprise git diff. Normalization
 * (clean-on-save) therefore happens on the first real mutation, not on open.
 *
 * The default notebook (`notebook.ipynb`) is materialized in memory if missing
 * so callers always get a valid document shape (SSR seeds the shell from it),
 * but that in-memory doc is not written until the user actually creates it or
 * mutates a cell. An arbitrary opened `.ipynb` must already exist on disk.
 */
function loadDoc(abs: string): NotebookDoc {
	let doc = docs.get(abs);
	if (doc) return doc;
	if (isPyPath(abs)) {
		// A `.py` notebook (jupytext percent/light or Databricks source). `jpFormat`
		// records which format to write it back in; the cells carry no outputs.
		if (!existsSync(abs)) throw new Error('notebook not found: ' + abs);
		const parsed = readPyNotebook(abs);
		enforceUniqueIds(parsed.cells);
		doc = { path: abs, cells: parsed.cells, metadata: undefined, jpFormat: parsed.format };
		docs.set(abs, doc);
		return doc;
	}
	const raw = readNotebook(abs);
	if (raw) {
		const parsed = deserialize(raw);
		enforceUniqueIds(parsed.cells);
		doc = { path: abs, cells: parsed.cells, metadata: parsed.metadata };
		docs.set(abs, doc);
	} else if (abs === canonicalPath()) {
		doc = { path: abs, cells: [starterCell()], metadata: undefined };
		docs.set(abs, doc);
	} else {
		throw new Error('notebook not found: ' + abs);
	}
	return doc;
}

/**
 * The ALREADY-LOADED document for `nb`, or undefined - it never materialises one,
 * never seeds the active pointer, and never throws. For a best-effort in-memory
 * MIRROR, which is what the caller below is: `docFor` loads from disk and throws
 * `notebook not found` for a document that has been dropped, and the mirror runs
 * from a flush interval and from the chat child's stdout handler, where a throw is
 * an uncaught exception that kills the process carrying every kernel websocket,
 * the SSE fan-out and the in-process MCP server. Loading would be wrong here even
 * where it succeeds: it would resurrect an entry `dropDocs` deliberately removed.
 * Callers that genuinely REQUIRE a document (every persist path) keep `docFor`.
 */
function liveDoc(nb?: string | null): NotebookDoc | undefined {
	let abs: string;
	try {
		abs = resolveAbs(nb);
	} catch {
		return undefined;
	}
	return docs.get(abs);
}

/** The document a request targets: explicit `nb` path, else the active one. */
function docFor(nb?: string | null): NotebookDoc {
	const abs = resolveAbs(nb);
	const doc = loadDoc(abs);
	if (!activePath) activePath = abs; // first-ever load seeds the active pointer
	return doc;
}

const cellView = (c: Cell): CellView => ({ id: c.id, cell_type: c.cell_type, source: c.source, outputs: c.outputs ?? [], metadata: c.metadata ?? {} });

/**
 * Broadcast a structural document change over the event bus so every open tab
 * reflects an agent-driven (or other-tab) mutation with no reload. This is the
 * single chokepoint: all mutations flow through the exported ops below, so a
 * `publish()` here reaches the browser regardless of whether the caller was the
 * UI REST routes or the in-process MCP tools.
 *
 * Events are tagged with the document's canonical absolute path (`doc.path`) —
 * the same id the browser filters on — and carry the caller's `originId` when
 * one was threaded through (a UI action); the initiating tab drops its own echo
 * so a user's own structural action never double-applies. Agent (MCP) calls
 * pass no `originId`, so every tab renders them.
 */
function emit(doc: NotebookDoc, type: string, extra: Record<string, unknown>, originId?: string | null): void {
	publish({ type, nb: doc.path, ...extra, originId });
}

/** Serializable view of a notebook for the browser. */
export function getNotebook(nb?: string | null): NotebookView {
	const doc = docFor(nb);
	const t = doc.metadata?.cellar?.export_target;
	return {
		workspace: workspace(),
		path: doc.path,
		cells: doc.cells.map(cellView),
		exportTarget: typeof t === 'string' && t.trim() ? t.trim() : null,
		...exportTargetView(doc),
		root: readRoot(doc),
		isPy: !!doc.jpFormat,
		headerNumbering: readHeaderNumbering(doc),
		hideAllCode: !!doc.metadata?.cellar?.hide_all_code
	};
}

/**
 * The export-target fields the BROWSER (and the set-target/set-base replies)
 * carry beside the stored `exportTarget` path: the recorded base (`readExportBase`
 * - the raw metadata value, so an unknown hand-edited base is SHOWN unmatched by
 * the select rather than silently rendered as workspace), and the resolution the
 * exporter would use - the workspace-relative `exportResolved` the importability
 * warning is decided from, or the `exportResolveError` naming why a configured
 * target cannot resolve. Resolution covers the EFFECTIVE target (`#|default_exp`
 * directives included), matching where the module really lands.
 *
 * It also carries `exportHazards`: constructs in the marked cells that make the
 * generated module uncompilable (`$lib/exportHazard`). Computed FRESH from the
 * document rather than read back from the last export, so a tab that loads a
 * notebook it has never saved still sees what its marks describe - and so the
 * export bar's standing warning cannot lag behind the marks by one save.
 */
function exportTargetView(doc: NotebookDoc): {
	exportBase: string;
	exportResolved: string | null;
	exportResolveError: string | null;
	exportHazards: ExportHazard[];
} {
	const info = resolveExportTarget(doc);
	return {
		exportBase: readExportBase(doc),
		exportResolved: info && info.ok ? info.target : null,
		exportResolveError: info && !info.ok ? info.error : null,
		// The SAME `info` is threaded in rather than resolved a second time here.
		exportHazards: docExportHazards(doc, info)
	};
}

/**
 * The recorded export base, verbatim: the trimmed `metadata.cellar.export_base`,
 * or `workspace` when absent/empty - absence permanently means workspace-relative
 * (the pre-base legacy shape). Deliberately NOT validated here, per the
 * `getNotebookRoot` precedent: an unknown hand-edited value reads as its raw self
 * so the resolver refuses it BY NAME, rather than this getter silently answering
 * "workspace" while the exporter refuses to write.
 */
function readExportBase(doc: NotebookDoc): string {
	const raw = doc.metadata?.cellar?.export_base;
	return typeof raw === 'string' && raw.trim() ? raw.trim() : 'workspace';
}

/**
 * The declared code root of a LOADED doc, normalized (see `getNotebookRoot` for
 * why an unusable value comes back verbatim rather than as null).
 */
function readRoot(doc: NotebookDoc): string | null {
	const raw = doc.metadata?.cellar?.root;
	if (typeof raw !== 'string') return null;
	try {
		return normalizeRootPath(raw);
	} catch {
		return raw.trim() || null;
	}
}

/** Sanitized heading-numbering levels (unique, 1-6, ascending) from a doc. */
function readHeaderNumbering(doc: NotebookDoc): number[] {
	const raw = doc.metadata?.cellar?.header_numbering;
	if (!Array.isArray(raw)) return [];
	return [...new Set(raw.filter((l): l is number => Number.isInteger(l) && l >= 1 && l <= 6))].sort(
		(a, b) => a - b
	);
}

/**
 * The notebook as nbformat 4.5 JSON text, produced from the LIVE in-memory
 * document rather than re-read from disk.
 *
 * Byte-identical to what `writeNotebook` persists - the same `serialize` (which
 * runs clean-on-save) and the same deterministic `stringify` - so anything that
 * ships a notebook elsewhere (the Databricks workspace upload) can never
 * disagree with the `.ipynb` on disk. Building it from the live doc is also what
 * makes a `.py` jupytext/Databricks notebook exportable at all: its disk file is
 * text with no outputs, while the doc holds real cells.
 *
 * `name` is the file's own basename, the natural default name for a copy.
 */
export function notebookIpynb(nb?: string | null): { path: string; name: string; json: string } {
	const doc = docFor(nb);
	return {
		path: doc.path,
		name: doc.path.split(sep).pop() || '',
		json: stringify(serialize({ cells: doc.cells, metadata: doc.metadata }))
	};
}

/**
 * Serializable view of the canonical default notebook (`notebook.ipynb`),
 * regardless of the current active pointer. SSR seeds the shell (notebook tab,
 * path/name) from this, so it must never follow `activePath`.
 */
export function getDefaultNotebook(): NotebookView {
	return getNotebook(canonicalPath());
}

/**
 * Make `nb` the active notebook the agent-facing tools default to (loading it
 * if needed) and return its view. The UI calls this when a notebook tab is
 * focused so the MCP interface follows the human's attention.
 */
export function setActiveNotebook(nb?: string | null): NotebookView {
	const abs = resolveAbs(nb);
	loadDoc(abs);
	activePath = abs;
	return getNotebook(abs);
}

/**
 * Absolute paths of the notebooks this instance currently holds in memory.
 *
 * Deliberately the LIVE documents, not a walk of the workspace: callers use this
 * to report per-notebook settings (which notebooks declare a code root), and
 * answering that from disk would mean parsing every `.ipynb` in the workspace.
 */
export function listOpenNotebookPaths(): string[] {
	return [...docs.keys()].sort();
}

/** Absolute path of the active notebook (defaults to the workspace notebook). */
export function getActiveNotebookPath(): string {
	return activePath || canonicalPath();
}

/**
 * Load `abs` and broadcast `notebook:opened` so an already-open shell surfaces it
 * in a tab with no reload. Shared by `createNotebook` and `openNotebook` so both
 * take the exact same UI path.
 *
 * `focus` controls whether this steals the USER's attention:
 *   - focus:true  (the human's own open/create) — makes it the active notebook
 *     AND the browser focuses its tab.
 *   - focus:false (an agent declaring its working notebook) — the notebook is
 *     surfaced as an AVAILABLE tab, but the global active pointer and the user's
 *     focused tab are left untouched. This is the core of the multi-agent
 *     decoupling: an agent opening its notebook must not yank a user off the tab
 *     they are working in.
 */
function activateAndBroadcast(
	abs: string,
	originId?: string | null,
	{ focus = true }: { focus?: boolean } = {}
): NotebookView {
	if (focus) activePath = abs;
	publish({
		type: 'notebook:opened',
		nb: abs,
		relPath: relative(workspace(), abs),
		name: abs.split(/[/\\]/).pop(),
		focus,
		originId
	});
	return getNotebook(abs);
}

/** True if `nb` resolves to a live doc or an on-disk `.ipynb` in the workspace. */
export function notebookExists(nb?: string | null): boolean {
	const abs = resolveAbs(nb);
	return docs.has(abs) || existsSync(abs);
}

/**
 * Create a new workspace notebook (or open an existing one at that path), make
 * it the active notebook, and broadcast `notebook:opened` so an already-open
 * shell surfaces it in a tab with no reload. `nb` is a workspace-relative path
 * (a `.ipynb` name); if a file already exists there it is opened rather than
 * overwritten (never clobbers a user's notebook). New notebooks seed with one
 * empty code cell so the kernel-attached view is immediately usable.
 *
 * Creating is a genuine "make this notebook exist" action, so it materializes
 * the file on disk — including the default notebook, which may exist only in
 * memory from a bare load (loadDoc no longer persists on open).
 */
export function createNotebook(
	nb: string,
	originId?: string | null,
	opts: { focus?: boolean } = {}
): NotebookView {
	const abs = resolveAbs(nb);
	let doc = docs.get(abs);
	if (!doc) {
		if (existsSync(abs)) {
			doc = loadDoc(abs);
		} else {
			doc = { path: abs, cells: [newCell('code')], metadata: undefined };
			docs.set(abs, doc);
		}
	}
	// Write the file if it isn't on disk yet (fresh create, or a default doc that
	// only existed in memory — loadDoc no longer persists on open). An existing
	// file is left untouched.
	if (!existsSync(abs)) persist(doc);
	return activateAndBroadcast(abs, originId, opts);
}

/**
 * Open an EXISTING workspace notebook, make it active, and broadcast
 * `notebook:opened` (same UI path as `createNotebook`). `nb` is a
 * workspace-relative `.ipynb` path. Throws `notebook not found` when no live
 * doc and no on-disk file exist — opening never creates (use `createNotebook`).
 */
export function openNotebook(
	nb: string,
	originId?: string | null,
	opts: { focus?: boolean } = {}
): NotebookView {
	const abs = resolveAbs(nb);
	if (!docs.has(abs) && !existsSync(abs)) {
		throw new Error('notebook not found: ' + relative(workspace(), abs));
	}
	loadDoc(abs);
	return activateAndBroadcast(abs, originId, opts);
}

/**
 * A sidebar file-management op deleted a workspace path. Drop every live doc at
 * that path (or, when a folder was deleted, any doc nested under it) from the
 * `docs` Map so a later UI/MCP persist can't `writeFileSync`-resurrect a file
 * the user just removed. When the active pointer referenced a dropped doc it is
 * reset to null, so it falls back to the default notebook. A no-op when no live
 * doc matches (non-notebook files, closed notebooks).
 */
export function dropDocs(nb: string): void {
	const abs = resolveAbs(nb);
	const prefix = abs + sep;
	for (const key of [...docs.keys()]) {
		if (key !== abs && !key.startsWith(prefix)) continue;
		docs.delete(key);
		if (activePath === key) activePath = null;
	}
}

/**
 * A sidebar file-management op renamed/moved a workspace path. Rekey every live
 * doc from its old absolute path to the new one (folder renames/moves rekey any
 * nested notebook docs too) so edits keep landing in the live doc and the old
 * path isn't recreated on the next persist. Updates the active pointer when it
 * referenced a rekeyed doc. A no-op when no live doc matches.
 */
export function rekeyDocs(fromNb: string, toNb: string): void {
	const fromAbs = resolveAbs(fromNb);
	const toAbs = resolveAbs(toNb);
	if (fromAbs === toAbs) return;
	const prefix = fromAbs + sep;
	for (const key of [...docs.keys()]) {
		let newKey: string | null = null;
		if (key === fromAbs) newKey = toAbs;
		else if (key.startsWith(prefix)) newKey = toAbs + key.slice(fromAbs.length);
		if (newKey == null) continue;
		const doc = docs.get(key);
		if (!doc) continue;
		docs.delete(key);
		doc.path = newKey;
		docs.set(newKey, doc);
		if (activePath === key) activePath = newKey;
	}
}

/**
 * Resolve a notebook path argument (workspace-relative or absolute, or nullish
 * for the active notebook) to its canonical absolute id — the same key the
 * `docs` Map uses and that `getNotebook().path` reports. Callers publishing live
 * events use this so the `nb` tag matches the id the browser filters on.
 */
export function resolveNotebookPath(nb?: string | null): string {
	return resolveAbs(nb);
}

/**
 * Workspace-relative path for an absolute notebook path — the id the browser
 * uses to address tabs (e.g. the default notebook is `notebook.ipynb`). Inverse
 * of `resolveAbs` for the common in-workspace case.
 */
export function workspaceRelative(abs: string): string {
	return relative(workspace(), abs);
}

function find(doc: NotebookDoc, id: string): Cell | undefined {
	return doc.cells.find((c) => c.id === id);
}

// --- richer read/write surface (used by the MCP agent interface) -----------

/** Full cell views including metadata, in document order. */
export function listCells(nb?: string | null): CellView[] {
	const doc = docFor(nb);
	return doc.cells.map((c) => ({
		id: c.id,
		cell_type: c.cell_type,
		source: c.source,
		outputs: c.outputs ?? [],
		metadata: c.metadata ?? {}
	}));
}

/** A single full cell view (or null). */
export function getCell(id: string, nb?: string | null): CellView | null {
	const doc = docFor(nb);
	const c = find(doc, id);
	if (!c) return null;
	return { id: c.id, cell_type: c.cell_type, source: c.source, outputs: c.outputs ?? [], metadata: c.metadata ?? {} };
}

/**
 * Set the agent-visibility flag in the allowlisted `cellar` namespace, so it
 * round-trips through clean-on-save. Applies to EVERY cell type - the flag is
 * honored in every agent map, read, search, section and result, and a markdown
 * cell's prose is as much a thing to withhold as a code cell's source, so unlike
 * `setCellExport`/`setHideInput` there is no cell-type gate.
 *
 * SHOWING deletes the key rather than storing `false` (the `setCellExports`
 * rule): `isHiddenFromAgent` is strictly `=== true`, so absent and `false` read
 * identically, and storing the default would put a line in the user's committed
 * `.ipynb` for a cell that is in the state every cell starts in. It deletes the
 * key it WROTE - a pre-existing explicit `false` (what `set_cell_visibility(id,
 * false)` stored before this change, or a hand edit) already reads as visible, so
 * the change check below returns early and leaves it exactly as it is, which is
 * inert under that same strictly-`=== true` reading and is self-healed by any
 * hide-then-show round trip. Cleaning it was considered and NOT done: a "show"
 * would then sometimes write and sometimes not, a subtler rule than the change
 * detection it would complicate, for a shape nothing can observe.
 *
 * Only a real CHANGE writes or emits, so re-setting the value a cell already
 * carries costs no `.ipynb` write and no event (zero git diff, no mtime churn) -
 * which is also what keeps an optimistic UI toggle from echoing itself back.
 *
 * The persist is guarded on `jpFormat` like `setCellExports`: a `.py` text
 * notebook carries no cellar cell metadata, so the write would spend a blocking
 * jupytext `spawnSync` producing byte-identical output while silently losing the
 * very flag it was asked to store. The event still fires, so open tabs update
 * either way and the flag holds for the session (the same in-session-only limit
 * every per-cell `cellar` flag has on a `.py` notebook). That branch runs no
 * persist, so it has no failure path and the rollback below cannot apply to it.
 *
 * THE INVARIANT: no path may leave the agent surface MORE PERMISSIVE than what
 * the user is being told. The in-memory doc IS the agent surface - every MCP
 * read/search/section and every chat transcript reads it through `docFor` - so a
 * mutation that lands there before a `persist` that then THROWS (a read-only
 * checkout, ENOSPC, EACCES on the `.ipynb`) has already revoked a concealment
 * while the caller is about to report the write as failed. On a SHOW that is the
 * dangerous direction: the browser reverts the row and says the cell is still
 * hidden while the running app hands it to every agent read. So the write is
 * ROLLED BACK on failure and the error is rethrown, which keeps the caller's
 * existing "it was not saved" copy TRUE rather than needing it reworded.
 *
 * RESTORE-ON-FAILURE rather than persist-first, deliberately: `persist`
 * serializes the LIVE doc and there is no "persist this candidate value" form,
 * so persisting first would mean deep-cloning the whole notebook on every
 * toggle - costly, and a shape no other setter here uses. The rollback puts back
 * the EXACT prior shape, because key-ABSENT and an explicit `false` are
 * different states elsewhere in this flow, and it restores THAT KEY (plus any
 * namespace this call itself created) alone, so a concurrent change to another
 * `cellar` key is not clobbered. The `emit` sits after the persist, so the
 * rethrow reaches the caller before any event is published: a failed write
 * announces nothing, because nothing changed.
 */
export function setVisibility(id: string, hidden: boolean, nb?: string | null, originId?: string | null): boolean {
	const doc = docFor(nb);
	const cell = find(doc, id);
	if (!cell) return false;
	if (isHiddenFromAgent(cell) === !!hidden) return true;
	const hadMetadata = !!cell.metadata;
	const hadCellar = !!cell.metadata?.cellar;
	const hadKey = !!cell.metadata?.cellar && 'hidden_from_agent' in cell.metadata.cellar;
	const was = cell.metadata?.cellar?.hidden_from_agent;
	if (hidden) {
		cell.metadata = cell.metadata ?? {};
		cell.metadata.cellar = cell.metadata.cellar ?? {};
		cell.metadata.cellar.hidden_from_agent = true;
	} else {
		delete cell.metadata?.cellar?.hidden_from_agent;
	}
	try {
		if (!doc.jpFormat) persist(doc);
	} catch (err) {
		if (hadKey) {
			cell.metadata = cell.metadata ?? {};
			cell.metadata.cellar = cell.metadata.cellar ?? {};
			cell.metadata.cellar.hidden_from_agent = was;
		} else {
			delete cell.metadata?.cellar?.hidden_from_agent;
			if (!hadCellar) delete cell.metadata?.cellar;
			if (!hadMetadata) delete cell.metadata;
		}
		throw err;
	}
	emit(doc, 'cell:visibility', { cellId: id, hidden: !!hidden }, originId);
	return true;
}

/**
 * Persist a cell's "scroll outputs" choice in the allowlisted `cellar`
 * namespace so it round-trips through clean-on-save. `null`/`undefined` clears
 * the explicit choice (falls back to the UI's auto height heuristic).
 */
export function setOutputScrolled(id: string, scrolled: boolean | null | undefined, nb?: string | null): boolean {
	const doc = docFor(nb);
	const cell = find(doc, id);
	if (!cell) return false;
	cell.metadata = cell.metadata ?? {};
	cell.metadata.cellar = cell.metadata.cellar ?? {};
	if (scrolled === null || scrolled === undefined) delete cell.metadata.cellar.output_scrolled;
	else cell.metadata.cellar.output_scrolled = !!scrolled;
	persist(doc);
	return true;
}

/**
 * Persist a code cell's "hide code input" choice in the allowlisted `cellar`
 * namespace so it round-trips through clean-on-save. Tri-state:
 * `null`/`undefined` clears the explicit choice (the cell then follows the
 * notebook-wide `hide_all_code` default). Only a code cell can carry it (a
 * markdown cell has no code to hide). Display only: the source is untouched and
 * the cell still runs, so the `.ipynb` stays git-clean apart from the flag.
 */
export function setHideInput(
	id: string,
	hidden: boolean | null | undefined,
	nb?: string | null,
	originId?: string | null
): boolean {
	const doc = docFor(nb);
	const cell = find(doc, id);
	if (!cell || cell.cell_type !== 'code') return false;
	cell.metadata = cell.metadata ?? {};
	cell.metadata.cellar = cell.metadata.cellar ?? {};
	if (hidden === null || hidden === undefined) delete cell.metadata.cellar.hide_input;
	else cell.metadata.cellar.hide_input = !!hidden;
	persist(doc);
	emit(doc, 'cell:hide-input', { cellId: id, hidden: hidden ?? null }, originId);
	return true;
}

/**
 * Stamp runtime-only run metadata on a cell in the allowlisted `cellar`
 * namespace: `lastRun = { at, durationMs, actor, status, session }`.
 * Both run entry points (the UI `/run` route → `actor:'user'`, the MCP run tools
 * → `actor:'agent'`) call this so the badge in `Cell.svelte` shows who last ran
 * the cell, when, and how long it took.
 *
 * `session` is the kernel-session epoch the run STARTED in (see kernel.js). It
 * is the only record of whether a cell executed against the namespace that is
 * live right now: a cell's saved `outputs` survive kernel restarts and process
 * restarts, so outputs alone can never answer that. The MCP layer compares it
 * with `currentSessionId()` to report `ran_this_session` — never infer "ran"
 * from `outputs.length`.
 *
 * NOT persisted: `at`/`durationMs` change every run, so writing them would make
 * the `.ipynb` byte-different on each run (a git diff), violating Cellar's
 * zero-diff-on-re-run rule. It lives only in the in-memory doc and is surfaced
 * to the browser via `cellView` (load/refetch) + the `run:end` SSE event, and
 * `clean.js` strips it before any disk write (report §4.2). Cleared on a server
 * restart; a kernel restart leaves it in place but bumps the epoch, so the stamp
 * then correctly reads as "did not run this session".
 */
export function setLastRun(id: string, lastRun: LastRun, nb?: string | null): boolean {
	const doc = docFor(nb);
	const cell = find(doc, id);
	if (!cell) return false;
	cell.metadata = cell.metadata ?? {};
	cell.metadata.cellar = cell.metadata.cellar ?? {};
	cell.metadata.cellar.lastRun = lastRun;
	return true;
}

/**
 * Invalidate the runtime-only run stamp of specific cells after a namespace
 * "wipe variables" (see kernel.ts `wipeKernelVariables`). Clearing `lastRun` makes
 * a cell read "not run this session", so the existing staleness rule reports it
 * `not_run` and its downstream dependents `stale` — reflecting that the values it
 * defined are gone from the kernel — WITHOUT any epoch bump or restart. `lastRun`
 * is runtime-only (stripped from disk), so this never changes the `.ipynb`.
 *
 * Only `lastRun` is cleared: the cell's `importBindings` baseline stays, because it
 * records what the SOURCE binds, not what the namespace holds. That is also why
 * `pruneImportBindings` is dated against the DOCUMENT's newest run (`latestConsumeAt`)
 * rather than the providing cell's own stamp - a wipe here would otherwise read as
 * "this cell never bound anything" and drop its removal records (see
 * `importBindings.ts`).
 *
 * The caller resolves which cells defined the wiped names (see dataflow.ts
 * `cellsDefiningNames`); passing an empty list is a no-op. Emits one
 * `kernel:variables-wiped` event so every open tab refetches its staleness.
 * Returns how many cells were actually cleared.
 */
export function clearLastRunStamps(cellIds: readonly string[], nb?: string | null): number {
	const doc = docFor(nb);
	let cleared = 0;
	for (const id of cellIds) {
		const cell = find(doc, id);
		const lr = cell?.metadata?.cellar?.lastRun;
		if (lr) {
			delete cell!.metadata!.cellar!.lastRun;
			cleared++;
		}
	}
	emit(doc, 'kernel:variables-wiped', { cleared });
	return cleared;
}

/** The notebook's designated imports cell, or null. */
export function getImportsCell(nb?: string | null): CellView | null {
	const doc = docFor(nb);
	const cell = doc.cells.find(isImportsCell);
	return cell ? cellView(cell) : null;
}

/**
 * Designate (or un-designate) a cell as the notebook's imports cell, in the
 * allowlisted `cellar` namespace so it round-trips through clean-on-save. Only
 * one cell may hold the role, so designating a cell strips it from any other.
 */
export function setCellRole(id: string, role: string | null, nb?: string | null, originId?: string | null): boolean {
	const doc = docFor(nb);
	const cell = find(doc, id);
	if (!cell) return false;
	for (const c of doc.cells) {
		if (c !== cell && c.metadata?.cellar?.role) {
			delete c.metadata.cellar.role;
			emit(doc, 'cell:role', { cellId: c.id, role: null }, originId);
		}
	}
	cell.metadata = cell.metadata ?? {};
	cell.metadata.cellar = cell.metadata.cellar ?? {};
	if (role) cell.metadata.cellar.role = role;
	else delete cell.metadata.cellar.role;
	persist(doc);
	emit(doc, 'cell:role', { cellId: id, role: role ?? null }, originId);
	return true;
}

/**
 * Mark (or unmark) a code cell for nbdev-style export in the allowlisted `cellar`
 * namespace, so the flag round-trips through clean-on-save. Only a code cell can
 * carry it (a markdown/SQL cell has no module source). `persist` regenerates the
 * `.py` module as a side effect (auto-on-save).
 *
 * This IS `setCellExports` of one - one implementation, one rule - so the UI's
 * per-cell toggle and MCP's batch tool cannot drift about what marking means.
 * Returns whether the cell now carries the requested value (false = there is no
 * such cell, or marking a non-Python one, which `isExportCell` would ignore).
 */
export function setCellExport(id: string, exported: boolean, nb?: string | null, originId?: string | null): boolean {
	const doc = docFor(nb);
	const cell = find(doc, id);
	if (!cell) return false;
	if (exported && !canExportCell(cell)) return false;
	setCellExports([id], exported, nb, originId);
	return true;
}

/**
 * Mark (or unmark) SEVERAL cells for export in one document write - the batch
 * `setCellExport`, mirroring `setCellTypes`/`clearOutputsForCells`. A loop over
 * the single-cell form would serialize + fsync + rename the whole `.ipynb` once
 * per cell AND regenerate the `.py` module once per cell (`persist` auto-exports),
 * walking both files through every intermediate state.
 *
 * Only cells that actually CHANGE are touched, so a re-mark of an
 * already-marked cell writes nothing and emits nothing (zero git diff, no `.py`
 * mtime churn). Marking requires a PYTHON code cell (`canExportCell`, the shared
 * eligibility half of `isExportCell` itself - a markdown or SQL cell has no module
 * source, so setting the flag there would be a lie the exporter ignores) while
 * UNMARKING clears the flag wherever
 * it is found, which is also how a stale flag on a hand-edited `.ipynb` is
 * cleared. Returns the ids actually changed.
 *
 * The persist is guarded on `jpFormat` like `clearOutputsForCells`: a `.py` text
 * notebook carries no cellar cell metadata, so the write would spend a blocking
 * jupytext `spawnSync` producing byte-identical output while silently losing the
 * very flag it was asked to store (and `autoExportPy` skips it anyway). The
 * events still fire unconditionally, so open tabs update either way.
 */
export function setCellExports(
	ids: readonly string[],
	exported: boolean,
	nb?: string | null,
	originId?: string | null
): string[] {
	const doc = docFor(nb);
	const changed: Cell[] = [];
	const seen = new Set<string>();
	for (const id of ids) {
		if (seen.has(id)) continue;
		seen.add(id);
		const cell = find(doc, id);
		if (!cell) continue;
		const marked = cell.metadata?.cellar?.export === true;
		if (exported) {
			if (!canExportCell(cell) || marked) continue;
			cell.metadata = cell.metadata ?? {};
			cell.metadata.cellar = cell.metadata.cellar ?? {};
			cell.metadata.cellar.export = true;
		} else {
			const cellar = cell.metadata?.cellar;
			if (!cellar || !marked) continue;
			delete cellar.export;
		}
		changed.push(cell);
	}
	if (!changed.length) return [];
	if (!doc.jpFormat) persist(doc);
	for (const cell of changed) emit(doc, 'cell:export', { cellId: cell.id, exported }, originId);
	return changed.map((c) => c.id);
}

/**
 * Is this notebook a `.py` TEXT notebook (jupytext percent/light, or Databricks
 * source) rather than an `.ipynb`? Such a document carries NO cellar cell
 * metadata and generates no module (`persist` writes it through jupytext,
 * `autoExportPy` skips it), so every export-flow caller has to refuse rather
 * than claim a mark it cannot store - `exportPy` already throws on it.
 */
export function isPyTextNotebook(nb?: string | null): boolean {
	return !!docFor(nb).jpFormat;
}

/** The notebook's configured export target (`.py` module path), or null. */
export function getExportTarget(nb?: string | null): string | null {
	const doc = docFor(nb);
	const t = doc.metadata?.cellar?.export_target;
	return typeof t === 'string' && t.trim() ? t.trim() : null;
}

/**
 * The target the EXPORTER will actually write to, resolved through its base:
 * the notebook-level `export_target` + `export_base`, or - when there is none -
 * a `#|default_exp <module>` directive in any code cell (nbdev's own spelling,
 * always workspace-relative). This is `resolveExportTarget`'s rule REUSED,
 * never a second copy, so a caller reporting where the marks land can never
 * disagree with where they go. Null when nothing is configured - a configured
 * target that cannot RESOLVE is its own `ok:false` shape, kept distinct so it
 * is never read as "no target" (see `ResolvedExportTarget`).
 *
 * `getExportTarget` above stays the metadata-only reader (what `setExportTarget`
 * stores and clears); the two are deliberately separate, because a directive
 * lives in a cell and no notebook-level setter can clear it.
 */
export function exportTargetInfo(nb?: string | null): ResolvedExportTarget | null {
	return resolveExportTarget(docFor(nb));
}

/**
 * The path itself was REFUSED - it escapes the workspace, or does not name a `.py`
 * module. Typed (the `CellRefError` precedent) because `setExportTarget` validates
 * BEFORE it mutates, so its only other throw is the `persist`: a disk failure over
 * a path that is perfectly valid and that the live document has already taken.
 * Reported as a refusal, that sends the caller to fix a path that was never wrong,
 * over a change that DID take - so the two are told apart by TYPE here rather than
 * by matching the message text at the catch.
 */
export class InvalidExportTargetError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidExportTargetError';
	}
}

/**
 * Set (or clear, with null/'') the notebook-level export target in the
 * allowlisted `cellar` namespace, so it round-trips through clean-on-save.
 * Materializes `doc.metadata` if the notebook had none yet. `persist` regenerates
 * the `.py` module as a side effect (auto-on-save).
 *
 * The path is VALIDATED here, through the same `resolveInWorkspace` the exporter
 * writes with, and a target that escapes the workspace THROWS rather than being
 * stored: `autoExportPy` is deliberately best-effort (a bad target must not cost
 * the user their notebook save), so an unwritable target accepted here would sit
 * in the metadata silently generating nothing on every later save. Refusing it at
 * the point it is set is the honest moment - the caller has a value to correct.
 *
 * A target that is not a `.py` file is refused for a sharper reason: the exporter
 * WRITES the generated module to this path, so a target naming an ordinary source
 * file would have that file overwritten the moment a cell is marked. The field is
 * documented (here, in both tool descriptions and in nbdev itself) as the module
 * path, so this rejects nothing legitimate. `exportNotebookToPy` carries the
 * second half of that guard - it refuses to overwrite a file it did not generate -
 * because a `#|default_exp` directive reaches it without passing here.
 *
 * What is STORED is the form RELATIVE TO THE CHOSEN BASE, whatever was passed:
 * this value lands in the committed `.ipynb`, and each base's resolution accepts
 * an absolute path that happens to resolve inside THIS workspace - so an
 * absolute target stored verbatim contradicted every description of the field
 * and, on any other checkout, threw from `autoExportPy` (best-effort, so the
 * record is silent) and the module simply never regenerated again for that
 * clone. Normalizing here - the one place the target is validated and stored,
 * so every caller gets it - keeps the notebook portable. An absolute path
 * OUTSIDE the workspace is still refused by `resolveInWorkspace`, unchanged.
 *
 * THE BASE (`$lib/exportTarget`): OMITTING it KEEPS the base the document
 * already stores, so a caller echoing a path back without repeating the base
 * can never silently re-anchor it - which would delete `export_base` from the
 * committed `.ipynb` and relocate the generated module, leaving the old file
 * behind. Only an EXPLICIT value changes the base, `workspace` included. The
 * legacy shape is untouched by that: a pre-base notebook stores no key, so an
 * omitted base inherits `workspace` and nothing is minted. `workspace` is never
 * persisted - the `export_base` key is DELETED for it, because ABSENCE of the
 * key is what a pre-base notebook stores and must permanently mean
 * workspace-relative; writing an explicit `workspace` would mint a second
 * spelling of the legacy state and churn files that never asked. `notebook`
 * stores the path relative to the notebook's own folder; `git` relative to the
 * notebook's enclosing repository (`gitRootOf` - the NOTEBOOK's repo, found by
 * walking up from its directory; deliberately not the code root, which may be
 * an external worktree and governs the kernel, not this file). A base changes
 * how the path is EXPRESSED, never what may be written: every base's resolution
 * runs through the SAME `resolveInWorkspace` guard, so a notebook-relative or
 * git-root-relative path is no escape hatch - a `git` root ABOVE the workspace
 * (`cd repo/analysis && cellar`) is fine exactly as far as the resolved module
 * still lands inside the workspace. A notebook with no enclosing repository
 * refuses the `git` base by name (first-class state, not an exception), and an
 * unknown base value is refused rather than silently read as workspace -
 * INHERITED as much as explicit, so an omitted base cannot smuggle an unknown
 * stored one past the check and rebuild the unrepairable trap below.
 *
 * CLEARING (null/'') is exempt from all of that and deletes BOTH keys whatever
 * the base says, because it can only remove state, never strand it (the
 * `setNotebookRoot` rule). It is therefore the universal repair for a document
 * that cannot resolve at all - an unknown hand-edited base, or a `git` base
 * whose repository has gone - and every refusal above names it.
 *
 * It RETURNS the stored state (`exportTargetState` - target, base, and the
 * resolution the exporter would use), not what it was handed, so a caller
 * reports what the document holds: normalizing without reporting it left the UI
 * route answering with the raw absolute path, which the tab then recorded as
 * its baseline and kept in the input while the server held the relative form -
 * and the `notebook:export-target` event that would have corrected it is
 * echo-suppressed in the initiating tab.
 *
 * Every REFUSAL of the path itself is thrown as an `InvalidExportTargetError`,
 * so a caller can tell it apart from the one other throw this function has - the
 * `persist` below, i.e. a disk failure over a path that was never wrong. See that
 * class for why the distinction is load-bearing.
 */
export function setExportTarget(
	target: string | null,
	nb?: string | null,
	originId?: string | null,
	base?: string | null
): ExportTargetState {
	const doc = docFor(nb);
	const raw = (target ?? '').trim();
	const wanted = (base ?? '').trim() || readExportBase(doc);
	let stored = '';
	// The base is checked only where a target is really STORED under it: a clear
	// stores none, and must stay possible whatever the document says the base is.
	if (raw) {
		if (!isExportBase(wanted))
			throw new InvalidExportTargetError(
				`unknown export base ${JSON.stringify(wanted)}: expected "workspace", "notebook" or "git" - clear the export target to reset the base, then set the path again`
			);
		if (!/\.py$/i.test(raw))
			throw new InvalidExportTargetError(
				`export target ${raw} is not a .py file: the generated module is written to this path, so it must name a .py module`
			);
		const baseDir = exportBaseDir(doc, wanted); // refuses `git` with no repository
		let abs: string;
		try {
			// `resolve` keeps an absolute input absolute, so pasting one still works;
			// the SAME containment guard then decides, whatever the base.
			abs = resolveInWorkspace(resolve(baseDir, raw));
		} catch (err) {
			throw new InvalidExportTargetError(
				wanted === 'workspace'
					? String((err as Error)?.message ?? err)
					: `export target ${raw} (relative to the ${wanted === 'git' ? "notebook's git root" : "notebook's folder"}) resolves outside the workspace - the module can only be written inside the workspace`
			);
		}
		stored = relative(baseDir, abs).split(sep).join('/');
	}
	doc.metadata = doc.metadata ?? {};
	doc.metadata.cellar = doc.metadata.cellar ?? {};
	if (stored) doc.metadata.cellar.export_target = stored;
	else delete doc.metadata.cellar.export_target;
	// The base is a fact ABOUT a stored target: cleared with it, and never stored
	// as an explicit `workspace` (absence is the one spelling of the default).
	if (stored && wanted !== 'workspace') doc.metadata.cellar.export_base = wanted;
	else delete doc.metadata.cellar.export_base;
	persist(doc);
	const state = exportTargetState(doc);
	emit(doc, 'notebook:export-target', { ...state }, originId);
	return state;
}

/** What a set-target/set-base caller reports back: the stored form + its resolution. */
export interface ExportTargetState {
	/** The stored `export_target` (relative to `base`), or null when unset. */
	target: string | null;
	/** The recorded base (`workspace` for the absent-key legacy default). */
	base: string;
	/** Workspace-relative resolution of the EFFECTIVE target, or null. */
	resolved: string | null;
	/** Why a configured target cannot resolve, else null. */
	resolveError: string | null;
}

/**
 * The stored state for a notebook BY PATH - the one rule every reply describes a
 * document by, so the refusal path and the success path can never answer with
 * two different readings of one document (the UI route's 400 is the only thing
 * that can correct the tab's field and select, so a second copy there would put
 * them back to a base the setter does not agree with).
 */
export function getExportTargetState(nb?: string | null): ExportTargetState {
	return exportTargetState(docFor(nb));
}

function exportTargetState(doc: NotebookDoc): ExportTargetState {
	const t = doc.metadata?.cellar?.export_target;
	const info = resolveExportTarget(doc);
	return {
		target: typeof t === 'string' && t.trim() ? t.trim() : null,
		base: readExportBase(doc),
		resolved: info && info.ok ? info.target : null,
		resolveError: info && !info.ok ? info.error : null
	};
}

/**
 * The directory a base measures from, for this doc. Throws the same typed
 * refusal as the path checks for a `git` base with no enclosing repository, so
 * every caller (the setter above, the re-expression below) refuses identically.
 */
function exportBaseDir(doc: NotebookDoc, base: ExportBase): string {
	if (base === 'notebook') return dirname(doc.path);
	if (base === 'git') {
		const root = gitRootOf(dirname(doc.path));
		if (!root)
			throw new InvalidExportTargetError(
				'this notebook is not inside a git repository, so a git-root-relative export target cannot resolve - clear the export target and set the path again under another base, or initialize a repository'
			);
		return root;
	}
	return resolve(workspace());
}

/**
 * RE-EXPRESS the stored export target under a different base: the SAME file,
 * a new spelling. This is what the export section's base select does - picking
 * a base is a statement about how the path reads, so reinterpreting the typed
 * text against the new base (silently retargeting a different file) would be
 * the one thing a base switch must never do. The current stored target is
 * resolved to its absolute file (refusing when it cannot resolve - a file we
 * cannot locate cannot be re-expressed; clear the target and set the path again
 * under the new base, which is the repair every refusal here names) and stored
 * relative to the new base, through the same containment guard as the setter.
 *
 * With NO stored target there is nothing to re-express and nothing to persist:
 * a base alone is meaningless (`export_base` is a fact about a stored target),
 * so the call is an honest no-op reporting the current state - the UI keeps a
 * pre-target base choice client-side and sends it with the first path commit.
 * A no-op also covers re-picking the current base. Refusals are typed
 * (`InvalidExportTargetError`) exactly like the setter's, and the same
 * `persist`-throw distinction applies.
 */
export function setExportBase(base: string, nb?: string | null, originId?: string | null): ExportTargetState {
	const doc = docFor(nb);
	const wanted = (base ?? '').trim();
	if (!isExportBase(wanted))
		throw new InvalidExportTargetError(
			`unknown export base ${JSON.stringify(wanted)}: expected "workspace", "notebook" or "git"`
		);
	const t = doc.metadata?.cellar?.export_target;
	if (!(typeof t === 'string' && t.trim())) return exportTargetState(doc);
	if (wanted === readExportBase(doc)) return exportTargetState(doc);
	const info = resolveExportTarget(doc);
	if (!info || !info.ok || info.source !== 'metadata')
		throw new InvalidExportTargetError(
			`the current export target cannot be re-expressed: ${info && !info.ok ? info.error : 'no stored target resolves'} - clear the export target, then set the path again under the new base`
		);
	const baseDir = exportBaseDir(doc, wanted); // refuses `git` with no repository
	doc.metadata = doc.metadata ?? {};
	doc.metadata.cellar = doc.metadata.cellar ?? {};
	doc.metadata.cellar.export_target = relative(baseDir, info.abs).split(sep).join('/');
	if (wanted !== 'workspace') doc.metadata.cellar.export_base = wanted;
	else delete doc.metadata.cellar.export_base;
	persist(doc);
	const state = exportTargetState(doc);
	emit(doc, 'notebook:export-target', { ...state }, originId);
	return state;
}

/** The notebook's enabled heading-numbering levels (unique, 1-6, ascending). */
export function getHeaderNumbering(nb?: string | null): number[] {
	return readHeaderNumbering(docFor(nb));
}

/**
 * Set the heading levels (1-6) rendered with a display-only auto-number, in the
 * allowlisted `cellar` namespace so it round-trips through clean-on-save. The
 * numbers themselves are computed at render time and never written to any cell's
 * markdown source - this only persists *which levels* are numbered. An empty list
 * clears the setting.
 */
export function setHeaderNumbering(
	levels: readonly number[] | null | undefined,
	nb?: string | null,
	originId?: string | null
): number[] {
	const doc = docFor(nb);
	doc.metadata = doc.metadata ?? {};
	doc.metadata.cellar = doc.metadata.cellar ?? {};
	const clean = [
		...new Set((levels ?? []).filter((l) => Number.isInteger(l) && l >= 1 && l <= 6))
	].sort((a, b) => a - b);
	if (clean.length) doc.metadata.cellar.header_numbering = clean;
	else delete doc.metadata.cellar.header_numbering;
	persist(doc);
	emit(doc, 'notebook:header-numbering', { levels: clean }, originId);
	return clean;
}

/**
 * The notebook's declared code root — the workspace-relative directory its
 * KERNEL resolves code from (cwd + `sys.path`), or null for the workspace (the
 * default, and today's behavior). Normalized on read as well as on write, so a
 * hand-edited or externally-authored `.ipynb` carrying `"./roots/x/"` reads as
 * the same root the UI would have written; a value that is not a
 * workspace-relative path at all reads as its raw trimmed self, so the resolver
 * refuses it by name rather than this getter silently answering "no root" (which
 * would run the notebook against the workspace it explicitly declined).
 */
export function getNotebookRoot(nb?: string | null): string | null {
	return readRoot(docFor(nb));
}

/**
 * True when the notebook is a `.py` TEXT notebook (jupytext percent/light or
 * Databricks source), i.e. one written back from its cells alone and therefore
 * carrying no notebook-level metadata on disk. Anything that would persist a
 * notebook-level setting must consult this first — see `setNotebookRoot`.
 */
export function isTextNotebook(nb?: string | null): boolean {
	return !!docFor(nb).jpFormat;
}

/**
 * Set (or clear, with null/'') the notebook's code root in the allowlisted
 * `cellar` namespace, so it round-trips through clean-on-save with zero git diff
 * like the rest of the namespace. The declared value is NORMALIZED before it is
 * persisted (idempotent, so re-saving never churns the file); `~` is the one shape
 * refused here, since Cellar never expands it.
 *
 * IT DOES NOT DECIDE WHAT A ROOT MAY BE, and a caller must not read it as though
 * it did. A declaration may now name a directory outside the workspace (a
 * registered git worktree of this repo), so admission — including the canonical
 * `..`-relative form this then persists — belongs to the ONE validate-and-store
 * site, `server/notebookRoot.ts`'s `resolveRootDir`, which is what every surface
 * goes through via `notebook-root-actions.ts`. This writer records text.
 *
 * A `.py` text notebook REFUSES a non-empty root here, because `persist` writes
 * it back from its cells alone and would drop the declaration — see
 * `textNotebookRootError`. THAT guard does live at this single writer so no
 * surface can route around it; clearing stays allowed everywhere.
 *
 * This function only records the declaration. Because a kernel's cwd is fixed
 * when its process spawns, a root that CHANGES also has to free that notebook's
 * kernel — see `notebook-root-actions.ts`, which is the one place that pairs the
 * two (the REST route and the MCP tool both go through it).
 */
export function setNotebookRoot(root: string | null | undefined, nb?: string | null, originId?: string | null): string | null {
	const normalized = normalizeRootPath(root);
	const doc = docFor(nb);
	if (normalized && doc.jpFormat) throw textNotebookRootError(normalized);
	doc.metadata = doc.metadata ?? {};
	doc.metadata.cellar = doc.metadata.cellar ?? {};
	if (normalized) doc.metadata.cellar.root = normalized;
	else delete doc.metadata.cellar.root;
	persist(doc);
	emit(doc, 'notebook:root', { root: normalized }, originId);
	return normalized;
}

/** Whether the notebook-wide "hide all code inputs" (report view) default is on. */
export function getHideAllCode(nb?: string | null): boolean {
	return !!docFor(nb).metadata?.cellar?.hide_all_code;
}

/**
 * Set the notebook-wide "hide all code inputs" default in the allowlisted
 * `cellar` namespace so it round-trips through clean-on-save. This is the
 * default for cells with no explicit per-cell `cellar.hide_input`; a per-cell
 * choice always wins. Display only - no cell source is touched.
 */
export function setHideAllCode(hidden: boolean, nb?: string | null, originId?: string | null): boolean {
	const doc = docFor(nb);
	doc.metadata = doc.metadata ?? {};
	doc.metadata.cellar = doc.metadata.cellar ?? {};
	if (hidden) doc.metadata.cellar.hide_all_code = true;
	else delete doc.metadata.cellar.hide_all_code;
	persist(doc);
	emit(doc, 'notebook:hide-all-code', { hidden: !!hidden }, originId);
	return !!hidden;
}

/**
 * Regenerate the `.py` module on demand (the manual "Export to .py" action).
 * Unlike the auto-on-save path, this surfaces a real error (bad target) to the
 * caller rather than swallowing it.
 *
 * It REFRESHES `lastExportError` in BOTH directions, exactly as `autoExportPy`
 * does on every persist: the record describes what is on disk, and this path
 * writes the module without going through `persist`. A stale success would be
 * reported by the next idempotent `set_cell_export` (which skips the persist that
 * would have cleared it); a failure left unrecorded is worse - with the record
 * null the same call emits no `module` field at all, which under the conditional
 * contract reads as a module that WAS regenerated.
 */
export function exportPy(nb?: string | null): ExportResult {
	const doc = docFor(nb);
	if (doc.jpFormat) throw new Error('cannot export a .py text notebook to a module');
	try {
		const res = exportNotebookToPy(doc);
		doc.lastExportError = null;
		return res;
	} catch (err) {
		doc.lastExportError = String((err as Error)?.message ?? err);
		throw err;
	} finally {
		// This path writes the module WITHOUT going through `persist`, so it owes the
		// same broadcast - in a `finally`, because a throw here still leaves the marks
		// (and therefore the hazards) exactly as this call found them, and a bar left
		// describing an older set is the staleness the push exists to remove.
		publishExportHazards(doc);
	}
}

/**
 * The compile hazards the marks of this notebook currently describe
 * (`$lib/exportHazard`), for callers outside the browser view - the agent surface
 * reads it to report a module it regenerated but that will not import.
 *
 * Computed FRESH, deliberately, rather than read back from the last export: the
 * agent tools' own `module` field is already careful to say what is TRUE OF DISK
 * rather than what this call caused, and a fresh read cannot go stale on a doc
 * whose idempotent call skipped the persist.
 */
export function exportHazardsFor(nb?: string | null): ExportHazard[] {
	return docExportHazards(docFor(nb));
}

/**
 * Insert a cell at an absolute index. `addCell` can only insert AFTER a known id,
 * which cannot express "at the very top" — the one position the imports cell must
 * occupy. The `cell:added` event therefore carries an explicit `index` so the
 * browser inserts where the server did rather than appending.
 */
export function addCellAt(
	index: number,
	cellType: LogicalCellType = 'code',
	nb?: string | null,
	originId?: string | null,
	source = '',
	role?: string | null
): Cell {
	const doc = docFor(nb);
	assertCanHoldType(doc, cellType);
	const cell = newCell(cellType, source);
	if (role) cell.metadata.cellar.role = role;
	assertCanHoldCell(doc, cell);
	const at = Math.max(0, Math.min(index, doc.cells.length));
	doc.cells.splice(at, 0, cell);
	persist(doc);
	emit(doc, 'cell:added', { cell: cellView(cell), afterId: doc.cells[at - 1]?.id ?? null, index: at }, originId);
	return cell;
}

/**
 * Move a cell to an absolute index (clamped). `index` addresses the array with
 * the moved cell already removed.
 *
 * `clampMoveIndex` is the shared move-index rule the browser applies
 * optimistically too, so the two never disagree about where a dragged cell
 * landed. It is currently the identity (the imports cell is no longer pinned).
 */
export function moveCellTo(id: string, index: number, nb?: string | null, originId?: string | null): boolean {
	const doc = docFor(nb);
	const from = doc.cells.findIndex((c) => c.id === id);
	if (from < 0) return false;
	const allowed = clampMoveIndex(doc.cells, from, index);
	if (allowed < 0) return false;
	const [cell] = doc.cells.splice(from, 1);
	const to = Math.max(0, Math.min(allowed, doc.cells.length));
	doc.cells.splice(to, 0, cell);
	persist(doc);
	emit(doc, 'cell:moved', { cellId: id, toIndex: to }, originId);
	return true;
}

/**
 * The DURABLE `cellar` keys a restore may seed - every declared key of
 * `CellarNamespace` that is not runtime-only. An allowlist, so an unknown key a
 * caller invents is dropped rather than written into the user's document.
 */
const DURABLE_CELLAR_KEYS = [
	'language',
	'role',
	'export',
	'hide_input',
	'output_scrolled',
	'hidden_from_agent',
	'extract',
	'visible'
] as const satisfies readonly (keyof CellarNamespace)[];

/**
 * Seed a newly created cell with `cellar` metadata a caller is RESTORING - the
 * undo stack re-inserting a deleted cell, which has to bring it back EXACTLY
 * (`language`, so a SQL cell does not come back as Python; `role`, `export`,
 * `hide_input`, `output_scrolled`, `hidden_from_agent`), and a paste carrying its
 * view choice. Seeding at creation is what keeps that ONE persist and ONE
 * `cell:added` event, rather than an add followed by a PATCH per key.
 *
 * The RUNTIME-only records are stripped first, through the same `stripRuntimeMeta`
 * the disk write uses, so this can never become a forgery route: `lastRun` is the
 * sole evidence a cell ran against the LIVE kernel namespace and may only ever
 * originate from an in-process run, and `importBindings` was just recomputed by
 * `newCell` for the source this cell is born with.
 */
function seedCellar(doc: NotebookDoc, cell: CellWithCellar, cellar: unknown): void {
	if (!cellar || typeof cellar !== 'object' || Array.isArray(cellar)) return;
	const durable = stripRuntimeMeta({ cellar: cellar as CellarNamespace }).cellar;
	if (!durable) return;
	// Copy only the ENUMERATED durable keys, never the object the client sent: the
	// `cellar` namespace survives clean-on-save WHOLE, so assigning it wholesale
	// would make this route a path from arbitrary request JSON into the user's
	// persisted `.ipynb`. The runtime strip above still runs, so a key that ever
	// moves between the two lists cannot slip through on this path either.
	const seed = durable as Record<string, unknown>;
	const target = cell.metadata.cellar as Record<string, unknown>;
	for (const key of DURABLE_CELLAR_KEYS) {
		if (seed[key] !== undefined) target[key] = seed[key];
	}
	// The imports role is ONE PER NOTEBOOK (`setCellRole` enforces it by stripping
	// any other), and this path writes the namespace directly, so it has to hold the
	// same line: a cell deleted while it held the role, re-designated elsewhere, and
	// then restored would otherwise leave two - and every future routed import would
	// go to whichever came first.
	if (cell.metadata.cellar.role === IMPORTS_ROLE && doc.cells.some((c) => isImportsCell(c))) {
		delete cell.metadata.cellar.role;
	}
}

/**
 * Refuse a type a `.py` TEXT notebook cannot hold (`PY_UNSUPPORTED_TYPES`:
 * `raw`, `chat`, `mojo`), BEFORE anything is written.
 *
 * `persist` writes such a document back through jupytext / the Databricks
 * converter, which rebuilds it from its cells and coerces every `cell_type` to
 * markdown|code, carrying no `cellar` metadata and no outputs - so a raw cell
 * would live only in memory and come back from disk as a runnable Python cell,
 * a chat cell would come back the same way with its REPLY gone, and a mojo cell
 * would come back as a Python cell holding Mojo source (see
 * `textNotebookCellTypeError`, which owns the reasoning and the messages). The
 * guard sits at EVERY doc-layer writer that can put such a type into a document
 * - the two that CONVERT a cell (`setCellType`, `setCellTypes`) and the two that
 * CREATE one (`addCell`, `addCellAt`) - so every surface offering one (the type
 * menu, the `r` chord, the bulk route, MCP `set_cell_type` / `add_cell` /
 * `add_cells` / `add_and_run`) is covered by this ONE rule rather than by a
 * check each of them could forget. `addCellAt`'s only caller passes 'code'
 * today, so it is guarded to make the claim true by construction rather than by
 * that caller's argument. Which types are refused lives in `cellLanguage.ts`, so
 * a seventh logical type is decided there once instead of here per writer. Every
 * other type is unaffected, and an `.ipynb` never reaches the throw.
 *
 * The CREATE paths ask it through `assertCanHoldCell` as well, about the cell
 * they built rather than the type they were asked for - see below.
 */
function assertCanHoldType(doc: NotebookDoc, cellType: LogicalCellType): void {
	if (doc.jpFormat && isPyUnsupportedType(cellType)) throw textNotebookCellTypeError(cellType);
}

/**
 * The same refusal asked of a BUILT cell rather than of a requested type - what
 * every CREATE path ends with, because the requested type is not the only thing
 * that decides what a new cell IS.
 *
 * A logical type can be carried by the `cellar` namespace (`chat` and `sql` are
 * tagged code cells), and `addCell` takes such a namespace from its caller and
 * seeds it (`seedCellar`, whose `DURABLE_CELLAR_KEYS` includes `language`). So
 * `cellType:'code'` plus `cellar:{language:'chat'}` passed the type guard and
 * still produced a chat cell - on a `.py` document, exactly the state the guard
 * refuses. Asking the cell itself closes that by construction: a caller-supplied
 * namespace can never produce a cell state the `cellType` argument would have
 * been refused for, and a seventh logical type carried the same way inherits the
 * rule instead of needing a check of its own (`mojo` landed under it with no
 * edit). Called before the cell is spliced in, so a refusal still writes nothing.
 */
function assertCanHoldCell(doc: NotebookDoc, cell: Cell): void {
	assertCanHoldType(doc, logicalCellType(cell));
}

/**
 * Add a cell after `afterId` (appended when it is absent or unknown).
 * `source` seeds the new cell, so a paste / split / undo-delete lands as ONE
 * persist and ONE `cell:added` event carrying the real text - rather than an
 * empty cell that a follow-up edit fills in. `cellar` seeds its metadata the same
 * way, for the same reason (see `seedCellar`).
 */
export function addCell(
	afterId: string | null | undefined,
	cellType: LogicalCellType = 'code',
	nb?: string | null,
	originId?: string | null,
	source = '',
	cellar?: unknown
): Cell {
	const doc = docFor(nb);
	assertCanHoldType(doc, cellType);
	const cell = newCell(cellType, source);
	seedCellar(doc, cell, cellar);
	assertCanHoldCell(doc, cell);
	const idx = afterId ? doc.cells.findIndex((c) => c.id === afterId) : -1;
	if (idx >= 0) doc.cells.splice(idx + 1, 0, cell);
	else doc.cells.push(cell);
	persist(doc);
	emit(doc, 'cell:added', { cell: cellView(cell), afterId: idx >= 0 ? afterId : null }, originId);
	return cell;
}

/**
 * Switch a cell's LOGICAL type ('code' | 'sql' | 'mojo' | 'chat' | 'markdown' |
 * 'raw'). 'sql', 'mojo' and 'chat' are code cells tagged `cellar.language`
 * ($lib/cellLanguage.js's `languageTagFor`, the ONE tag rule), so they share the
 * nbformat `code` type on disk; 'code' clears that tag back to Python.
 *
 * Markdown cells carry no outputs - nor the imports role: a markdown cell cannot
 * run, so leaving the designation on one would strand every future routed import
 * in a cell the kernel never sees. A SQL, Mojo or chat cell likewise can't hold
 * Python imports, so converting to one of those drops the imports role too.
 *
 * The `cell:type` event carries the new `language` so live sync updates the
 * editor's syntax highlighting (SQL ↔ Python) without a reload; the browser
 * rebuilds the logical type from that pair through `logicalTypeFor`.
 *
 * A `.py` text notebook REFUSES 'raw'/'chat'/'mojo' here - see `assertCanHoldType`;
 * every other conversion stays allowed on one.
 */
export function setCellType(id: string, cellType: LogicalCellType, nb?: string | null, originId?: string | null): void {
	const doc = docFor(nb);
	assertCanHoldType(doc, cellType);
	const cell = find(doc, id);
	if (!cell) return;
	applyCellType(cell, cellType);
	persist(doc);
	emit(doc, 'cell:type', { cellId: id, cell_type: cell.cell_type, language: languageTagFor(cellType) }, originId);
}

/**
 * The in-place half of a type switch, shared by the single-cell setter and the
 * `setCellTypes` batch so the two can never diverge on the metadata rules: any
 * non-code type (markdown, raw) clears outputs, and anything holding no Python
 * (those two plus SQL, Mojo and chat) drops the imports role and the nbdev export
 * flag.
 *
 * `LiveNotebook.applyCellTypeLocally` is the browser's copy of exactly these
 * rules - `cell:type` carries no metadata, so a client half that skipped one
 * would keep drawing a badge the server has already stripped, with no event able
 * to correct it before a reload. Two implementations, not one per call site.
 *
 * The import-binding seed below is the one rule with NO client half, deliberately:
 * `importBindings` is a runtime-only staleness input the browser never reads (it
 * fetches `/api/notebooks/staleness`), so there is nothing there to keep in step.
 */
function applyCellType(cell: Cell, cellType: LogicalCellType): void {
	const lang = languageTagFor(cellType);
	const wasCode = cell.cell_type === 'code';
	cell.cell_type = nbCellType(cellType);
	cell.metadata = cell.metadata ?? {};
	cell.metadata.cellar = cell.metadata.cellar ?? {};
	// Becoming a code cell is the other way a cell acquires Python bindings without an
	// edit, so it takes the same birth stamp `newCell` gives a code cell born with a
	// source - and for the same reason: `newCell` stamps only a CODE cell, so a
	// markdown/raw cell created with an imports-only source carries none, and an absent
	// stamp reads as "these bindings have not changed", which would exempt the very edge
	// this conversion just rebound (`edgeCarriesChange`). Folded from an EMPTY previous
	// source, since nothing about this cell's bindings was ever proven while it held no
	// Python; a birth records no removal, so there is nothing for the prune to date.
	// Only on the way IN (a code→code sql toggle must not re-stamp and claim a change
	// that did not happen), and never over an existing stamp - a cell that was code
	// before carries real history a there-and-back conversion must not discard.
	if (!wasCode && cell.cell_type === 'code' && !cell.metadata.cellar.importBindings) {
		setImportBindings(cell.metadata.cellar, foldImportChange('', cell.source, undefined, Date.now()), null);
	}
	if (lang) cell.metadata.cellar.language = lang;
	else delete cell.metadata.cellar.language;
	// A cell the kernel actually executes as Python - i.e. an UNTAGGED code cell,
	// which is why `!lang` is the whole test. Markdown and raw never reach the
	// kernel at all; SQL and Mojo reach it compiled (to `spark.sql(...)` and to a
	// `%%mojo` magic), so neither holds Python; a CHAT cell's source is prose the
	// kernel never sees.
	const runnable = cell.cell_type === 'code' && !lang;
	// Only a code cell holds outputs - markdown and raw carry none, and
	// `serialize` would drop them anyway.
	if (cell.cell_type !== 'code') cell.outputs = [];
	// Neither the imports role nor the nbdev export flag may sit on a cell holding
	// no Python: the kernel never sees a markdown or raw cell, and a SQL, Mojo or
	// chat cell's source is not Python.
	if (!runnable && cell.metadata.cellar.role === IMPORTS_ROLE) delete cell.metadata.cellar.role;
	if (!runnable && cell.metadata.cellar.export) delete cell.metadata.cellar.export;
	// `hide_input` is deliberately KEPT: `$lib/hideInput` reads it only for a code
	// cell, so it is already inert on a markdown or raw one, and dropping it would
	// silently lose a report-view choice across a there-and-back conversion.
}

/**
 * Switch SEVERAL cells' logical type as ONE document write (the multi-cell
 * selection's bulk change-type).
 *
 * Deliberately NOT a loop over `setCellType`, for `deleteCells`' reason: that
 * serializes + fsyncs + renames the whole notebook once per cell and walks the
 * `.ipynb` through N-1 intermediate states. One pass, one persist, then one
 * `cell:type` per changed cell - the event every client already applies, so the
 * batch needs no new event shape.
 *
 * Returns the ids actually changed (a cell already of that type is skipped, so a
 * no-op batch persists nothing). "Already of that type" is `isLogicalCellType`, the
 * SHARED predicate - the browser predicts this count to tell a refused batch from
 * a batch that had nothing to do, and a second copy of the rule here would make
 * the two disagree on exactly the cells they must agree on.
 */
export function setCellTypes(
	ids: readonly string[],
	cellType: LogicalCellType,
	nb?: string | null,
	originId?: string | null
): string[] {
	const doc = docFor(nb);
	// Refused for the WHOLE batch before the first write, so a `.py` notebook can
	// never be left half-retyped - and, because nothing is changed, the caller's
	// `changed` count can never report a refused cell as converted.
	assertCanHoldType(doc, cellType);
	const changed: Cell[] = [];
	for (const id of ids) {
		const cell = find(doc, id);
		if (!cell) continue;
		if (isLogicalCellType(cell, cellType)) continue;
		applyCellType(cell, cellType);
		changed.push(cell);
	}
	if (!changed.length) return [];
	persist(doc);
	for (const cell of changed) {
		emit(doc, 'cell:type', { cellId: cell.id, cell_type: cell.cell_type, language: languageTagFor(cellType) }, originId);
	}
	return changed.map((c) => c.id);
}

/** The non-empty invariant itself: would removing exactly `removed` (already
 *  resolved against the document) leave the notebook with no cells? */
function emptiesNotebook(doc: NotebookDoc, removed: readonly string[]): boolean {
	return removed.length >= doc.cells.length;
}

/**
 * Would deleting `ids` be REFUSED by the non-empty invariant? For a caller with
 * work to do BEFORE the delete that must not happen if the delete never does -
 * MCP's `removeCells`, whose auto-checkpoint would otherwise mint a History entry
 * with an 'agent' trigger for a document that never changed. It reads the same
 * predicate `deleteCells` enforces with, so the two can't drift into disagreeing
 * about which batches are refused; `deleteCells` stays the ENFORCEMENT, this is
 * only a look-ahead (both are synchronous against the same in-memory doc, so
 * nothing can change between them).
 */
export function deleteWouldEmptyNotebook(ids: readonly string[], nb?: string | null): boolean {
	const doc = docFor(nb);
	const wanted = new Set(ids);
	const removed = doc.cells.filter((c) => wanted.has(c.id)).map((c) => c.id);
	return removed.length > 0 && emptiesNotebook(doc, removed);
}

/** A refused delete is distinguishable from one that simply matched
 *  nothing: the first is a request the document invariant rejected, the second
 *  is a no-op the caller can ignore. */
export type DeleteCellsResult =
	| { ok: true; removed: string[] }
	| { ok: false; reason: 'would-empty-notebook' };

/**
 * Delete SEVERAL cells as ONE document write (the multi-cell selection's bulk
 * delete and the MCP `delete_cells` batch).
 *
 * Deliberately NOT one persist per cell: a persist is a full serialize + fsync +
 * rename of the whole notebook, and repeating it walks the `.ipynb` through N-1
 * intermediate states a crash could freeze it in. One filter, one
 * persist, then one `cell:deleted` per removed cell, so every client applies the
 * same per-cell events it already handles and no new event shape exists.
 *
 * "A notebook always keeps at least one cell" is enforced HERE, where the real
 * cell count lives, not only in the browser: the client compares against ITS
 * cell count, which is stale for as long as an agent's `cell:deleted` events are
 * still in flight, so a selection covering everything the server still has would
 * otherwise persist a zero-cell `.ipynb` - the state the invariant exists to
 * prevent. Being in the shared layer also covers MCP `delete_cells`, which never
 * had the check at all. The WHOLE batch is refused (nothing removed, nothing
 * persisted, no events), matching what the client already models: a partial
 * delete nobody asked for is worse than a refusal.
 *
 * Unknown ids are ignored rather than persisting a no-op write.
 */
export function deleteCells(ids: readonly string[], nb?: string | null, originId?: string | null): DeleteCellsResult {
	const doc = docFor(nb);
	const wanted = new Set(ids);
	const going = doc.cells.filter((c) => wanted.has(c.id));
	const removed = going.map((c) => c.id);
	if (!removed.length) return { ok: true, removed: [] };
	if (emptiesNotebook(doc, removed)) return { ok: false, reason: 'would-empty-notebook' };
	// Whether each cell was hidden from the agent, captured BEFORE it leaves the
	// document: `cell:deleted` is emitted after the splice, so a subscriber can no
	// longer look the cell up, and the MCP tombstone registry must know not to
	// disclose a hidden cell's deletion (`mcp/userActivity.ts`). Only ever `true`,
	// so the ordinary event is byte-identical to before.
	const hidden = new Map(going.map((c) => [c.id, c.metadata?.cellar?.hidden_from_agent === true]));
	doc.cells = doc.cells.filter((c) => !wanted.has(c.id));
	persist(doc);
	for (const id of removed) {
		// A deleted cell must not later dequeue and run.
		cancelRun(doc.path, id);
		emit(doc, 'cell:deleted', { cellId: id, ...(hidden.get(id) ? { hiddenFromAgent: true } : {}) }, originId);
	}
	return { ok: true, removed };
}

/**
 * Delete ONE cell (`DELETE /api/cells/[id]`, the `dd`/cut path, consolidate's
 * sweep) — a `deleteCells` of one, so the non-empty invariant has exactly ONE
 * implementation and holds for EVERY caller. Enforcing it only on the batch path
 * left the same race open through the singular route: the client's own
 * `cells.length <= 1` check compares against ITS list, which is stale while an
 * agent's `cell:deleted` events are in flight, so a `dd` on what the browser
 * thinks is one of several would remove the server's LAST cell.
 */
export function deleteCell(id: string, nb?: string | null, originId?: string | null): DeleteCellsResult {
	return deleteCells([id], nb, originId);
}

export function setSource(id: string, source: string, nb?: string | null, originId?: string | null): void {
	const doc = docFor(nb);
	const cell = find(doc, id);
	if (cell && cell.source !== source) {
		const prevSource = cell.source;
		cell.source = source;
		// Runtime-only edit stamp for the staleness rule ($lib/staleness.js): a cell
		// (and everything downstream of it) is stale once its source changes after it
		// last ran. Stripped from disk by clean.js like `lastRun`, so an edit never
		// dirties the .ipynb. Set BEFORE persist so it rides the same in-memory doc.
		cell.metadata = cell.metadata ?? {};
		cell.metadata.cellar = cell.metadata.cellar ?? {};
		const now = Date.now();
		cell.metadata.cellar.editedAt = now;
		// …and the per-NAME refinement of that stamp for module-level import bindings.
		// `editedAt` alone makes an imports-cell edit stale every cell below it (it
		// defines a name almost all of them use); folding the new source against the
		// cell's last known-good baseline records WHICH names actually moved, so
		// staleness can transmit only along the edges that carry one. Same runtime-only
		// contract as `editedAt`. Cheap (a tokenizer pass over one cell). `prevSource`
		// only ever SEEDS a baseline the cell does not have yet - a mid-edit snapshot is
		// never compared against, see `foldImportChange`.
		setImportBindings(
			cell.metadata.cellar,
			foldImportChange(prevSource, source, cell.metadata.cellar.importBindings, now),
			latestConsumeAt(doc)
		);
		persist(doc);
		emit(doc, 'cell:edited', { cellId: id, source }, originId);
	}
}

export function setOutputs(id: string, outputs: CellOutput[], nb?: string | null): void {
	const doc = docFor(nb);
	const cell = find(doc, id);
	if (cell) {
		cell.outputs = outputs;
		// A `.py` notebook stores no outputs on disk (text has none), so a run only
		// updates the in-memory doc for live display — writing would re-run the whole
		// jupytext conversion to produce a byte-identical file. Persist only formats
		// that actually carry outputs.
		if (!doc.jpFormat) persist(doc);
	}
}

/**
 * Clear a cell's outputs in the LIVE in-memory doc only — no persist, no event.
 * Called at execution start (`run.js`) so the authoritative model reads empty the
 * moment a re-run begins: a tab that loads mid-run then gets no output and appends
 * the fresh stream, instead of concatenating it onto the prior run's result. Disk
 * is untouched (persist happens once, at run:end via `setOutputs`), so there is no
 * transient empty-output `.ipynb` write.
 */
export function clearOutputsLive(id: string, nb?: string | null): void {
	const cell = find(docFor(nb), id);
	if (cell) cell.outputs = [];
}

/**
 * Reflect a cell's CURRENT streamed outputs into the LIVE in-memory doc — no
 * persist, no event (the same in-memory-only contract as `clearOutputsLive`).
 * Called on every flush during a run (`run.js`) so `getNotebook`/`GET /api/notebooks`
 * returns the last-flushed outputs for a running cell. That is what makes a
 * mid-stream `load()` authoritative: a client that missed the establishing frame or
 * a delta refetches ONCE and genuinely resyncs, rather than reading empty (disk is
 * written once, at run:end via `setOutputs`; the SSE deltas already carry the live
 * update, so no event fires here).
 *
 * A document that is GONE (deleted in the explorer, so `dropDocs` retired it, or
 * renamed out from under a run) is a silent no-op - see `liveDoc`. The run's own
 * persist still throws for it, which is right: that caller needs a document.
 */
export function setOutputsLive(id: string, outputs: CellOutput[], nb?: string | null): void {
	const doc = liveDoc(nb);
	if (!doc) return;
	const cell = find(doc, id);
	if (cell) cell.outputs = outputs;
}

/**
 * Clear ONE cell's outputs (the UI's per-cell clear), persist, and broadcast.
 *
 * The `.py` guard is the same one `setOutputs` documents and `clearOutputsForCells`
 * applies: a text notebook carries no outputs on disk, so persisting would re-run
 * the whole jupytext conversion to write byte-identical bytes and churn mtime -
 * once per cell over the UI's clear-all loop. The EVENT still fires unconditionally,
 * so every open tab clears whatever the format.
 *
 * A cell whose run is IN FLIGHT is cleared like any other, and the clear reaches
 * that run too (`truncateActiveRunOutputs`), so the output it produced before this
 * point is gone for good rather than restored by the next flush and written back at
 * `run:end`. See the truncation note on `clearOutputsForCells`.
 */
export function clearOutputs(id: string, nb?: string | null, originId?: string | null): void {
	const doc = docFor(nb);
	const cell = find(doc, id);
	if (cell) {
		truncateActiveRunOutputs(doc.path, id);
		cell.outputs = [];
		if (!doc.jpFormat) persist(doc);
		emit(doc, 'cell:cleared', { cellId: id }, originId);
	}
}

/**
 * Clear SEVERAL cells' outputs as ONE document write (the MCP `clear_outputs`
 * batch, whose clear-all form addresses every cell in the notebook).
 *
 * Deliberately NOT a loop over `clearOutputs`, for the same reason `deleteCells`
 * is not a loop over `deleteCell`: that persists - a full serialize + fsync +
 * rename of the whole notebook - once per cell, so clearing a 300-cell notebook
 * would be 300 whole-file writes and 299 intermediate on-disk states. One pass,
 * one persist, then one `cell:cleared` per cleared cell, so every client applies
 * the per-cell event it already handles and no new event shape exists.
 *
 * Only cells that ACTUALLY have outputs are touched (the UI's `clearAll` guards
 * the same way), so an output-less cell is a genuine no-op: no event, and a
 * batch that would change nothing persists nothing rather than writing the file
 * back byte-identical. A `.py` notebook carries no outputs on disk, so it is
 * cleared in memory and broadcast but never written. `lastRun` is deliberately
 * left alone - clearing OUTPUT says nothing about whether the cell RAN, and
 * `run_status`/`ran_this_session` are derived from that stamp, never from
 * `outputs.length`.
 *
 * Returns the ids actually cleared.
 */
export function clearOutputsForCells(ids: readonly string[], nb?: string | null, originId?: string | null): string[] {
	const doc = docFor(nb);
	const wanted = new Set(ids);
	const cleared: string[] = [];
	for (const cell of doc.cells) {
		if (!wanted.has(cell.id) || !cell.outputs?.length) continue;
		// BEFORE emptying the document, so no flush of an in-flight run can interleave
		// and put its buffer back. A no-op for the cells that are not running, which is
		// almost all of them.
		truncateActiveRunOutputs(doc.path, cell.id);
		cell.outputs = [];
		cleared.push(cell.id);
	}
	if (!cleared.length) return [];
	// A `.py` notebook stores no outputs on disk, so persisting would re-run the
	// whole jupytext conversion to produce byte-identical bytes (the guard
	// `setOutputs` documents). The EVENTS still fire, so every open tab clears.
	if (!doc.jpFormat) persist(doc);
	for (const id of cleared) emit(doc, 'cell:cleared', { cellId: id }, originId);
	return cleared;
}

/**
 * Replace a notebook's entire cell array with `cells` (a checkpoint snapshot),
 * persist, and broadcast `notebook:restored` so every open tab refetches the
 * authoritative document. The input is deep-cloned so the live doc never aliases
 * the stored snapshot (a later edit would otherwise corrupt the checkpoint), and
 * ids are re-checked for uniqueness defensively. Used by the checkpoint restore
 * path (`checkpoints.js`); `clean.js` strips runtime metadata on persist, so a
 * restore leaves the `.ipynb` git-clean.
 *
 * A snapshot's `cell_type` is VALIDATED against the nbformat vocabulary, never
 * coerced to it. The old `=== 'markdown' ? 'markdown' : 'code'` shorthand read
 * every third type as code, so restoring a checkpoint of a notebook carrying an
 * nbformat `raw` cell (Quarto/nbdev frontmatter) silently retyped it to code and
 * broke the notebook for the tool that reads it - and `checkpoints.ts` snapshots
 * through `structuredClone(listCells(nb))`, which PRESERVES the type, so the loss
 * was entirely on this side. The fallback stays for a genuinely malformed
 * snapshot; the point is that a legitimate type survives.
 */
export function replaceCells(
	nb: string | null | undefined,
	cells: ReadonlyArray<Partial<Cell>>,
	originId?: string | null
): NotebookView {
	const doc = docFor(nb);
	const cloned: Cell[] = (Array.isArray(cells) ? cells : []).map((c) => ({
		id: c.id ?? '',
		cell_type: (NB_CELL_TYPES.has(c.cell_type as string) ? c.cell_type : 'code') as Cell['cell_type'],
		source: typeof c.source === 'string' ? c.source : '',
		outputs: Array.isArray(c.outputs) ? structuredClone(c.outputs) : [],
		metadata: c.metadata ? structuredClone(c.metadata) : {}
	}));
	// A checkpoint of an empty notebook can't leave the doc with zero cells (command
	// mode always needs one to act on); fall back to a fresh starter cell.
	if (cloned.length === 0) cloned.push(newCell('code'));
	enforceUniqueIds(cloned);
	doc.cells = cloned;
	persist(doc);
	publish({ type: 'notebook:restored', nb: doc.path, originId });
	return getNotebook(doc.path);
}

/** Swap a cell with its neighbour (via the shared `clampMoveIndex` rule). */
export function moveCell(id: string, dir: 'up' | 'down', nb?: string | null, originId?: string | null): void {
	const doc = docFor(nb);
	const i = doc.cells.findIndex((c) => c.id === id);
	if (i < 0) return;
	const j = dir === 'up' ? i - 1 : i + 1;
	if (j < 0 || j >= doc.cells.length) return;
	if (clampMoveIndex(doc.cells, i, j) !== j) return; // reserved for a future positional rule (identity today)
	[doc.cells[i], doc.cells[j]] = [doc.cells[j], doc.cells[i]];
	persist(doc);
	emit(doc, 'cell:moved', { cellId: id, toIndex: j }, originId);
}

/**
 * Move a whole SELECTION one step `dir`, as ONE document write.
 *
 * The plan comes from `$lib/cellSelection`'s `moveSelectionPlan` - the same pure
 * function the browser runs optimistically - so the client's rendering and the
 * persisted document are decided by one rule, not two. Each step is an adjacent
 * swap, emitted as the ordinary `cell:moved` event, so replaying the steps in
 * order reproduces the result on every other tab with no new event shape.
 *
 * The move is all-or-nothing: a step `clampMoveIndex` refuses (the seam reserved
 * for a positional rule; identity today) abandons the WHOLE plan rather than
 * leaving the selection half-slid past itself. Returns the steps applied.
 */
export function moveCells(
	ids: readonly string[],
	dir: 'up' | 'down',
	nb?: string | null,
	originId?: string | null
): { cellId: string; toIndex: number }[] {
	const doc = docFor(nb);
	const order = doc.cells.map((c) => c.id);
	const selected = new Set(ids.filter((id) => order.includes(id)));
	const steps = moveSelectionPlan(order, selected, dir);
	if (!steps.length) return [];
	// Work on a copy so a refused step abandons the plan with the live document
	// (and the file it is about to be persisted to) completely untouched.
	const next = [...doc.cells];
	const applied: { cellId: string; toIndex: number }[] = [];
	for (const step of steps) {
		const from = next.findIndex((c) => c.id === step.id);
		if (from < 0) return []; // cannot happen (ids were filtered against the doc)
		if (clampMoveIndex(next, from, step.toIndex) !== step.toIndex) return [];
		const [cell] = next.splice(from, 1);
		next.splice(step.toIndex, 0, cell);
		applied.push({ cellId: step.id, toIndex: step.toIndex });
	}
	doc.cells = next;
	persist(doc);
	for (const move of applied) emit(doc, 'cell:moved', move, originId);
	return applied;
}
