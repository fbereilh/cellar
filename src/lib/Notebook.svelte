<script>
	import Cell from '$lib/Cell.svelte';

	// The shell owns the cell array + all cell operations (so the sidebar's
	// outline/search/inspector can read the same live state); this component is
	// the pure notebook renderer.
	let {
		cells,
		runningId,
		activeId = null,
		theme = 'dim',
		onRun,
		onRunAdvance,
		onClear,
		onDelete,
		onMove,
		onMoveToIndex,
		onEdit,
		onSetType,
		onSetScrolled,
		onActivate,
		onReady,
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
</script>

<!-- Fluid content column: fills the available width up to a readable cap, so
     cells use more horizontal space on wide monitors without going full-bleed
     on ultrawide. -->
<div class="mx-auto w-full max-w-[clamp(48rem,92%,88rem)] px-4 py-6" data-testid="notebook">
	<div class="space-y-4">
		{#each cells as cell, i (cell.id)}
			<div
				role="presentation"
				class="relative"
				ondragover={(e) => onDragOverCell(e, i)}
				ondrop={(e) => onDropCell(e, i)}
			>
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
					dragging={dragId === cell.id}
					{theme}
					onRun={onRun}
					onRunAdvance={onRunAdvance}
					onClear={onClear}
					onDelete={onDelete}
					onMove={onMove}
					onEdit={onEdit}
					onSetType={onSetType}
					onSetScrolled={onSetScrolled}
					onActivate={onActivate}
					onReady={onReady}
					onDragStart={onDragStart}
					onDragEnd={endDrag}
				/>
			</div>
		{/each}
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
