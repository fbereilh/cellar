import { describe, it, expect, beforeEach } from 'vitest';
import { cleanNotebook, cleanMetrics, resetCleanMetrics } from '../../src/lib/server/clean';
import { serialize, stringify } from '../../src/lib/server/ipynb';
import type { Cell, NotebookMetadata } from '../../src/lib/server/types';

/**
 * Perf/resilience Tier 2: the save/clean path is SURGICAL, not a whole-notebook
 * deep clone.
 *
 * A keystroke-triggered source autosave must not pay to copy every output blob
 * it never touched, must not mutate the live document the UI is bound to, and
 * must still produce byte-identical output to a full clean+serialize (the
 * git-clean / zero-diff promise). These tests pin all four properties.
 */

const DATAFRAME_MIME = 'application/vnd.cellar.dataframe+json';
const META: NotebookMetadata = {
	kernelspec: { name: 'python3', display_name: 'python3', language: 'python' }
};

/** A code cell carrying a large image blob + a plain stream, none of which clean rewrites. */
function bigBlob(): string {
	return 'iVBORw0KGgo' + 'A'.repeat(100_000);
}

function docWithImage(): { cells: Cell[]; metadata: NotebookMetadata } {
	return {
		metadata: META,
		cells: [
			{
				id: 'c1',
				cell_type: 'code',
				source: 'plot()',
				outputs: [
					{ output_type: 'display_data', data: { 'image/png': bigBlob(), 'text/plain': '<Figure>' }, metadata: {} },
					{ output_type: 'stream', name: 'stdout', text: 'rendered\n' }
				] as unknown as Cell['outputs'],
				metadata: {}
			},
			{ id: 'c2', cell_type: 'markdown', source: '# Title', outputs: [], metadata: {} }
		]
	};
}

/** A code cell whose outputs DO get rewritten by clean (exec count + live-only mimes). */
function docWithRewrites(): { cells: Cell[]; metadata: NotebookMetadata } {
	return {
		metadata: META,
		cells: [
			{
				id: 'c1',
				cell_type: 'code',
				source: 'df',
				outputs: [
					{
						output_type: 'execute_result',
						execution_count: 3,
						data: { 'text/plain': 'df repr', [DATAFRAME_MIME]: { columns: ['a'], data: [[1]] } },
						metadata: {}
					}
				] as unknown as Cell['outputs'],
				metadata: {}
			}
		]
	};
}

beforeEach(() => resetCleanMetrics());

describe('surgical clone — no whole-notebook deep copy', () => {
	it('reuses an unmodified output BY REFERENCE (blob never duplicated)', () => {
		const doc = docWithImage();
		const s = serialize(doc) as unknown as { cells: Array<{ outputs: any[] }> };
		// The display_data output is not rewritten by clean, so the same object —
		// and therefore the same multi-MB blob — is reused, not cloned.
		expect(s.cells[0].outputs[0]).toBe(doc.cells[0].outputs![0]);
		expect(s.cells[0].outputs[0].data['image/png']).toBe(
			(doc.cells[0].outputs![0] as any).data['image/png']
		);
		expect(s.cells[0].outputs[1]).toBe(doc.cells[0].outputs![1]);
		// Zero output wrappers were copied for a fully-unmodified outputs array.
		expect(cleanMetrics.outputsCopied).toBe(0);
	});

	it('copies ONLY the outputs clean rewrites (exec count), sharing the data bundle', () => {
		const doc = docWithRewrites();
		const s = serialize(doc) as unknown as { cells: Array<{ outputs: any[] }> };
		// Exactly one output wrapper copied (the execute_result whose count is nulled).
		expect(cleanMetrics.outputsCopied).toBe(1);
		// The cleaned wrapper is a copy…
		expect(s.cells[0].outputs[0]).not.toBe(doc.cells[0].outputs![0]);
		// …but the surviving text/plain blob is shared by reference (data bundle copied,
		// its values not).
		expect(s.cells[0].outputs[0].data['text/plain']).toBe(
			(doc.cells[0].outputs![0] as any).data['text/plain']
		);
	});
});

