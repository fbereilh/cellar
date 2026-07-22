<script lang="ts">
	import Cell from '$lib/Cell.svelte';
	import type { CellType, LogicalCellType } from '$lib/server/types';
	import type { KeyMode, CellRegisterApi, SegHidden, UICell } from '$lib/types';
	import type { StalenessEntry } from '$lib/staleness';
	import type { CellChangeStatus } from '$lib/gitdiff';
	import { planWindow, estimateHeight, mountedIds, DEFAULT_OVERSCAN_PX, type PlanItem } from '$lib/virtualization';

	const NO_SEGS_HIDDEN: SegHidden = { headings: new Set(), bodies: new Set() };
	const EMPTY_PLAN: PlanItem[] = [];

	interface Props {
		cells: UICell[];
		runningId: string | null;
		/** cell id → 1-based position in the kernel's global run queue */
		queued?: Record<string, number>;
		activeId?: string | null;
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
		onInterrupt?: () => void;
		onClear: (id: string) => void;
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
		/** Set (or clear, with '') the notebook's `.py` export target. */
		onSetExportTarget?: (target: string) => void;
		/** Regenerate the `.py` module now; resolves with the server result. */
		onExportPy?: () => Promise<{ written: boolean; target: string | null; count: number; reason?: string } | null>;
		onSetScrolled?: (id: string, scrolled: boolean) => void;
		/** Notebook-wide "hide all code inputs" default (a per-cell choice overrides it). */
		hideAllCode?: boolean;
		/** Hide (or show) a code cell's input in place. */
		onSetHideInput?: (id: string, hidden: boolean) => void;
		/** cell id → explicit code-editor collapse choice (runtime-only) */
		editorCollapsed?: Record<string, boolean | undefined>;
		onSetEditorCollapsed?: (id: string, collapsed: boolean) => void;
		onActivate?: (id: string) => void;
		onRegister?: (id: string, api: CellRegisterApi | null) => void;
		onEditorFocus?: (id: string) => void;
		onEditorBlur?: (id: string) => void;
		/** Windowed (virtualized) cell rendering. Default OFF — with it off the
		 *  renderer mounts every cell exactly as before (byte-identical). */
		virtualize?: boolean;
		onAddCell: (afterId: string | undefined, cellType: CellType) => void;
		/** Insert a fresh `cellType` cell above/below `targetId`, then select+focus it. */
		onInsertCell: (where: 'above' | 'below', targetId: string, cellType: CellType) => void;
	}

	// The shell owns the cell array + all cell operations (so the sidebar's
	// outline/search/inspector can read the same live state); this component is
	// the pure notebook renderer.
	let {
		cells,
		runningId,
		queued = {},
		activeId = null,
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
		onInterrupt,
		onClear,
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
		onSetScrolled,
		hideAllCode = false,
		onSetHideInput,
		editorCollapsed = {},
		onSetEditorCollapsed,
		onActivate,
		onRegister,
		onEditorFocus,
		onEditorBlur,
		virtualize = false,
		onAddCell,
		onInsertCell
	}: Props = $props();

	// ---- Windowed rendering (virtualization) ---------------------------------
	// The FOUNDATION phase: the machinery below is fully wired but DORMANT while
	// `virtualize` is false (the default). With the flag off, `planWindow` returns
	// "every cell mounted", `isMounted()` short-circuits to true, no scroll listener
	// is attached, and no reactive state churns — so the render is byte-identical to
	// the eager `{#each}`. Height measurement (`recordHeight`, fed by each Cell's
	// `onMeasure`) DOES run with the flag off, to keep the cache warm and trustworthy
	// before a later phase turns windowing on. See `$lib/virtualization`.
	let containerEl = $state<HTMLElement | null>(null);
	let viewportTop = $state(0);
	let viewportHeight = $state(0);
	// Measured card heights (px), keyed by cell id. Plain (non-reactive) Map: with
	// the flag off nothing reads it, so measurement never triggers a re-render. A
	// version counter drives re-planning ONLY while windowing is on.
	const heights = new Map<string, number>();
	let heightsVersion = $state(0);
	function recordHeight(id: string, px: number) {
		if (px <= 0 || heights.get(id) === px) return;
		heights.set(id, px);
		if (virtualize) heightsVersion++;
	}

	function scrollParentOf(el: HTMLElement): HTMLElement | null {
		for (let p = el.parentElement; p; p = p.parentElement) {
			const oy = getComputedStyle(p).overflowY;
			if (oy === 'auto' || oy === 'scroll') return p;
		}
		return null;
	}

	// A per-id cell lookup + height estimate, built only while windowing is on.
	const cellById = $derived.by(() => (virtualize ? new Map(cells.map((c) => [c.id, c])) : null));
	const DEFAULT_ESTIMATE_PX = 200;
	function estimateFor(id: string): number {
		const c = cellById?.get(id);
		return c ? estimateHeight(c) : DEFAULT_ESTIMATE_PX;
	}
	// Cells forced to stay mounted wherever they are. This phase pins the running
	// and active cells; later phases extend it (queued heads, focus, scroll targets).
	const pinned = $derived.by(() => {
		if (!virtualize) return undefined;
		const s = new Set<string>();
		if (runningId) s.add(runningId);
		if (activeId) s.add(activeId);
		return s;
	});
	const plan = $derived.by<PlanItem[]>(() => {
		if (!virtualize) return EMPTY_PLAN;
		void heightsVersion; // re-plan as measured heights land
		return planWindow({
			order: cells.map((c) => c.id),
			heights,
			estimate: estimateFor,
			virtualize: true,
			viewportTop,
			viewportHeight,
			overscanPx: Math.max(DEFAULT_OVERSCAN_PX, viewportHeight * 1.5),
			pinned
		});
	});
	const mounted = $derived(virtualize ? mountedIds(plan) : null);
	function isMounted(id: string): boolean {
		return !virtualize || (mounted?.has(id) ?? true);
	}
	function spacerHeight(id: string): number {
		return heights.get(id) ?? estimateFor(id);
	}

	// Scroll-pane metrics. Attached ONLY while windowing is on, so with the flag off
	// the scroll path carries no extra listener (zero behavior change). Reads are
	// rAF-coalesced. Wired now; a later phase is the first to act on the metrics.
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
		return () => {
			if (raf) cancelAnimationFrame(raf);
			parent.removeEventListener('scroll', onScroll);
			window.removeEventListener('resize', onScroll);
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

	// ---- nbdev-style export header bar ---------------------------------------
	// A slim bar at the top of the notebook to set the `.py` target and export on
	// demand. Shown only once the feature is in use (a target is set OR at least
	// one cell is marked), so it stays unobtrusive otherwise.
	let exportFeedback = $state('');
	let exporting = $state(false);
	const showExportBar = $derived(!!exportTarget || exportCount > 0);

	function onExportTargetInput(e: Event) {
		onSetExportTarget?.((e.currentTarget as HTMLInputElement).value);
	}
	async function doExport() {
		if (exporting) return;
		exporting = true;
		exportFeedback = '';
		const r = await onExportPy?.();
		exporting = false;
		if (!r) exportFeedback = 'Export failed.';
		else if (r.reason === 'no-target') exportFeedback = 'Set a target .py path first.';
		else if (r.reason === 'no-cells') exportFeedback = 'No cells are marked for export.';
		else exportFeedback = `Exported ${r.count} ${r.count === 1 ? 'cell' : 'cells'} → ${r.target}`;
	}
</script>

<!-- Hover-between insert control (VS Code style): a thin strip living in the gap
     above a cell that, on hover, reveals "+ Code" / "+ Markdown" buttons. Clicking
     inserts a fresh cell at that position (above `targetId`), reusing the one
     positional-insert path. Rendered per gap, so it covers above the first cell
     and between every pair; the always-visible append bar covers the very end. -->
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

<!-- The notebook page: a faintly-grey plane in light themes, so a cell's white
     output and grey editor each read as their own surface. -->
<div bind:this={containerEl} class="min-h-full bg-(--cellar-surface-page)">
	<!-- Fluid content column: fills the available width up to a readable cap, so
	     cells use more horizontal space on wide monitors without going full-bleed
	     on ultrawide. -->
	<div class="mx-auto w-full max-w-[clamp(48rem,92%,88rem)] px-4 py-6" data-testid="notebook">
		{#if showExportBar}
			<!-- nbdev-style export: the notebook-level target `.py` module + a manual
			     "Export to .py" button. Appears once any cell is marked for export or a
			     target is set; the module also regenerates automatically on save. -->
			<div
				class="mb-4 flex flex-wrap items-center gap-2 rounded-box border border-primary/25 bg-primary/5 px-3 py-2 text-sm"
				data-testid="export-bar"
			>
				<span class="flex items-center gap-1.5 font-medium text-primary">
					<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12" /><path d="m8 11 4 4 4-4" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></svg>
					Export to
				</span>
				<input
					type="text"
					class="input input-bordered input-xs w-56 font-mono"
					placeholder="utils.py"
					value={exportTarget ?? ''}
					oninput={onExportTargetInput}
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
				{#if exportFeedback}
					<span class="text-xs text-base-content/70" data-testid="export-feedback">{exportFeedback}</span>
				{/if}
			</div>
		{/if}
		<div class="space-y-4">
			{#each cells as cell, i (cell.id)}
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
					{#if isMounted(cell.id)}
					<Cell
						{cell}
						index={i}
						count={cells.length}
						running={runningId === cell.id}
						queuedPosition={queued[cell.id] ?? null}
						active={activeId === cell.id}
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
						onSetHideInput={onSetHideInput}
						editorCollapsed={editorCollapsed[cell.id]}
						onSetEditorCollapsed={onSetEditorCollapsed}
						onActivate={onActivate}
						onRegister={onRegister}
						onEditorFocus={onEditorFocus}
						onEditorBlur={onEditorBlur}
						onInsertCell={onInsertCell}
						onMeasure={recordHeight}
						onDragStart={onDragStart}
						onDragEnd={endDrag}
					/>
					{:else}
						<!-- Off-screen (windowed) cell collapsed to a spacer of its cached
						     height. Dormant while `virtualize` is off (isMounted is always true). -->
						<div aria-hidden="true" data-testid="cell-spacer" style="height: {spacerHeight(cell.id)}px"></div>
					{/if}
				</div>
			{/each}
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
		</div>
	</div>
</div>
