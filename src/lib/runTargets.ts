// Pure target-id selection for the bulk-run affordances (Run all / Run above).
//
// These pick WHICH cells a bulk run should execute; the actual running is the
// component's job (it feeds the returned ids, in order, to the shared run-queue
// path via `runCodeIds`). Kept pure + component-free so the selection rules are
// unit-testable in isolation and cannot drift from what the UI runs.
//
// Non-code cells are skipped the same way the runner does - only code cells are
// executable, so a markdown/raw cell never lands in the list.
//
// A CHAT cell is skipped too, and it is the one skip a bulk run REPORTS. It is
// an nbformat code cell, so the plain `cell_type === 'code'` rule picked it up -
// and running one is not a kernel execution but a billed model turn that holds
// the notebook's single queue slot until it answers. "Run all" means re-run my
// code, not re-ask Claude the same questions at a cost, and a reply is
// nondeterministic, so a sweep re-run buys nothing that was asked for. This is
// the same rule the MCP batch tools apply (`runCells`' CHAT_BATCH_SKIP_NOTE), so
// the human and the agent surface cannot diverge. Asking a chat cell stays the
// DELIBERATE per-cell act (its Run button, Mod-Enter, Shift+Enter), which is
// untouched.

import { isChatCell } from '$lib/cellLanguage';
import type { CellMetadata } from '$lib/server/types';

/** The minimal cell shape these rules need. */
export interface RunTargetCell {
	id: string;
	cell_type: string;
	metadata?: CellMetadata | null;
}

/** What a bulk run will execute, and what it deliberately left alone. */
export interface RunTargets {
	/** The cells to run, in document order. */
	ids: string[];
	/** Chat cells skipped - reported by the caller, never silently dropped. */
	chatSkipped: string[];
}

/**
 * Partition cells into what a bulk run executes and the chat cells it skips.
 * The ONE selection rule; `codeIdsAll`/`codeIdsAbove` are its id-only halves, so
 * a caller that wants the count and one that wants the list cannot disagree.
 */
export function runTargets(cells: readonly RunTargetCell[]): RunTargets {
	const ids: string[] = [];
	const chatSkipped: string[] = [];
	for (const c of cells) {
		if (c.cell_type !== 'code') continue;
		if (isChatCell(c)) chatSkipped.push(c.id);
		else ids.push(c.id);
	}
	return { ids, chatSkipped };
}

/**
 * The same partition for every cell ABOVE `id` (exclusive) - the Jupyter
 * "Run All Above" convention. The cell itself and everything below it are
 * excluded, so an unknown id (or the first cell) selects nothing.
 */
export function runTargetsAbove(cells: readonly RunTargetCell[], id: string): RunTargets {
	const i = cells.findIndex((c) => c.id === id);
	if (i <= 0) return { ids: [], chatSkipped: [] };
	return runTargets(cells.slice(0, i));
}

/** Every runnable code cell in the notebook, in document order. */
export function codeIdsAll(cells: readonly RunTargetCell[]): string[] {
	return runTargets(cells).ids;
}

/** Every runnable code cell ABOVE `id` (exclusive), in document order. */
export function codeIdsAbove(cells: readonly RunTargetCell[], id: string): string[] {
	return runTargetsAbove(cells, id).ids;
}

/**
 * What the user is told when a bulk run left chat cells alone. One sentence, so
 * the skip is never silent: it names how many were skipped and how to ask one.
 */
export function chatSkipNotice(count: number): string {
	const what = count === 1 ? '1 chat cell' : `${count} chat cells`;
	return `Skipped ${what}: a bulk run re-runs code, not chat. Run a chat cell from its own Run button to ask again.`;
}
