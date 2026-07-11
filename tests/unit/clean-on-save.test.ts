import { describe, it, expect } from 'vitest';
import { cleanNotebook, scrubAddresses, stripRuntimeMeta, ALLOWED_CELL_METADATA, ALLOWED_NB_METADATA } from '../../src/lib/server/clean';
import { serialize, deserialize, stringify } from '../../src/lib/server/ipynb';
import type { Cell, NotebookMetadata } from '../../src/lib/server/types';

/**
 * Crown-jewel test: clean-on-save is correct AND idempotent.
 *
 * Cellar's central promise is a git-clean `.ipynb`: an identical re-run must
 * produce byte-identical bytes, hand-editable notebooks cannot forge run state,
 * and per-machine / volatile fields never reach disk. These tests pin every
 * rule in `clean.ts` + the (de)serialization round-trip in `ipynb.ts`.
 */

/**
 * A deliberately-messy nbformat notebook, as if freshly read from a kernel.
 * Typed `any` on purpose: it carries fields the clean policy is meant to strip
 * or repair (partial run-stamps, non-allowlisted metadata, address reprs), so it
 * does not — and should not — satisfy the strict on-disk types.
 */
function messyNotebook(): any {
	return {
		nbformat: 4,
		nbformat_minor: 5,
		metadata: {
			kernelspec: { name: 'python3', display_name: 'Python 3 (ipykernel)', language: 'python' },
			// Volatile / per-machine metadata that MUST be dropped.
			language_info: { name: 'python', version: '3.11.4', mimetype: 'text/x-python' },
			widgets: { 'application/vnd.jupyter.widget-state+json': { state: {} } }
		},
		cells: [
			{
				cell_type: 'code',
				id: 'cell-a',
				execution_count: 7,
				source: ['x = object()\n', 'x'],
				metadata: {
					cellar: { extract: false, visible: true, lastRun: { at: 123, session: 1 }, editedAt: 999 },
					// Non-allowlisted cell metadata that MUST be dropped.
					collapsed: true,
					scrolled: false,
					trusted: true
				},
				outputs: [
					{
						output_type: 'execute_result',
						execution_count: 7,
						data: { 'text/plain': '<object object at 0x7f9a1c0b2d40>' },
						metadata: {}
					},
					{
						output_type: 'stream',
						name: 'stdout',
						text: 'obj repr <foo.Bar at 0x105f3e2b0> done\n'
					},
					{
						output_type: 'display_data',
						data: {
							'text/plain': '<Figure size 640x480 with 1 Axes>',
							'image/png': 'iVBORw0KGgo=',
							// Live-only DataFrame grid payload that MUST be stripped.
							'application/vnd.cellar.dataframe+json': { columns: ['a'], data: [[1]] }
						},
						metadata: {}
					}
				]
			},
			{
				cell_type: 'markdown',
				id: 'cell-b',
				source: ['# Heading\n', 'body'],
				metadata: { cellar: { visible: true } }
			}
		]
	};
}

describe('cleanNotebook — correctness', () => {
	it('nulls every execution_count (cell level + inside outputs)', () => {
		const cleaned = cleanNotebook(messyNotebook());
		const code = cleaned.cells[0] as any;
		expect(code.execution_count).toBeNull();
		expect(code.outputs[0].execution_count).toBeNull();
	});

	it('keeps outputs (deny-by-default is a metadata policy, not an output policy)', () => {
		const cleaned = cleanNotebook(messyNotebook());
		const outputs = (cleaned.cells[0] as any).outputs;
		expect(outputs).toHaveLength(3);
		// The image survives; only the live-only grid mime is stripped.
		expect(outputs[2].data['image/png']).toBe('iVBORw0KGgo=');
		expect(outputs[2].data['application/vnd.cellar.dataframe+json']).toBeUndefined();
	});

	it('enforces the notebook-metadata allowlist (drops language_info + widgets)', () => {
		const cleaned = cleanNotebook(messyNotebook());
		expect(Object.keys(cleaned.metadata).sort()).toEqual(['kernelspec']);
		expect((cleaned.metadata as any).language_info).toBeUndefined();
		expect((cleaned.metadata as any).widgets).toBeUndefined();
		expect(ALLOWED_NB_METADATA).toContain('kernelspec');
	});

	it('enforces the cell-metadata allowlist (keeps only the cellar namespace)', () => {
		const cleaned = cleanNotebook(messyNotebook());
		const md = (cleaned.cells[0] as any).metadata;
		expect(Object.keys(md)).toEqual(['cellar']);
		expect(md.collapsed).toBeUndefined();
		expect(md.trusted).toBeUndefined();
		expect(ALLOWED_CELL_METADATA).toEqual(['cellar']);
	});

	it('strips runtime-only cellar keys (lastRun, editedAt) but keeps durable ones', () => {
		const cleaned = cleanNotebook(messyNotebook());
		const cellar = (cleaned.cells[0] as any).metadata.cellar;
		expect(cellar.lastRun).toBeUndefined();
		expect(cellar.editedAt).toBeUndefined();
		expect(cellar.visible).toBe(true);
		expect(cellar.extract).toBe(false);
	});

	it('normalizes kernelspec.display_name → name', () => {
		const cleaned = cleanNotebook(messyNotebook());
		const ks = (cleaned.metadata as any).kernelspec;
		expect(ks.display_name).toBe('python3');
		expect(ks.name).toBe('python3');
	});

	it('scrubs <… at 0x…> memory addresses in stream text and text/plain', () => {
		const cleaned = cleanNotebook(messyNotebook());
		const outputs = (cleaned.cells[0] as any).outputs;
		expect(outputs[0].data['text/plain']).toBe('<object object>');
		expect(outputs[1].text).toBe('obj repr <foo.Bar> done\n');
	});

	it('does not mutate its input (works on a deep copy)', () => {
		const nb = messyNotebook();
		const before = JSON.stringify(nb);
		cleanNotebook(nb);
		expect(JSON.stringify(nb)).toBe(before);
	});

	it('is idempotent — cleaning an already-clean notebook is a no-op', () => {
		const once = cleanNotebook(messyNotebook());
		const twice = cleanNotebook(once);
		expect(twice).toEqual(once);
	});
});

