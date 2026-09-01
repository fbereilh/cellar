<script lang="ts">
	import Cell from '$lib/Cell.svelte';
	import type { LogicalCellType } from '$lib/server/types';
	import { offersCellType } from '$lib/cellLanguage';
	import type { CellActivation, KeyMode, CellRegisterApi, SegHidden, UICell } from '$lib/types';
	import type { StalenessEntry } from '$lib/staleness';
	import type { CellChangeStatus } from '$lib/gitdiff';
	import type { CellHighlight } from '$lib/searchHighlight';
	import type { CollapsedRecord } from '$lib/cellCollapse';
	import type { ExtractedCodeBlock } from '$lib/codeBlockExtract';
	import type { WorkspaceRootOption } from '$lib/notebookRoot';
	import { EXPORT_BASES, EXPORT_BASE_LABELS, exportImportWarning } from '$lib/exportTarget';
	import type { ExportHazard } from '$lib/exportHazard';
	import type { ExportPyResult } from '$lib/types';
	import {
		planWindow,
		pinnedCellIds,
		estimateHeight,
		DEFAULT_OVERSCAN_PX,
		ROW_GAP_PX,
		type PlanItem
	} from '$lib/virtualization';

	const NO_SEGS_HIDDEN: SegHidden = { headings: new Set(), bodies: new Set() };
	const EMPTY_PLAN: PlanItem[] = [];
	const EMPTY_IDS: string[] = [];
	const EMPTY_SELECTION: ReadonlySet<string> = new Set();

	interface Props {
		cells: UICell[];
		runningId: string | null;
		/**
		 * Server wall-clock ms at which `runningId`'s run began executing, or null when
		 * that is unknown (no run, or a run whose start this tab never learned). Only
		 * the running cell is handed it, so a cell can never show an elapsed clock
		 * without also showing the running affordance it belongs to.
		 */
		runningSince?: number | null;
		/** cell id → 1-based position in this notebook's kernel run queue */
		queued?: Record<string, number>;
		/**
		 * Whether a sequential bulk run (Run all / above / below / stale) of THIS
		 * notebook is still working through its cells. `runningId`/`queued` both go
		 * empty between two cells of such a batch, so this is what keeps "Interrupt"
		 * armed for the whole batch rather than flickering off once per cell.
		 */
		bulkRunning?: boolean;
		activeId?: string | null;
		/**
		 * The multi-cell selection, as document-model ids. Always contains `activeId`
		 * (the primary), so a plain single selection is the degenerate one-element
		 * case. Read per cell rather than pinned into the mounted set on purpose:
		 * pinning a select-all would mount the whole notebook and undo windowing, so
		 * a selected cell that is windowed out simply renders selected the moment it
		 * scrolls back in. See `$lib/cellSelection`.
		 */
		selectedIds?: ReadonlySet<string>;
		keyMode?: KeyMode;
		/** cell id → staleness verdict ($lib/staleness) */
		staleness?: Record<string, StalenessEntry>;
		/** cell ids hidden because a folded heading collapsed their section */
		hidden?: Set<string>;
		/** fold keys of the headings whose section is folded */
		foldedIds?: Set<string>;
		/** cell id → segment indices an outer fold hides inside it */
		hiddenSegs?: Map<string, SegHidden>;
		/** fold key → number of whole cells that heading hides */
		hiddenCounts?: Record<string, number>;
		/** fold key → display-only auto-number for that heading (e.g. "1", "2.3") */
		headingNumbers?: Record<string, string>;
		/** cell id → change status vs git HEAD */
		gitStatus?: Record<string, CellChangeStatus>;
		/** cell id → cells deleted from HEAD immediately above it */
		gitRemovedBefore?: Record<string, number>;
		/** cells deleted from the end of HEAD's notebook */
		gitRemovedAtEnd?: number;
		onToggleFold?: (key: string) => void;
		onRun: (id: string, source: string) => void;
		onRunAdvance: (id: string, source: string, opts: { focusNext: boolean }) => void;
		/** Run every code cell above this one (exclusive), in document order. */
		onRunAbove?: (id: string) => void;
		/** Run every code cell in the notebook, top to bottom. */
		onRunAll?: () => void;
		onInterrupt?: () => void;
		onClear: (id: string) => void;
		/** Clear every cell's outputs — the same action as the palette's "Clear all outputs". */
		onClearAll?: () => void;
		/**
		 * Sweep this notebook's module-level imports into its pinned imports cell and
		 * run it — the same action as the palette's "Consolidate imports". The shell
		 * owns the request (and the busy flag below); this bar only surfaces it.
		 */
		onConsolidateImports?: () => void;
		/** True while a consolidate request is in flight, so it cannot be fired twice. */
		consolidating?: boolean;
		onDelete: (id: string) => void;
		onMove: (id: string, dir: 'up' | 'down') => void;
		onMoveToIndex?: (id: string, toIndex: number) => void;
		onEdit: (id: string, source: string, opts?: { keepalive?: boolean }) => void | Promise<void>;
		onSetType: (id: string, type: LogicalCellType) => void;
		/** Designate this cell the imports cell ('imports') or un-designate it (null). */
		onSetRole: (id: string, role: string | null) => void;
		/** Mark this code cell for nbdev-style `.py` export, or unmark it. */
		onSetExport?: (id: string, exported: boolean) => void;
		/** The notebook's `.py` export target (module path), or null when unset. */
		exportTarget?: string | null;
		/** How many cells are currently marked for export. */
		exportCount?: number;
		/**
		 * Set (or clear, with '') the notebook's `.py` export target. Called ONCE PER
		 * EDIT, from the input's `change` (a blur after typing, or Enter) - never per
		 * keystroke, since the write can be refused. `keepalive` is set only by the
		 * unload flush (`pagehide`), the same rule as `Cell.svelte`'s edit flush.
		 */
		onSetExportTarget?: (target: string, opts?: { keepalive?: boolean }) => void;
		/** Regenerate the `.py` module now; resolves with the server result. */
		onExportPy?: () => Promise<ExportPyResult | null>;
		/** What the stored export path is measured from (`$lib/exportTarget`);
		 *  `workspace` for the absent-key legacy default. */
		exportBase?: string;
		/** The WORKSPACE-relative path the effective target resolves to, or null. */
		exportResolved?: string | null;
		/** Why a CONFIGURED target cannot resolve (a `git` base outside any repo, a
		 *  path resolving outside the workspace, an unknown hand-edited base), else
		 *  null. Shown in the export section: a target in this state generates
		 *  nothing on every export, and silence would read as configured-and-working. */
		exportResolveError?: string | null;
		/** Constructs in the MARKED cells that make the generated module uncompilable
		 *  (`$lib/exportHazard`). A fact about the MARKS, not about any file on disk,
		 *  so it is honest whether or not an export has run: it says the module these
		 *  cells describe will not import. Rendered as a standing warning so the user
		 *  learns it BEFORE pressing Export, and so an export that does run cannot
		 *  report plain success. Empty on every ordinary notebook.
		 *
		 *  A POSITIVE finding, never a compile verdict - the detected class is narrower
		 *  than "a module that fails `compile`" - so the copy names the construct it
		 *  found and no surface may word an empty list as "this module compiles". */
		exportHazards?: ExportHazard[];
		/** True while a base re-expression is in flight (the base select is disabled). */
		exportBaseBusy?: boolean;
		/** Re-express the stored target under a new base (or record a pre-target choice). */
		onSetExportBase?: (base: string) => void;
		/** This notebook's declared code root (kernel cwd + sys.path), or null for the workspace. */
		root?: string | null;
		/** True for a `.py` text notebook, which stores no notebook metadata (no root
		 *  picker) and, being rebuilt from its cells on save, cannot hold a raw, Mojo
		 *  or chat cell (no Raw/Mojo/Chat entry in a cell's type menu). */
		isPy?: boolean;
		/** The workspace's code roots — an empty list renders no root control at all. */
		availableRoots?: WorkspaceRootOption[];
		/** True while a root change is in flight (the picker is disabled). */
		rootBusy?: boolean;
		/** Outcome of the last root change (applied / refused), shown beside the picker. */
		rootFeedback?: string;
		/** Declare (or clear, with '') the notebook's code root. */
		onSetRoot?: (root: string) => void;
		/** The Settings "Show code root bar" preference: offer the root bar even with
		 *  no root declared. A notebook with a DECLARED root always shows the bar
		 *  regardless - see `showRootBar`. */
		rootSectionEnabled?: boolean;
		/** A root was declared at some point THIS SESSION (LiveNotebook's latch), so
		 *  the bar - and the feedback for the clear the user just performed - does not
		 *  vanish mid-interaction the moment `root` goes back to null. */
		rootDeclaredThisSession?: boolean;
		onSetScrolled?: (id: string, scrolled: boolean) => void;
		/** Notebook-wide "hide all code inputs" default (a per-cell choice overrides it). */
		hideAllCode?: boolean;
		/** Hide (or show) a code cell's input in place. */
		onSetHideInput?: (id: string, hidden: boolean) => void;
		onSetHiddenFromAgent?: (id: string, hidden: boolean) => void;
		/** cell id → explicit code-editor collapse choice (runtime-only) */
		editorCollapsed?: Record<string, boolean | undefined>;
		onSetEditorCollapsed?: (id: string, collapsed: boolean) => void;
		/** cell id → this cell is FULLY collapsed: input + output hidden, header only
		 *  (`$lib/cellCollapse`; runtime-only, persisted per notebook). */
		cellCollapsed?: CollapsedRecord;
		onSetCellCollapsed?: (id: string, collapsed: boolean) => void;
		/** cell id → this markdown cell is open for raw source editing (runtime-only) */
		rawEdits?: Record<string, boolean | undefined>;
		onSetRawEdit?: (id: string, raw: boolean) => void;
		/** Lift a rendered code block out of a cell's prose into a new cell below it. */
		onExtractCode?: (id: string, block: ExtractedCodeBlock) => Promise<boolean>;
		onActivate?: (id: string, gesture?: CellActivation) => void;
		onRegister?: (id: string, api: CellRegisterApi | null) => void;
		onEditorFocus?: (id: string) => void;
		onEditorBlur?: (id: string) => void;
		/** Find-in-page query (Search P4); empty when the find bar is closed. */
		searchQuery?: string;
		searchCaseSensitive?: boolean;
		searchWholeWord?: boolean;
		searchRegex?: boolean;
		/** cell id → its highlight payload, for cells with ≥1 match (or null map). */
		cellHighlights?: Map<string, CellHighlight> | null;
		/** Windowed (virtualized) cell rendering. The shell passes true by default
		 *  (P5); the prop still defaults to false, and with it off the renderer mounts
		 *  every cell exactly as the eager `{#each}` did (byte-identical). */
		virtualize?: boolean;
		/** Transient jump targets forced to stay mounted wherever they are, so a
		 *  scroll-to-cell can land on a real DOM node even under windowing. Owned by
		 *  LiveNotebook (the jump paths live there): every jump / reveal / focus path
		 *  takes one through `ensureCellMounted` and drops it again via
		 *  `releaseScrollPin` once its scroll has settled (P4). */
		scrollPins?: Set<string>;
		/** The cell holding DOM focus (LiveNotebook tracks it off `focusin`). Pinned
		 *  alongside `activeId` so an edited cell scrolled far out of the window keeps
		 *  its CodeMirror cursor/undo until it blurs. */
		focusedId?: string | null;
		onAddCell: (afterId: string | undefined, cellType: LogicalCellType) => void;
		/** Insert a fresh `cellType` cell above/below `targetId`, then select+focus it. */
		onInsertCell: (where: 'above' | 'below', targetId: string, cellType: LogicalCellType) => void;
	}

	// The shell owns the cell array + all cell operations (so the sidebar's
	// outline/search/inspector can read the same live state); this component is
	// the pure notebook renderer.
	let {
		cells,
		runningId,
		runningSince = null,
		queued = {},
		bulkRunning = false,
		activeId = null,
		selectedIds = EMPTY_SELECTION,
		keyMode = 'command',
		staleness = {},
		hidden = new Set(),
		foldedIds = new Set(),
		hiddenSegs = new Map(),
		hiddenCounts = {},
		headingNumbers = {},
		gitStatus = {},
		gitRemovedBefore = {},
		gitRemovedAtEnd = 0,
		onToggleFold,
		onRun,
		onRunAdvance,
		onRunAbove,
		onRunAll,
		onInterrupt,
		onClear,
		onClearAll,
		onConsolidateImports,
		consolidating = false,
		onDelete,
		onMove,
		onMoveToIndex,
		onEdit,
		onSetType,
		onSetRole,
		onSetExport,
		exportTarget = null,
		exportCount = 0,
		onSetExportTarget,
		onExportPy,
		exportBase = 'workspace',
		exportResolved = null,
		exportResolveError = null,
		exportHazards = [],
		exportBaseBusy = false,
		onSetExportBase,
		root = null,
		isPy = false,
		availableRoots = [],
		rootBusy = false,
		rootFeedback = '',
		onSetRoot,
		rootSectionEnabled = false,
		rootDeclaredThisSession = false,
		onSetScrolled,
		hideAllCode = false,
		onSetHideInput,
		onSetHiddenFromAgent,
		editorCollapsed = {},
		onSetEditorCollapsed,
		cellCollapsed = {},
		onSetCellCollapsed,
		rawEdits = {},
		onSetRawEdit,
		onExtractCode,
		onActivate,
		onRegister,
		onEditorFocus,
		onEditorBlur,
		searchQuery = '',
		searchCaseSensitive = false,
		searchWholeWord = false,
		searchRegex = false,
		cellHighlights = null,
		virtualize = false,
		scrollPins,
		focusedId = null,
		onAddCell,
		onInsertCell
	}: Props = $props();

	// ---- Windowed rendering (virtualization) ---------------------------------
	// P2: with `virtualize` on - which since P5 is what the shell passes by default -
	// only the cells whose estimated extent overlaps the viewport (± overscan) plus the
	// pinned set are mounted; every off-screen run collapses into one inert
	// `height:{px}` spacer (report §3). Nothing here needs a cell-count threshold: when
	// every cell fits the window (a small notebook) `planWindow` emits no spacers, so
	// the ON path renders the same cells the eager one did. With the flag OFF (the
	// opt-out, `?virtualize=0` or the persisted preference) NONE of this runs: the
	// `{:else}` render branch mounts every cell exactly as the eager `{#each}` did, no
	// scroll listener is attached, and no reactive state churns. Height measurement
	// (`recordHeight`, fed by each Cell's `onMeasure`) DOES run with the flag off, to
	// keep the cache warm. See `$lib/virtualization`.
	let containerEl = $state<HTMLElement | null>(null);
	let viewportTop = $state(0);
	let viewportHeight = $state(0);
	// Measured card heights (px), keyed by cell id. Plain (non-reactive) Map: with
	// the flag off nothing reads it, so measurement never triggers a re-render. A
	// version counter drives re-planning ONLY while windowing is on.
	const heights = new Map<string, number>();
	let heightsVersion = $state(0);

	function scrollParentOf(el: HTMLElement): HTMLElement | null {
		for (let p = el.parentElement; p; p = p.parentElement) {
			const oy = getComputedStyle(p).overflowY;
			if (oy === 'auto' || oy === 'scroll') return p;
		}
		return null;
	}

	// A per-id cell lookup + document index, built only while windowing is on. The
	// ON render iterates the plan (not `cells`), so it resolves each mounted item's
	// cell object + index (for git decorations + drag targets) through these.
	const cellById = $derived.by(() => (virtualize ? new Map(cells.map((c) => [c.id, c])) : null));
	const indexById = $derived.by(() => (virtualize ? new Map(cells.map((c, i) => [c.id, i])) : null));
	const DEFAULT_ESTIMATE_PX = 200;
	function estimateFor(id: string): number {
		const c = cellById?.get(id);
		// A fully collapsed cell renders its header row and nothing else, so estimating
		// it from its source + outputs would reserve the space of a body it is not
		// drawing - metres of phantom flow for a collapsed section of a big notebook.
		// (Once it mounts, its MEASURED height replaces this either way.)
		return c ? estimateHeight(c, !!cellCollapsed[id]) : DEFAULT_ESTIMATE_PX;
	}
	// The window walks the VISIBLE cell sequence: a folded (`hidden`) cell contributes
	// 0 height and never mounts (report §5.5), so it is excluded from the order the
	// plan is built over. (Its wrapper is `display:none` anyway; leaving it in would
	// corrupt the running-offset math the window depends on.)
	const visibleOrder = $derived.by(() => (virtualize ? cells.filter((c) => !hidden.has(c.id)).map((c) => c.id) : EMPTY_IDS));
	// Cells forced to stay mounted wherever they are: the running cell, the heads of
	// the kernel's run queue, the selected cell, the cell holding DOM focus, and any
	// transient scroll target LiveNotebook is jumping to. The union (and the reason
	// each member is in it) lives in `$lib/virtualization`'s `pinnedCellIds`, which is
	// pure and unit-tested; this is only the wiring.
	const pinned = $derived.by(() =>
		virtualize ? pinnedCellIds({ runningId, queued, activeId, focusedId, scrollPins }) : undefined
	);
	const plan = $derived.by<PlanItem[]>(() => {
		if (!virtualize) return EMPTY_PLAN;
		void heightsVersion; // re-plan as measured heights land
		return planWindow({
			order: visibleOrder,
			heights,
			estimate: estimateFor,
			virtualize: true,
			viewportTop,
			viewportHeight,
			overscanPx: Math.max(DEFAULT_OVERSCAN_PX, viewportHeight * 1.5),
			pinned,
			gapPx: ROW_GAP_PX
		});
	});

	function recordHeight(id: string, px: number) {
		if (px <= 0 || heights.get(id) === px) return;
		// Scroll stability is the browser's: the scroll pane keeps its native
		// `overflow-anchor` (see +page.svelte), which re-anchors the viewport when an
		// off-screen cell mounts or an above-fold cell resizes. This module only feeds
		// the cache + re-plans; it holds no explicit scrollTop compensation. `planWindow`
		// accounts for the `space-y-4` inter-cell gap so its model tracks the real
		// scrollTop and the window never blanks.
		heights.set(id, px);
		if (virtualize) heightsVersion++;
	}

	// Scroll-pane metrics. Attached ONLY while windowing is on, so with the flag off
	// the scroll path carries no extra listener (zero behavior change). Reads are
	// rAF-coalesced, which is why a jump path must wait two frames after its scroll
	// before dropping its mount pin (see `LiveNotebook.releaseScrollPin`): unpinning
	// sooner re-plans the window against the PRE-scroll viewport. `planWindow` below
	// consumes these directly.
	$effect(() => {
		if (!virtualize || !containerEl) return;
		const parent = scrollParentOf(containerEl);
		if (!parent) return;
		let raf = 0;
		const read = () => {
			raf = 0;
			viewportTop = parent.scrollTop;
			viewportHeight = parent.clientHeight;
		};
		const onScroll = () => {
			if (!raf) raf = requestAnimationFrame(read);
		};
		read();
		parent.addEventListener('scroll', onScroll, { passive: true });
		window.addEventListener('resize', onScroll);
		// The scroll pane is `display:none` while its tab is inactive, so a notebook
		// that loaded hidden reads clientHeight=0 and would window against a zero-height
		// viewport (blank spacer) until the first scroll/resize. Observing the pane's own
		// size refreshes the metrics on the display:none→visible transition (and on
		// sidebar-drag / other container resizes) with no scroll needed.
		const ro =
			typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onScroll) : null;
		ro?.observe(parent);
		return () => {
			if (raf) cancelAnimationFrame(raf);
			parent.removeEventListener('scroll', onScroll);
			window.removeEventListener('resize', onScroll);
			ro?.disconnect();
		};
	});

	// Dev-only trustworthiness probe (report §6 P1 acceptance). Once cells have been
	// measured, each cached height must match the cell's live rendered box — a spacer
	// of the cached height must reproduce the flow space the cell occupied. The flow
	// gaps + page padding sit OUTSIDE the cache and are identical whether a row is a
	// cell or a spacer, so comparing Σ(cached) to Σ(live offsetHeight) is the faithful
	// check (equivalent, modulo that constant chrome, to Σ heights ≈ scrollHeight).
	if (import.meta.env.DEV) {
		$effect(() => {
			const el = containerEl;
			const n = cells.length;
			if (!el || n === 0) return;
			let cancelled = false;
			// Two rAFs so the cards' ResizeObservers have delivered their first sizes.
			requestAnimationFrame(() =>
				requestAnimationFrame(() => {
					if (cancelled) return;
					let live = 0;
					let cached = 0;
					let measured = 0;
					for (const c of cells) {
						const node = el.querySelector(`[data-cell-id="${CSS.escape(c.id)}"]`) as HTMLElement | null;
						const h = heights.get(c.id);
						if (!node || h == null) continue;
						live += node.offsetHeight;
						cached += h;
						measured++;
					}
					if (measured < n || live === 0) return; // only assert on a fully-measured notebook
					const drift = Math.abs(cached - live) / live;
					if (drift > 0.02)
						console.warn(
							`[cellar/virtualization] height cache drift ${(drift * 100).toFixed(1)}% over ${measured} cells (cached ${cached}px vs live ${live}px)`
						);
				})
			);
			return () => {
				cancelled = true;
			};
		});
	}

	// ---- Drag to reorder cells ----------------------------------------------
	// A per-cell drag handle sets `draggable`; the editor stays non-draggable so
	// text selection is never hijacked. During a drag we show a thin insertion
	// line at the top or bottom edge of the hovered cell, then commit the move to
	// an absolute index via `onMoveToIndex` (which reuses the server move API).
	// Deliberately SINGLE-cell, like the toolbar's trash and move arrows: the grip
	// is drawn on one cell, so it moves that cell even when several are selected.
	// The selection-wide move is the keyboard/palette one (`moveSelection`).
	let dragId = $state<string | null>(null); // id of the cell being dragged
	let dropIndex = $state<number | null>(null); // insertion index the drop would land at
	let dropAtEnd = $state(false); // insertion line drawn below the last hovered cell

	function onDragStart(e: DragEvent, id: string) {
		dragId = id;
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = 'move';
			try {
				e.dataTransfer.setData('text/plain', id);
			} catch {}
		}
	}
	/** Which edge of cell `index` the pointer is nearest. */
	function dropsAfter(e: DragEvent, index: number): boolean {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		return e.clientY > r.top + r.height / 2;
	}
	function onDragOverCell(e: DragEvent, index: number) {
		if (dragId == null) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		dropIndex = index;
		dropAtEnd = dropsAfter(e, index);
	}
	function onDropCell(e: DragEvent, index: number) {
		if (dragId == null) return;
		e.preventDefault();
		const after = dropsAfter(e, index);
		// Target index in the array as it currently stands (before removal); the
		// LiveNotebook normalizes/clamps and recomputes the real index server-side.
		let target = after ? index + 1 : index;
		const from = cells.findIndex((c) => c.id === dragId);
		if (from > -1 && from < target) target -= 1; // account for removal shift
		onMoveToIndex?.(dragId, target);
		endDrag();
	}
	function endDrag() {
		dragId = null;
		dropIndex = null;
		dropAtEnd = false;
	}

	// ---- Git cell decorations -------------------------------------------------
	// A per-cell accent bar in the notebook's left margin: the cell-level analogue
	// of VS Code's editor gutter change bars. Green = a cell HEAD doesn't have,
	// blue = its source (or type) changed, violet = same content, new position.
	// A deleted cell has no cell of its own to decorate, so it surfaces as a
	// dashed seam at the gap it left behind. Colors come from the shared
	// `--cellar-git-*` palette (`app.css`), which follows the light/dark theme.
	const GIT_COLOR: Record<CellChangeStatus, string> = {
		added: 'var(--cellar-git-added)',
		modified: 'var(--cellar-git-modified)',
		moved: 'var(--cellar-git-moved)'
	};
	const GIT_TITLE: Record<CellChangeStatus, string> = {
		added: 'Added since the last commit',
		modified: 'Modified since the last commit',
		moved: 'Moved since the last commit'
	};
	const removedLabel = (n: number): string => `${n} ${n === 1 ? 'cell' : 'cells'} removed`;

	// ---- nbdev-style export section ------------------------------------------
	// A slim section at the top of the notebook (directly below the code-root bar)
	// to pick the export BASE, set the target `.py` path, and export on demand.
	// ALWAYS present on a real notebook - a target has to be settable BEFORE any
	// cell is marked, which is exactly the state a use-it gate hid it in - and
	// styled as neutral standing chrome rather than a call to action. Hidden only
	// on a `.py` text notebook, which stores no notebook metadata: the server
	// refuses a target there, so offering the control would show a setting that
	// does nothing (the same rule as the root picker's absence).
	let exportFeedback = $state('');
	let exporting = $state(false);
	const showExportBar = $derived(!isPy);
	// The base select is DRIVEN by `exportBase`, never by the click (the
	// `selectedRoot` idiom below): with a stored target a base change is applied
	// non-optimistically - the server RE-EXPRESSES the same file under the new
	// spelling, and can REFUSE (a `git` base with no enclosing repository) - so
	// the control resyncs to what the document holds the moment the attempt
	// settles, whichever way it went. With no stored target the choice is
	// local-only (nothing to re-express) and rides up with the first path commit.
	let selectedExportBase = $state('workspace');
	$effect(() => {
		const settled = exportBase;
		if (exportBaseBusy) return;
		selectedExportBase = settled;
	});
	function onExportBaseSelect(e: Event) {
		onSetExportBase?.((e.currentTarget as HTMLSelectElement).value);
	}
	// The one trap a SUCCESSFUL export can still leave: the module lands outside
	// the notebook's declared code root, so the kernel - whose imports resolve
	// from that root - cannot `import` what was just written. The rule is pure and
	// shared (`$lib/exportTarget`), computed from the RESOLVED workspace-relative
	// path so it is exact whatever base expressed it, and null whenever it does
	// not apply - no target, no declared root, or the module sits under the root -
	// so the everyday case pays no chrome (the root bar's kernel-restart warning
	// is the model: accurate, and only where it applies).
	const importWarning = $derived(exportImportWarning(exportResolved, root));
	// Whether the notebook has any runnable (code) cell — gates the "Run all" button.
	const hasCodeCell = $derived(cells.some((c) => c.cell_type === 'code'));
	// Whether THIS notebook's kernel is executing or has work waiting — gates
	// "Interrupt". Read off the same per-notebook `runningId`/`queued` the cells
	// render their running/queued affordances from (never a global run counter:
	// notebooks run in parallel, so another notebook's run must not arm this
	// button), plus `bulkRunning` — those two go empty BETWEEN the cells of a
	// sequential bulk run, so without it the button would flicker disabled for a
	// round trip per cell and drop a click landing in that window.
	const notebookBusy = $derived(runningId !== null || Object.keys(queued).length > 0 || bulkRunning);
	// Whether any cell holds output to clear — gates "Clear all outputs". Read off
	// the MODEL, not the mounted cells, so a windowed-out cell's output counts.
	const hasOutputs = $derived(cells.some((c) => (c.outputs?.length ?? 0) > 0));

	// ---- code-root bar --------------------------------------------------------
	// Hidden by default; shown by the Settings preference, or - the invariant -
	// whenever this notebook actually HAS (or had, this session) a declared root:
	// see `showRootBar` below. A workspace that never adopts roots therefore
	// renders exactly what it always did - the feature costs it no chrome. The
	// picker always offers the notebook's CURRENT root even when its directory is
	// gone, so a broken declaration is visible and clearable rather than silently
	// absent.
	const rootOptions = $derived.by(() => {
		const opts = availableRoots.map((r) => ({ ...r }));
		if (root && !opts.some((o) => o.path === root)) {
			opts.push({
				path: root,
				absolute: '',
				exists: false,
				branch: null,
				commit: null,
				declared: true,
				notebooks: [],
				source: 'declared',
				// The stand-in describes a root whose directory is GONE, so nothing can
				// verify where it was; the DECLARATION's own shape is the only fact in
				// hand, and it is the one the label reads. Both out-of-workspace shapes
				// count: a hand-edited declaration may be ABSOLUTE (the resolver accepts
				// one and normalizes it, so one can be written), and reading a leading `/`
				// as internal labels a sibling checkout as sitting inside the workspace —
				// the single misreading the "external worktree" tag exists to prevent.
				external: root.startsWith('../') || root.startsWith('/')
			});
		}
		return opts;
	});
	// A `.py` (jupytext / Databricks source) notebook is written back from its cells
	// alone, so it stores no notebook metadata and could not keep a root across a
	// reload - the server REFUSES one there. No control is offered, so the picker
	// being absent and the declaration being refused say the same thing.
	// Otherwise the bar is OPT-IN chrome, hidden by default behind the Settings
	// "Show code root bar" preference (`rootSectionEnabled`) - roots are a
	// specialist workflow, and this replaced the old roots-in-use gate (a `roots/`
	// directory, or some notebook declaring one), which put standing chrome on
	// every notebook of a workspace the moment anything adopted roots. It keeps
	// that gate's promise a fortiori: a merely detected worktree - or now even an
	// adopted `roots/` directory - adds no chrome to a notebook that declares
	// nothing; the sidebar's WORKTREES block stays the discovery surface, so
	// nothing becomes unreachable.
	// THE EXCEPTION IS THE INVARIANT: a notebook whose root IS declared (a missing-
	// on-disk one included - that state NEEDS its explanation most) always shows
	// the bar, whatever the preference says - hiding it would leave the kernel
	// running in a directory nothing on screen explains or can clear. The session
	// latch (`rootDeclaredThisSession`) extends that through the clear itself:
	// without it, clearing a root snapped `root` to null and vanished the whole bar
	// - with the feedback line for the very click the user just made - and hid the
	// picker they may be about to use again.
	const showRootBar = $derived(
		!isPy && (rootSectionEnabled || root !== null || rootDeclaredThisSession)
	);
	// Whether the add affordances (the bottom add row + the hover-between strip)
	// may offer a CHAT cell: a `.py` text notebook cannot hold one (the server's
	// `assertCanHoldType` refuses it), and a control that offers a type the
	// document cannot store is the exact drift the type menu's `typeOptions`
	// filter exists to prevent. The rule is ASKED, never restated: `offersCellType`
	// in `$lib/cellLanguage` is the one both filters and `LiveNotebook`'s
	// optimistic refusal go through.
	const offerChatCell = $derived(offersCellType('chat', isPy));
	const currentRootOption = $derived(rootOptions.find((o) => o.path === root) ?? null);
	// The select is DRIVEN by `root`, never by the click: the change is applied
	// non-optimistically and can be REFUSED (the picker deliberately offers a
	// `(missing)` entry so a broken declaration can be seen and cleared, and
	// selecting one is refused), and a one-way `value={root}` re-applies only when
	// `root` MOVES - so a refusal left the control showing a root the notebook does
	// not run at, beside a `currentRootOption` hint describing the old one. The
	// resync is held back while the attempt is in flight (the control is disabled
	// there, so the pending choice stays legible) and forced the moment it settles,
	// whichever way it went.
	let selectedRoot = $state('');
	$effect(() => {
		const settled = root ?? '';
		if (rootBusy) return;
		selectedRoot = settled;
	});
	// An EXTERNAL root (a sibling worktree of this repo, outside the workspace) is
	// marked in the label itself, not only by its `../` prefix: adopting a checkout
	// while believing it sits inside the workspace is the one misreading this
	// feature can cause, and the file tree will keep showing the workspace either
	// way. The marker rides ON the option text because a `<select>` option cannot
	// carry a badge.
	function rootLabel(o: WorkspaceRootOption): string {
		const ref = o.branch ? ` — ${o.branch}` : '';
		const tag = o.external ? ' (external worktree)' : '';
		return o.exists ? `${o.path}${ref}${tag}` : `${o.path}${tag} (missing)`;
	}
	function onRootSelect(e: Event) {
		onSetRoot?.((e.currentTarget as HTMLSelectElement).value);
	}

	// A path field commits on CHANGE - a blur after an edit, or Enter - never per
	// keystroke: the route can REFUSE a target (a non-`.py` path, one escaping the
	// workspace, a `.py` text notebook), and refusing one character at a time fought
	// the typist. `change` does not fire on an unmodified blur, so merely clicking
	// through the field writes nothing.
	let exportTargetEl = $state<HTMLInputElement | undefined>(undefined);
	function onExportTargetCommit(e: Event) {
		onSetExportTarget?.((e.currentTarget as HTMLInputElement).value);
	}
	/**
	 * Commit a target typed but never committed, on PAGE UNLOAD only. `change` is not
	 * reliably delivered before unload, so without this a path the user typed and then
	 * reloaded (or closed the tab) on was simply lost - the same sub-commit window
	 * `Cell.svelte` flushes on `pagehide`, and the same idiom. The per-edit commit
	 * model is unchanged: this fires only when the field still differs from what the
	 * model holds, so an already-committed value writes nothing.
	 *
	 * Deliberately NOT flushed on teardown, unlike `Cell.svelte`'s: this component is
	 * destroyed by every `LiveNotebook.load()` refetch (it renders behind an
	 * `{:else if fetching}` gate), which an SSE reconnect, a seq gap from an agent's
	 * edit, `notebook:restored` or a refused bulk op all trigger - so a teardown commit
	 * fired mid-edit from a background event the user never caused, raising a spurious
	 * refusal for a half-typed path or silently persisting one that happened to parse.
	 * Losing an uncommitted value to a refetch is the far better half of that trade.
	 */
	function flushExportTarget(keepalive = false) {
		const el = exportTargetEl;
		if (!el || el.value === (exportTarget ?? '')) return;
		onSetExportTarget?.(el.value, { keepalive });
	}
	$effect(() => {
		const onUnload = () => flushExportTarget(true);
		window.addEventListener('pagehide', onUnload);
		return () => window.removeEventListener('pagehide', onUnload);
	});
	async function doExport() {
		if (exporting) return;
		exporting = true;
		exportFeedback = '';
		const r = await onExportPy?.();
		exporting = false;
		// A failure is reported by the caller through the shell's notice channel,
		// carrying the server's own reason; a bare "Export failed." here would be a
		// second, less informative surface for the same event.
		if (!r) return;
		if (r.reason === 'no-target') exportFeedback = 'Set a target .py path first.';
		else if (r.reason === 'no-cells') exportFeedback = 'No cells are marked for export.';
		// Nothing was written and that is deliberate, so the button may not read as a
		// dead control: Cellar never overwrites a file it did not generate.
		else if (r.reason === 'foreign-module')
			exportFeedback = `${r.target} was not generated by Cellar, so it was left untouched - point the target elsewhere, or delete that file.`;
		// A module that was written but cannot be imported may NOT report plain
		// success. The standing warning below already carries the full sentence
		// (this reply and it come from one server-side rule), so the feedback says
		// what happened and points at it rather than repeating it in the same bar.
		else if (r.hazards?.length)
			exportFeedback = `Wrote ${r.count} ${r.count === 1 ? 'cell' : 'cells'} → ${r.target}, but it will not import - see the warning.`;
		else exportFeedback = `Exported ${r.count} ${r.count === 1 ? 'cell' : 'cells'} → ${r.target}`;
	}
