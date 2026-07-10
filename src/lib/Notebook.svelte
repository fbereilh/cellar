<script>
	import Cell from '$lib/Cell.svelte';

	const NO_SEGS_HIDDEN = { headings: new Set(), bodies: new Set() };

	// The shell owns the cell array + all cell operations (so the sidebar's
	// outline/search/inspector can read the same live state); this component is
	// the pure notebook renderer.
	let {
		cells,
		runningId,
		activeId = null,
		keyMode = 'command', // 'command' | 'edit' (Jupyter-style modal keyboard)
		theme = 'dim',
		hidden = new Set(), // cell ids hidden because a folded heading collapsed their section
		foldedIds = new Set(), // fold keys of the headings whose section is folded
		hiddenSegs = new Map(), // cell id → segment indices an outer fold hides inside it
		hiddenCounts = {}, // fold key → number of whole cells that heading hides
		gitStatus = {}, // cell id → 'added' | 'modified' | 'moved' (vs git HEAD)
		gitRemovedBefore = {}, // cell id → cells deleted from HEAD immediately above it
		gitRemovedAtEnd = 0, // cells deleted from the end of HEAD's notebook
		onToggleFold,
		onRun,
		onRunAdvance,
		onClear,
		onDelete,
		onMove,
		onMoveToIndex,
		onEdit,
		onSetType,
		onSetScrolled,
		editorCollapsed = {}, // cell id → explicit code-editor collapse choice (runtime-only)
		onSetEditorCollapsed,
		onActivate,
		onRegister,
		onEditorFocus,
		onEditorBlur,
		onAddCell
	} = $props();

	// ---- Drag to reorder cells ----------------------------------------------
	// A per-cell drag handle sets `draggable`; the editor stays non-draggable so
	// text selection is never hijacked. During a drag we show a thin insertion
	// line at the top or bottom edge of the hovered cell, then commit the move to
	// an absolute index via `onMoveToIndex` (which reuses the server move API).
	let dragId = $state(null); // id of the cell being dragged
	let dropIndex = $state(null); // insertion index the drop would land at
	let dropAtEnd = $state(false); // insertion line drawn below the last hovered cell

	function onDragStart(e, id) {
		dragId = id;
		e.dataTransfer.effectAllowed = 'move';
		try {
			e.dataTransfer.setData('text/plain', id);
		} catch {}
	}
	function onDragOverCell(e, index) {
		if (dragId == null) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = 'move';
		const r = e.currentTarget.getBoundingClientRect();
		const after = e.clientY > r.top + r.height / 2;
		dropIndex = index;
		dropAtEnd = after;
	}
	function onDropCell(e, index) {
		if (dragId == null) return;
		e.preventDefault();
		const r = e.currentTarget.getBoundingClientRect();
		const after = e.clientY > r.top + r.height / 2;
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
	const GIT_COLOR = {
		added: 'var(--cellar-git-added)',
		modified: 'var(--cellar-git-modified)',
		moved: 'var(--cellar-git-moved)'
	};
	const GIT_TITLE = {
		added: 'Added since the last commit',
		modified: 'Modified since the last commit',
		moved: 'Moved since the last commit'
	};
	const removedLabel = (n) => `${n} ${n === 1 ? 'cell' : 'cells'} removed`;
</script>

{#snippet removedSeam(n)}
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

<!-- Fluid content column: fills the available width up to a readable cap, so
     cells use more horizontal space on wide monitors without going full-bleed
     on ultrawide. -->
<div class="mx-auto w-full max-w-[clamp(48rem,92%,88rem)] px-4 py-6" data-testid="notebook">
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
					active={activeId === cell.id}
					{keyMode}
					dragging={dragId === cell.id}
					{foldedIds}
					segHidden={hiddenSegs.get(cell.id) ?? NO_SEGS_HIDDEN}
					foldCounts={hiddenCounts}
					onToggleFold={onToggleFold}
					{theme}
					onRun={onRun}
					onRunAdvance={onRunAdvance}
					onClear={onClear}
					onDelete={onDelete}
					onMove={onMove}
					onEdit={onEdit}
					onSetType={onSetType}
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