describe('scrubAddresses / stripRuntimeMeta helpers', () => {
	it('scrubs across strings and string arrays, leaves clean text untouched', () => {
		expect(scrubAddresses('<X at 0xdeadbeef>')).toBe('<X>');
		expect(scrubAddresses(['a <Y at 0x1> b', 'no addr'])).toEqual(['a <Y> b', 'no addr']);
		expect(scrubAddresses('plain text')).toBe('plain text');
	});

	it('drops an emptied cellar namespace so foreign cells stay byte-identical', () => {
		expect(stripRuntimeMeta({ cellar: { lastRun: { at: 1, session: 1 } } } as any)).toEqual({});
		expect(stripRuntimeMeta({})).toEqual({});
		expect(stripRuntimeMeta(undefined)).toEqual({});
	});
});

describe('serialize/deserialize round-trip — the git-clean promise', () => {
	const metadata: NotebookMetadata = {
		kernelspec: { name: 'python3', display_name: 'python3', language: 'python' }
	};

	function doc(): { cells: Cell[]; metadata: NotebookMetadata } {
		return {
			metadata,
			cells: [
				{
					id: 'c1',
					cell_type: 'code',
					source: 'x = 1\nx + 1',
					outputs: [
						{
							output_type: 'execute_result',
							execution_count: 3,
							data: { 'text/plain': '2' },
							metadata: {}
						}
					] as any,
					metadata: { cellar: { extract: false, visible: true, lastRun: { at: 1, durationMs: 2, actor: 'user', status: 'ok', session: 1 } } }
				},
				{ id: 'c2', cell_type: 'markdown', source: '# Title', outputs: [], metadata: {} }
			]
		};
	}

	it('produces identical bytes on an identical re-run (zero git diff)', () => {
		const a = stringify(serialize(doc()));
		const b = stringify(serialize(doc()));
		expect(a).toBe(b);
	});

	it('is stable across a full write→read→write cycle', () => {
		const first = stringify(serialize(doc()));
		// Simulate reading the file back and re-serializing (what a re-save does).
		const reparsed = deserialize(JSON.parse(first));
		const second = stringify(serialize(reparsed));
		expect(second).toBe(first);
	});

	it('never persists the runtime run-stamp (lastRun) to bytes', () => {
		const bytes = stringify(serialize(doc()));
		expect(bytes).not.toContain('lastRun');
		expect(bytes).not.toContain('session');
	});

	it('deserialize strips runtime meta so a hand-edited file cannot forge ran-this-session', () => {
		const forged = {
			metadata,
			cells: [
				{
					id: 'c1',
					cell_type: 'code',
					source: 'x',
					outputs: [],
					metadata: { cellar: { visible: true, lastRun: { at: 1, session: 42 } } }
				}
			]
		};
		const { cells } = deserialize(forged as any);
		expect(cells[0].metadata?.cellar?.lastRun).toBeUndefined();
		expect(cells[0].metadata?.cellar?.visible).toBe(true);
	});

	it('round-trips nbformat multiline source without introducing a diff', () => {
		// A HEAD file stores source as a \n-terminated line array; our canonical
		// form is a single string. The cycle must be lossless.
		const d = doc();
		const nb = serialize(d);
		expect((nb.cells[0] as any).source).toEqual(['x = 1\n', 'x + 1']);
		const back = deserialize(JSON.parse(stringify(nb)));
		expect(back.cells[0].source).toBe('x = 1\nx + 1');
	});
});