</script>

<!-- Hover-between insert control (VS Code style): a thin strip living in the gap
     above a cell that, on hover, reveals "+ Code" / "+ Markdown" / "+ Chat"
     buttons. Clicking inserts a fresh cell at that position (above `targetId`),
     reusing the one positional-insert path. Rendered per gap, so it covers above
     the first cell and between every pair; the always-visible append bar covers
     the very end. Code stays first and one click, so the common case pays nothing
     for the chat button; Chat is withheld on a `.py` notebook (`offerChatCell`),
     which cannot hold one. Raw and Mojo stay menu-only - see `ALL_TYPE_OPTIONS` in
     `Cell.svelte`. "+ Code" is not hardwired to Python either: `LiveNotebook`
     resolves it through `$lib/cellInherit`, so it takes the language of the code
     cell above. -->
{#snippet insertControls(where: 'above' | 'below', targetId: string | undefined)}
	{#if targetId}
		<div class="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-primary/25 opacity-0 transition-opacity group-hover/ins:opacity-100"></div>
		<div class="pointer-events-none flex gap-1 opacity-0 transition-opacity group-hover/ins:pointer-events-auto group-hover/ins:opacity-100">
			<button
				class="btn btn-primary btn-xs h-5 min-h-0 gap-1 px-2 shadow-sm"
				onclick={() => onInsertCell(where, targetId, 'code')}
				data-testid="insert-code"
				title="Insert a code cell here"
			>
				<svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
				Code
			</button>
			<button
				class="btn btn-neutral btn-xs h-5 min-h-0 gap-1 px-2 shadow-sm"
				onclick={() => onInsertCell(where, targetId, 'markdown')}
				data-testid="insert-markdown"
				title="Insert a markdown cell here"
			>
				<svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
				Markdown
			</button>
			{#if offerChatCell}
				<!-- `secondary` is chat's hue everywhere (the chat badge) - keep them agreeing. -->
				<button
					class="btn btn-secondary btn-xs h-5 min-h-0 gap-1 px-2 shadow-sm"
					onclick={() => onInsertCell(where, targetId, 'chat')}
					data-testid="insert-chat"
					title="Insert a chat cell here - running it asks Claude about the cells above"
				>
					<svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
					Chat
				</button>
			{/if}
		</div>
	{/if}
{/snippet}

{#snippet removedSeam(n: number)}
	<div
		class="flex items-center gap-2 text-[11px]"
		style="color: var(--cellar-git-removed)"
		data-testid="cell-removed-seam"
		title={`${removedLabel(n)} since the last commit`}
	>
		<span class="h-0 flex-1 border-t border-dashed opacity-50" style="border-color: var(--cellar-git-removed)"></span>
		<span class="whitespace-nowrap opacity-80">{removedLabel(n)}</span>
		<span class="h-0 flex-1 border-t border-dashed opacity-50" style="border-color: var(--cellar-git-removed)"></span>
	</div>
{/snippet}

<!-- One mounted cell row: the removed-seam above it, the `relative` wrapper, the
     per-cell git bar / hover-insert / drop indicator decorations, and the `<Cell>`.
     Shared by BOTH render paths so the flag-off output stays byte-identical: with
     windowing off the render iterates `cells` and calls this for every one (exactly
     the old eager `{#each}`); with it on the render iterates the plan and calls this
     only for the mounted items, emitting inert spacers for the collapsed runs. `i`
     is the cell's index within `cells` (its drag target + count position). -->
{#snippet cellRow(cell: UICell, i: number)}
	{#if gitRemovedBefore[cell.id] && !hidden.has(cell.id)}
		{@render removedSeam(gitRemovedBefore[cell.id])}
	{/if}
	<div
		role="presentation"
		class="relative"
		class:hidden={hidden.has(cell.id)}
		ondragover={(e) => onDragOverCell(e, i)}
		ondrop={(e) => onDropCell(e, i)}
	>
		<!-- Git change bar: sits in the content column's left padding, outside
		     the card (whose own left accent already means selected / running). -->
		{#if gitStatus[cell.id]}
			<div
				class="absolute inset-y-0 -left-3 w-1 rounded-full"
				style="background-color: {GIT_COLOR[gitStatus[cell.id]]}"
				title={GIT_TITLE[gitStatus[cell.id]]}
				data-testid="cell-git-bar"
				data-git={gitStatus[cell.id]}
			></div>
		{/if}
		<!-- Hover-between "+" control, living in the gap above this cell. Hidden
		     during a drag so it never fights the drop indicator. -->
		{#if dragId == null}
			<div
				class="group/ins absolute inset-x-0 -top-4 z-20 flex h-4 items-center justify-center"
				data-testid="insert-between"
			>
				{@render insertControls('above', cell.id)}
			</div>
		{/if}
		<!-- Insertion indicator (top or bottom edge of the hovered cell). -->
		{#if dragId != null && dropIndex === i}
			<div
				class="pointer-events-none absolute left-0 right-0 z-10 h-0.5 rounded bg-primary {dropAtEnd ? '-bottom-2' : '-top-2'}"
				data-testid="cell-drop-indicator"
			></div>
		{/if}
		<Cell
			{cell}
			index={i}
			count={cells.length}
			running={runningId === cell.id}
			runStartedAt={runningId === cell.id ? runningSince : null}
			queuedPosition={queued[cell.id] ?? null}
			active={activeId === cell.id}
			selected={selectedIds.has(cell.id)}
			{keyMode}
			staleState={staleness[cell.id] ?? null}
			dragging={dragId === cell.id}
			{foldedIds}
			segHidden={hiddenSegs.get(cell.id) ?? NO_SEGS_HIDDEN}
			foldCounts={hiddenCounts}
			{headingNumbers}
			onToggleFold={onToggleFold}
			onRun={onRun}
			onRunAdvance={onRunAdvance}
			onRunAbove={onRunAbove}
			onInterrupt={onInterrupt}
			onClear={onClear}
			onDelete={onDelete}
			onMove={onMove}
			onEdit={onEdit}
			onSetType={onSetType}
			onSetRole={onSetRole}
			onSetExport={onSetExport}
			onSetScrolled={onSetScrolled}
			{hideAllCode}
			{isPy}
			onSetHideInput={onSetHideInput}
			onSetHiddenFromAgent={onSetHiddenFromAgent}
			editorCollapsed={editorCollapsed[cell.id]}
			onSetEditorCollapsed={onSetEditorCollapsed}
			cellCollapsed={!!cellCollapsed[cell.id]}
			onSetCellCollapsed={onSetCellCollapsed}
			rawEdit={rawEdits[cell.id] ?? false}
			onSetRawEdit={onSetRawEdit}
			onExtractCode={onExtractCode}
			onActivate={onActivate}
			{searchQuery}
			{searchCaseSensitive}
			{searchWholeWord}
			{searchRegex}
			searchHighlight={cellHighlights?.get(cell.id) ?? null}
			onRegister={onRegister}
			onEditorFocus={onEditorFocus}
			onEditorBlur={onEditorBlur}
			onInsertCell={onInsertCell}
			onMeasure={recordHeight}
			onDragStart={onDragStart}
			onDragEnd={endDrag}
		/>
	</div>
{/snippet}

<!-- The notebook page: a faintly-grey plane in light themes, so a cell's white
     output and grey editor each read as their own surface. -->
<div bind:this={containerEl} class="min-h-full bg-(--cellar-surface-page)">
	<!-- Fluid content column: keeps growing with the window (no upper cap), minus
	     a proportional side gutter so cells never run edge-to-edge. The rule lives
	     once in `app.css` as `.cellar-notebook-column` — see its comment for why
	     the floor term is load-bearing. -->
	<div class="mx-auto w-full cellar-notebook-column px-4 py-6" data-testid="notebook">
		<!-- Notebook toolbar: the discoverable, top-of-notebook entry points for
		     acting on the whole notebook. Each button triggers the SAME handler its
		     command-palette twin does (`run-all` / `kernel-interrupt` /
		     `clear-all-outputs` / `consolidate-imports`) — this bar surfaces those
		     actions, it owns none of their logic. Run all enqueues every code cell
		     through the same server-side FIFO run queue as any other run, so
		     interrupting cancels the whole batch.
		     An action promoted to this bar leaves the navbar Options menu rather than
		     appearing in both: Run all / Interrupt / Clear all outputs are toolbar +
		     palette only, and Consolidate imports now follows them. The menu keeps
		     what this bar does NOT carry (run stale/above/below, Export to .py, …).
		     `flex-wrap` so a narrow window (or a wide sidebar) wraps the bar onto a
		     second row instead of pushing buttons out of reach — the same rule the
		     per-cell toolbar row follows. -->
		<div class="mb-4 flex flex-wrap items-center gap-2" data-testid="notebook-toolbar">
			<button
				class="btn btn-ghost btn-sm gap-1.5 text-success"
				onclick={() => onRunAll?.()}
				disabled={!hasCodeCell}
				title="Run all cells top to bottom"
				aria-label="Run all cells"
				data-testid="run-all"
			>
				<svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
				Run all
			</button>
			<!-- Disabled only while this notebook looks idle from here, so no interrupt
			     request is fired at a kernel with nothing to stop and no queue to drop.
			     That is what the disable buys, and no more: `queued` is this tab's
			     mirror of the server snapshot, so between another tab's or an agent's
			     run being enqueued and the `queue:changed` broadcast landing, the
			     button is briefly disabled while there really is something to cancel. -->
			<button
				class="btn btn-ghost btn-sm gap-1.5"
				onclick={() => onInterrupt?.()}
				disabled={!notebookBusy}
				title="Interrupt the kernel (stop the running cell and drop this notebook's queued runs)"
				aria-label="Interrupt the kernel"
				data-testid="interrupt-all"
			>
				<svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5" /></svg>
				Interrupt
			</button>
			<button
				class="btn btn-ghost btn-sm gap-1.5"
				onclick={() => onClearAll?.()}
				disabled={!hasOutputs}
				title="Clear every cell's outputs"
				aria-label="Clear all outputs"
				data-testid="clear-all-outputs"
			>
				<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4l9.3-9.3a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L13 21" /><path d="M22 21H7" /><path d="m5 11 9 9" />
				</svg>
				Clear all outputs
			</button>
			<!-- Disabled only while a sweep is in flight, so it cannot be fired twice.
			     There is no "nothing to consolidate" gate here and there was none on the
			     menu item this replaces: the sweep is idempotent (a notebook with nothing
			     to move rewrites nothing), so predicting emptiness would be a new claim,
			     not the same button in a new place. -->
			<button
				class="btn btn-ghost btn-sm gap-1.5"
				onclick={() => onConsolidateImports?.()}
				disabled={consolidating}
				title="Move every top-level import into one pinned cell at the top of the notebook, and run it"
				aria-label="Consolidate imports"
				data-testid="consolidate-imports"
			>
				{#if consolidating}
					<span class="loading loading-spinner loading-xs"></span>
				{:else}
					<!-- Arrow UP into a line at the TOP: imports are gathered into the pinned
					     cell at the top of the notebook. The menu item this replaces used the
					     mirrored glyph (down onto a bottom line), which in this bar is the same
					     picture as the "Export to" download arrow sitting directly below it —
					     two adjacent affordances reading as one action. This way is both
					     distinct and the right direction. -->
					<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 3h14" /><path d="M12 21V9" /><path d="m7 14 5-5 5 5" /></svg>
				{/if}
				Consolidate imports
			</button>
		</div>
		{#if showRootBar}
			<!-- Code root: the directory THIS notebook's kernel runs in and imports from
			     (normally a git worktree under `roots/`). WHEN it is rendered is
			     `showRootBar`'s rule and is stated there - opt-in chrome, with an
			     actually-declared root as the standing exception - so it is not
			     restated here. Deliberately quieter than the export bar: it is a
			     property of the notebook, not an action, and changing it costs the
			     user their kernel. -->
			<div
				class="mb-4 flex flex-wrap items-center gap-2 rounded-box border border-base-300 bg-base-100 px-3 py-2 text-sm"
				data-testid="root-bar"
			>
				<span class="flex items-center gap-1.5 font-medium text-base-content/70">
					<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2" /><path d="M3 7h18v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
					Code root
				</span>
				<select
					class="select select-bordered select-xs w-auto min-w-56 max-w-md pr-7 font-mono"
					bind:value={selectedRoot}
					onchange={onRootSelect}
					disabled={rootBusy}
					data-testid="root-select"
					aria-label="Directory this notebook's kernel runs in"
				>
					<option value="">workspace root (default)</option>
					{#each rootOptions as opt (opt.path)}
						<option value={opt.path}>{rootLabel(opt)}</option>
					{/each}
				</select>
				{#if currentRootOption && !currentRootOption.exists}
					<span class="text-xs text-error" data-testid="root-missing">
						missing on disk — runs will fail until it is restored or cleared
					</span>
				{:else}
					<!-- Both facts, BEFORE the click: what a root reaches, and what changing
					     it costs. Selecting one frees the kernel, so the price is stated
					     here rather than only afterwards in the feedback line. -->
					<!-- The workspace-wide clause matters MORE once a root may sit outside
					     the workspace, not less: your kernel runs in the worktree while the
					     file tree still shows the workspace, which is genuinely surprising
					     the first time. Do not trim it. -->
					<span class="text-xs text-base-content/55">
						kernel cwd + imports only; files, git and checkpoints stay workspace-wide{currentRootOption?.external
							? ' (an external worktree runs the kernel outside this workspace)'
							: ''}. Changing it restarts the kernel - variables are cleared.
					</span>
				{/if}
				{#if rootFeedback}
					<span class="text-xs text-base-content/70" data-testid="root-feedback">{rootFeedback}</span>
				{/if}
			</div>
		{/if}
		{#if showExportBar}
			<!-- nbdev-style export: pick the BASE the path is measured from, name the
			     target `.py` module, export on demand. Always present (directly below
			     the code-root bar) so a target can be set BEFORE any cell is marked.
			     The module is written ONLY by an explicit export action - this button,
			     or naming the target / marking a cell - never by an ordinary save, so
			     an edit to a marked cell leaves the module as it was until one of
			     those. Root-bar-neutral styling: standing chrome, not a call to
			     action. -->
			<div
				class="mb-4 flex flex-wrap items-center gap-2 rounded-box border border-base-300 bg-base-100 px-3 py-2 text-sm"
				data-testid="export-bar"
			>
				<span class="flex items-center gap-1.5 font-medium text-base-content/70">
					<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12" /><path d="m8 11 4 4 4-4" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></svg>
					Export to
				</span>
				<select
					class="select select-bordered select-xs w-auto pr-7"
					bind:value={selectedExportBase}
					onchange={onExportBaseSelect}
					disabled={exportBaseBusy}
					data-testid="export-base-select"
					aria-label="What the export path is measured from"
				>
					{#each EXPORT_BASES as b (b)}
						<option value={b}>from {EXPORT_BASE_LABELS[b]}</option>
					{/each}
				</select>
				<input
					bind:this={exportTargetEl}
					type="text"
					class="input input-bordered input-xs w-56 font-mono"
					placeholder="utils.py"
					value={exportTarget ?? ''}
					onchange={onExportTargetCommit}
					data-testid="export-target-input"
					aria-label="Export target .py module path"
				/>
				<span class="text-xs text-base-content/55" data-testid="export-count">
					{exportCount} {exportCount === 1 ? 'cell' : 'cells'} marked
				</span>
				<button
					class="btn btn-primary btn-xs gap-1"
					onclick={doExport}
					disabled={exporting}
					data-testid="export-run"
				>
					{exporting ? 'Exporting…' : 'Export to .py'}
				</button>
				{#if exportResolveError}
					<!-- A CONFIGURED target that resolves to no writable file: the module is
					     not being generated, and silence here would read as working. The
					     warning tint rides the ICON, not the copy (`text-warning` body copy
					     fails contrast on the light theme - the GitNotebooks rule). -->
					<span class="flex items-center gap-1 text-xs text-base-content/70" data-testid="export-resolve-error">
						<svg class="h-3.5 w-3.5 shrink-0 text-warning" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>
						{exportResolveError}
					</span>
				{:else if exportHazards.length}
					<!-- The module these marks describe will not import - said in the
					     future tense on purpose, since under explicit export there may
					     be no such file yet (the shared wording in `$lib/exportHazard`
					     already reads that way). Ranked above the code-root warning:
					     that one says the kernel cannot reach the module, this says
					     nothing can. Below `exportResolveError`, which means no module
					     can be written at all. -->
					<span class="flex items-center gap-1 text-xs text-base-content/70" data-testid="export-hazard">
						<svg class="h-3.5 w-3.5 shrink-0 text-warning" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>
						{exportHazards[0].message}
					</span>
				{:else if importWarning}
					<span class="flex items-center gap-1 text-xs text-base-content/70" data-testid="export-import-warning">
						<svg class="h-3.5 w-3.5 shrink-0 text-warning" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>
						{importWarning}
					</span>
				{:else if exportResolved && exportBase !== 'workspace'}
					<!-- A non-workspace base makes the typed path indirect, so say which
					     workspace file it names (under the workspace base they are the same
					     string, and the echo would be noise). -->
					<span class="font-mono text-xs text-base-content/55" data-testid="export-resolved">→ {exportResolved}</span>
				{/if}
				{#if exportFeedback}
					<span class="text-xs text-base-content/70" data-testid="export-feedback">{exportFeedback}</span>
				{/if}
			</div>
		{/if}
		<div class="space-y-4">
			{#if virtualize}
				<!-- Windowed: iterate the render PLAN. Each mounted item renders the full
				     row via `cellRow`; each off-screen run is one inert, height-preserving
				     spacer. Mounted cells are keyed by id (their editor/run state survives
				     re-planning as the window scrolls); a spacer by its collapsed-run key. -->
				{#each plan as item (item.kind === 'cell' ? item.id : item.key)}
					{#if item.kind === 'spacer'}
						<div aria-hidden="true" data-testid="cell-spacer" style="height: {item.px}px"></div>
					{:else}
						{@const cell = cellById?.get(item.id)}
						{#if cell}
							{@render cellRow(cell, indexById?.get(item.id) ?? 0)}
						{/if}
					{/if}
				{/each}
			{:else}
				<!-- Flag off (default): mount every cell, exactly as the eager `{#each}`. -->
				{#each cells as cell, i (cell.id)}
					{@render cellRow(cell, i)}
				{/each}
			{/if}
			{#if gitRemovedAtEnd}
				{@render removedSeam(gitRemovedAtEnd)}
			{/if}
		</div>

		<div class="mt-4 flex justify-center gap-2">
			<button class="btn btn-ghost btn-sm gap-1" onclick={() => onAddCell(cells.at(-1)?.id, 'code')} data-testid="add-cell">
				<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
				Code
			</button>
			<button class="btn btn-ghost btn-sm gap-1" onclick={() => onAddCell(cells.at(-1)?.id, 'markdown')} data-testid="add-markdown">
				<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
				Markdown
			</button>
			{#if offerChatCell}
				<button
					class="btn btn-ghost btn-sm gap-1"
					onclick={() => onAddCell(cells.at(-1)?.id, 'chat')}
					data-testid="add-chat"
					title="Add a chat cell - running it asks Claude about the cells above"
				>
					<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
					Chat
				</button>
			{/if}
		</div>
	</div>
</div>
