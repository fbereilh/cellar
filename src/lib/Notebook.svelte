<script lang="ts">
	import Cell from '$lib/Cell.svelte';
	import type { CellType, LogicalCellType } from '$lib/server/types';
	import type { KeyMode, CellRegisterApi, SegHidden, UICell } from '$lib/types';
	import type { StalenessEntry } from '$lib/staleness';
	import type { CellChangeStatus } from '$lib/gitdiff';

	const NO_SEGS_HIDDEN: SegHidden = { headings: new Set(), bodies: new Set() };

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
		/** cell id → explicit code-editor collapse choice (runtime-only) */
		editorCollapsed?: Record<string, boolean | undefined>;
		onSetEditorCollapsed?: (id: string, collapsed: boolean) => void;
		onActivate?: (id: string) => void;
		onRegister?: (id: string, api: CellRegisterApi | null) => void;
		onEditorFocus?: (id: string) => void;
		onEditorBlur?: (id: string) => void;
		onAddCell: (afterId: string | undefined, cellType: CellType) => void;
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
		editorCollapsed = {},
		onSetEditorCollapsed,
		onActivate,
		onRegister,
		onEditorFocus,
		onEditorBlur,
		onAddCell
	}: Props = $props();

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
<div class="min-h-full bg-(--cellar-surface-page)">
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
						queuedPosition={queued[cell.id] ?? null}
						active={activeId === cell.id}
						{keyMode}
						staleState={staleness[cell.id] ?? null}
						dragging={dragId === cell.id}
						{foldedIds}
						segHidden={hiddenSegs.get(cell.id) ?? NO_SEGS_HIDDEN}
						foldCounts={hiddenCounts}
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
						editorCollapsed={editorCollapsed[cell.id]}
						onSetEditorCollapsed={onSetEditorCollapsed}
						onActivate={onActivate}
						onRegister={onRegister}
						onEditorFocus={onEditorFocus}
						onEditorBlur={onEditorBlur}
						onDragStart={onDragStart}
						onDragEnd={endDrag}
					/>
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
