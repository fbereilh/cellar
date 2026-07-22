// Pure target-id selection for the bulk-run affordances (Run all / Run above).
//
// These pick WHICH cells a bulk run should execute; the actual running is the
// component's job (it feeds the returned ids, in order, to the shared run-queue
// path via `runCodeIds`). Kept pure + component-free so the selection rules are
// unit-testable in isolation and cannot drift from what the UI runs.
//
// Both skip non-code cells the same way the runner does — only code cells are
// executable, so a markdown/raw cell never lands in the list.

/** The minimal cell shape these rules need. */
export interface RunTargetCell {
	id: string;
	cell_type: string;
}

/** Every code cell in the notebook, in document order (the "Run all" target). */
export function codeIdsAll(cells: readonly RunTargetCell[]): string[] {
	return cells.filter((c) => c.cell_type === 'code').map((c) => c.id);
}

/**
 * Every code cell ABOVE `id` (exclusive), in document order — the Jupyter
 * "Run All Above" convention. The cell itself and everything below it are
 * excluded. Returns `[]` when `id` is the first cell (or is unknown), so the
 * caller can treat it as a no-op.
 */
export function codeIdsAbove(cells: readonly RunTargetCell[], id: string): string[] {
	const i = cells.findIndex((c) => c.id === id);
	if (i <= 0) return [];
	return codeIdsAll(cells.slice(0, i));
}
