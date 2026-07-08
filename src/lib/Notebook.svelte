<script>
	import Cell from '$lib/Cell.svelte';

	// The shell owns the cell array + all cell operations (so the sidebar's
	// outline/search/inspector can read the same live state); this component is
	// the pure notebook renderer.
	let { cells, runningId, theme = 'dim', onRun, onRunAdvance, onClear, onDelete, onMove, onEdit, onSetType, onReady, onAddCell } = $props();
</script>

<!-- Fluid content column: fills the available width up to a readable cap, so
     cells use more horizontal space on wide monitors without going full-bleed
     on ultrawide. -->
<div class="mx-auto w-full max-w-[clamp(48rem,92%,88rem)] px-4 py-6" data-testid="notebook">
	<div class="space-y-4">
		{#each cells as cell, i (cell.id)}
			<Cell
				{cell}
				index={i}
				count={cells.length}
				running={runningId === cell.id}
				{theme}
				onRun={onRun}
				onRunAdvance={onRunAdvance}
				onClear={onClear}
				onDelete={onDelete}
				onMove={onMove}
				onEdit={onEdit}
				onSetType={onSetType}
				onReady={onReady}
			/>
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
