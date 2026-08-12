import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The WIRING between the clear path and the run producing the outputs.
 *
 * `run-output-registry.test.ts` drives the registry directly and the accumulator
 * suite calls `reset()` directly, so both would stay green if `notebook.ts` simply
 * stopped calling `truncateActiveRunOutputs` — and the e2e that would catch it runs
 * in neither CI nor the no-mistakes gate. These go through the REAL clear path
 * instead, so deleting either call fails a gated suite.
 *
 * What that one call buys, and why it is worth a test of its own: without it a
 * mid-run clear is undone at `run:end` (the accumulator re-persists the whole
 * transcript), and the next full frame lands past the end of the client's emptied
 * array, leaving a hole that throws while rendering — which, with no
 * `<svelte:boundary>` anywhere in `src/`, takes the whole notebook's render tree
 * down rather than one cell.
 */

let WS: string;
let nb: typeof import('../../src/lib/server/notebook');
let registry: typeof import('../../src/lib/server/run-output-registry');

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-cleartrunc-'));
	process.env.CELLAR_WORKSPACE = WS;
	nb = await import('../../src/lib/server/notebook');
	registry = await import('../../src/lib/server/run-output-registry');
});

beforeEach(() => registry.__resetRunOutputRegistry());

/** Stands in for the run's OutputAccumulator; only `reset` is reachable from here. */
function spyAccumulator() {
	let resets = 0;
	return { acc: { reset: () => void resets++ }, count: () => resets };
}

/** A notebook holding one code cell that already carries an output. */
function notebookWithOutput(path: string): string {
	nb.createNotebook(path);
	const cell = nb.addCell(null, 'code', path, null, 'print("x")');
	nb.setOutputs(cell.id, [{ output_type: 'stream', name: 'stdout', text: 'before\n' }], path);
	expect(nb.listCells(path).find((c) => c.id === cell.id)?.outputs).toHaveLength(1);
	return cell.id;
}

/** The absolute path the registry is keyed by — the same one `notebook.ts` uses. */
function absPath(path: string): string {
	return nb.resolveNotebookPath(path);
}

describe('clearOutputs reaches the run in flight', () => {
	it('truncates that run`s accumulator and empties the cell', () => {
		const path = 'single.ipynb';
		const id = notebookWithOutput(path);
		const spy = spyAccumulator();
		registry.registerRunOutputs(absPath(path), id, spy.acc);

		nb.clearOutputs(id, path);

		expect(spy.count(), 'the clear did not reach the in-flight run').toBe(1);
		expect(nb.listCells(path).find((c) => c.id === id)?.outputs).toEqual([]);
	});

	it('clears normally when that cell has no run in flight', () => {
		const path = 'idle.ipynb';
		const id = notebookWithOutput(path);

		nb.clearOutputs(id, path);

		expect(nb.listCells(path).find((c) => c.id === id)?.outputs).toEqual([]);
	});

	it('never truncates a DIFFERENT cell`s run', () => {
		const path = 'other.ipynb';
		const cleared = notebookWithOutput(path);
		const running = nb.addCell(cleared, 'code', path, null, 'print("y")');
		const spy = spyAccumulator();
		registry.registerRunOutputs(absPath(path), running.id, spy.acc);

		nb.clearOutputs(cleared, path);

		expect(spy.count()).toBe(0);
	});
});

describe('clearOutputsForCells reaches the run in flight', () => {
	it('truncates the accumulator of each cleared cell', () => {
		// The batch seam every multi-cell caller uses, the agent surface included.
		const path = 'batch.ipynb';
		const first = notebookWithOutput(path);
		const second = nb.addCell(first, 'code', path, null, 'print("y")');
		nb.setOutputs(second.id, [{ output_type: 'stream', name: 'stdout', text: 'also\n' }], path);
		const a = spyAccumulator();
		const b = spyAccumulator();
		registry.registerRunOutputs(absPath(path), first, a.acc);
		registry.registerRunOutputs(absPath(path), second.id, b.acc);

		const cleared = nb.clearOutputsForCells([first, second.id], path);

		expect(cleared).toEqual([first, second.id]);
		expect(a.count(), 'the batch clear did not reach the in-flight run').toBe(1);
		expect(b.count(), 'the batch clear did not reach the in-flight run').toBe(1);
		expect(nb.listCells(path).every((c) => (c.outputs?.length ?? 0) === 0)).toBe(true);
	});

	it('leaves the run of a cell the batch did not name alone', () => {
		const path = 'batch-partial.ipynb';
		const named = notebookWithOutput(path);
		const untouched = nb.addCell(named, 'code', path, null, 'print("y")');
		nb.setOutputs(untouched.id, [{ output_type: 'stream', name: 'stdout', text: 'keep\n' }], path);
		const spy = spyAccumulator();
		registry.registerRunOutputs(absPath(path), untouched.id, spy.acc);

		nb.clearOutputsForCells([named], path);

		expect(spy.count()).toBe(0);
		expect(nb.listCells(path).find((c) => c.id === untouched.id)?.outputs).toHaveLength(1);
	});
});