describe('source-only save — outputs reused, not re-cleaned', () => {
	it('a re-save with the SAME outputs array is a cache hit (no re-clone)', () => {
		const doc = docWithImage();
		const s1 = serialize(doc) as unknown as { cells: Array<{ outputs: any[] }> };
		const s2 = serialize(doc) as unknown as { cells: Array<{ outputs: any[] }> };
		// First save cleaned the array once; the second (source-only) save reused it.
		expect(cleanMetrics.outputArraysCleaned).toBe(1);
		expect(cleanMetrics.outputArrayCacheHits).toBe(1);
		// The very same cleaned outputs array object is handed back — nothing re-cloned.
		expect(s1.cells[0].outputs).toBe(s2.cells[0].outputs);
	});

	it('reused cleaned outputs are byte-identical to a fully-independent clean+serialize', () => {
		const doc = docWithRewrites();
		// A deep-cloned copy has entirely independent arrays/objects (no reference reuse),
		// so identical bytes prove the surgical path did not alter what lands on disk.
		const independent = structuredClone(doc);
		expect(stringify(serialize(doc))).toBe(stringify(serialize(independent)));
	});
});

describe('the live document is never mutated by clean', () => {
	it('leaves the live outputs (exec count + live-only DataFrame mime) intact', () => {
		const doc = docWithRewrites();
		const liveBefore = structuredClone(doc.cells[0].outputs);
		const s = serialize(doc) as unknown as { cells: Array<{ outputs: any[] }> };

		// Clean stripped them ON DISK…
		expect(s.cells[0].outputs[0].execution_count).toBeNull();
		expect(s.cells[0].outputs[0].data[DATAFRAME_MIME]).toBeUndefined();

		// …but the live doc the UI binds to is untouched: the grid still renders and
		// the original execution_count survives.
		expect(doc.cells[0].outputs).toEqual(liveBefore);
		expect((doc.cells[0].outputs![0] as any).execution_count).toBe(3);
		expect((doc.cells[0].outputs![0] as any).data[DATAFRAME_MIME]).toBeDefined();
	});

	it('cleanNotebook does not mutate its raw input notebook object', () => {
		const nb: any = {
			nbformat: 4,
			nbformat_minor: 5,
			metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } },
			cells: [
				{ cell_type: 'code', id: 'c1', execution_count: 5, source: ['x'], outputs: [
					{ output_type: 'execute_result', execution_count: 5, data: { 'text/plain': 'v' }, metadata: {} }
				], metadata: {} }
			]
		};
		const before = JSON.stringify(nb);
		cleanNotebook(nb);
		expect(JSON.stringify(nb)).toBe(before);
	});
});

describe('output-changing save — recompute, correct new outputs', () => {
	it('a NEW outputs array (run-end persist) misses the cache and re-cleans', () => {
		const doc = docWithImage();
		const s1 = serialize(doc) as unknown as { cells: Array<{ outputs: any[] }> };

		// Simulate a run end: setOutputs installs a fresh array (see run.ts).
		doc.cells[0].outputs = [
			{ output_type: 'stream', name: 'stdout', text: 'new result\n' },
			{ output_type: 'execute_result', execution_count: 9, data: { 'text/plain': '42' }, metadata: {} }
		] as unknown as Cell['outputs'];

		resetCleanMetrics();
		const s2 = serialize(doc) as unknown as { cells: Array<{ outputs: any[] }> };

		expect(cleanMetrics.outputArraysCleaned).toBe(1); // new array → miss → recompute
		expect(cleanMetrics.outputArrayCacheHits).toBe(0);
		expect(s1.cells[0].outputs).not.toBe(s2.cells[0].outputs);
		// The new outputs are persisted correctly (and cleaned: exec count nulled).
		expect(s2.cells[0].outputs[0].text).toBe('new result\n');
		expect(s2.cells[0].outputs[1].data['text/plain']).toBe('42');
		expect(s2.cells[0].outputs[1].execution_count).toBeNull();
	});
});

describe('zero-diff — re-saving an unchanged notebook', () => {
	it('yields byte-identical output', () => {
		const doc = docWithImage();
		expect(stringify(serialize(doc))).toBe(stringify(serialize(doc)));
	});

	it('is byte-identical for a rewrite-heavy notebook too', () => {
		const doc = docWithRewrites();
		expect(stringify(serialize(doc))).toBe(stringify(serialize(doc)));
	});
});
