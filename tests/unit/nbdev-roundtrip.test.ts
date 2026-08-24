/**
 * Ecosystem round-trip: sorted JSON keys + the widened metadata allowlists.
 *
 * THE REGRESSION GUARD for Cellar being the odd one out in the entire Jupyter
 * ecosystem. `nbformat` — the reference writer behind JupyterLab, Jupyter
 * Notebook, nbconvert and papermill — writes `sort_keys=True, indent=1`, and
 * fastcore/nbdev's writer (`fastcore/nbio.py`) writes
 * `sort_keys=True, indent=1, ensure_ascii=False` plus a trailing newline. Cellar
 * wrote INSERTION order, so any notebook touched by both Cellar and Jupyter
 * churned 100% of its lines.
 *
 * Measured over nbdev's own 33 notebooks (nbdev 3.3.12, git HEAD 44a6bdf), driving
 * Cellar's real save pipeline — the exact calls `writeNotebook` makes:
 *
 *   before:  31 files changed, 2278 insertions(+), 2350 deletions(-)
 *   after:    8 files changed,    8 insertions(+),   78 deletions(-)
 *
 * and the generated library was unchanged in both cases. The residual 86 lines are
 * `metadata.solveit` alone, a key nbdev's OWN default also strips (it survives in
 * nbdev's repo only because nbdev's `pyproject.toml` opts in via
 * `allowed_metadata_keys`) — so Cellar now matches nbdev's default behavior. That
 * is asserted below rather than left as prose.
 *
 * The byte-level claim is checked AGAINST PYTHON'S OWN WRITER rather than by
 * eyeballing key order: "the keys are sorted" is a much weaker statement than
 * "these bytes are what the ecosystem would have written".
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cleanNotebook, ALLOWED_CELL_METADATA, ALLOWED_NB_METADATA } from '../../src/lib/server/clean';
import { serialize, deserialize, stringify } from '../../src/lib/server/ipynb';

/** `python3` is stdlib-only here (`json`), so this needs no venv and no package. */
function pythonAvailable(): boolean {
	try {
		execFileSync('python3', ['-c', 'import json'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}
const HAS_PY = pythonAvailable();

/** What `nbformat`/fastcore would write for the same object. */
function pythonWrites(obj: unknown): string {
	return execFileSync(
		'python3',
		['-c', 'import json,sys; print(json.dumps(json.load(sys.stdin), sort_keys=True, indent=1, ensure_ascii=False))'],
		{ input: JSON.stringify(obj), encoding: 'utf8' }
	);
}

describe('stringify — sorted keys (the ecosystem convention)', () => {
	it('sorts keys recursively, through arrays and nested objects', () => {
		const out = stringify({ z: 1, a: { d: 4, b: [{ y: 1, x: 2 }] } });
		expect(out).toBe(
			['{', ' "a": {', '  "b": [', '   {', '    "x": 2,', '    "y": 1', '   }', '  ],', '  "d": 4', ' },', ' "z": 1', '}', ''].join('\n')
		);
	});

	it('keeps 1-space indent and the trailing newline', () => {
		const out = stringify({ b: 1, a: 2 });
		expect(out.endsWith('}\n')).toBe(true);
		expect(out).toContain('\n "a": 2,');
	});

	it('orders a serialized cell the way the ecosystem does', () => {
		const nb = serialize({
			cells: [{ id: 'c1', cell_type: 'code', source: 'x = 1', outputs: [], metadata: {} }]
		} as never);
		const keys = Object.keys(JSON.parse(stringify(nb)).cells[0]);
		// nbformat emits exactly this order for a code cell.
		expect(keys).toEqual(['cell_type', 'execution_count', 'id', 'metadata', 'outputs', 'source']);
	});

	it('leaves arrays in order — sorting is for OBJECT keys only', () => {
		expect(JSON.parse(stringify({ a: [3, 1, 2] })).a).toEqual([3, 1, 2]);
	});

	it('is still deterministic and idempotent across a write→read→write cycle', () => {
		const doc = {
			metadata: { kernelspec: { name: 'python3', display_name: 'python3', language: 'python' } },
			cells: [{ id: 'c1', cell_type: 'code', source: 'x = 1\ny = 2', outputs: [], metadata: {} }]
		} as never;
		const first = stringify(serialize(doc));
		const second = stringify(serialize(deserialize(JSON.parse(first)) as never));
		expect(second).toBe(first);
	});

	it.skipIf(!HAS_PY)('writes BYTE-IDENTICAL output to python\'s json.dumps(sort_keys=True, indent=1)', () => {
		// A notebook shaped like a real one: nested metadata, unicode, an output
		// bundle, and keys deliberately supplied out of order.
		const nb = {
			nbformat: 4,
			nbformat_minor: 5,
			metadata: { kernelspec: { name: 'python3', language: 'python', display_name: 'python3' } },
			cells: [
				{
					source: ['# héllo ünicode ✓\n', 'x = 1'],
					id: 'c1',
					cell_type: 'code',
					execution_count: null,
					metadata: { cellar: { export: true, hide_input: false } },
					outputs: [{ output_type: 'stream', text: ['ok\n'], name: 'stdout' }]
				},
				{ source: ['# Title'], metadata: {}, id: 'c2', cell_type: 'markdown' }
			]
		};
		expect(stringify(nb)).toBe(pythonWrites(nb));
	});

	it.skipIf(!HAS_PY)('agrees with python on unicode: literal characters, never \\u escapes', () => {
		const nb = { a: 'héllo ✓ 日本語', b: 'x' };
		expect(stringify(nb)).toBe(pythonWrites(nb));
		expect(stringify(nb)).toContain('日本語');
	});
});

describe('metadata allowlists — foreign keys the ecosystem defines', () => {
	/** A notebook carrying nbdev metadata directives in BOTH scopes. */
	function nbdevNotebook(): any {
		return {
			nbformat: 4,
			nbformat_minor: 5,
			metadata: {
				kernelspec: { name: 'python3', display_name: 'python3', language: 'python' },
				nbdev: { default_exp: 'metacore' },
				jupytext: { formats: 'ipynb,py:percent' },
				widgets: { 'application/vnd.jupyter.widget-state+json': { state: {} } },
				doc: { title: 'x' },
				jekyll: { layout: 'p' },
				language_info: { name: 'python', version: '3.11.4' },
				solveit: { ver: 2 }
			},
			cells: [
				{
					cell_type: 'code',
					id: 'c1',
					execution_count: 1,
					source: ['import os'],
					metadata: { nbdev: { export: 'true' }, hide_input: true, collapsed: true, solveit_ai: { x: 1 } },
					outputs: []
				}
			]
		};
	}

	it('preserves an nbdev metadata directive in BOTH scopes (a save is no longer silently fatal)', () => {
		// Since nbdev 3.3.0 a directive may live in metadata: `{"export": "true"}` is
		// exactly `#| export`. Dropping it made a Cellar save destroy the build with
		// no error - `nbdev-export` afterwards generated nothing, exit 0.
		const cleaned: any = cleanNotebook(nbdevNotebook());
		expect(cleaned.metadata.nbdev).toEqual({ default_exp: 'metacore' });
		expect(cleaned.cells[0].metadata.nbdev).toEqual({ export: 'true' });
	});

	it('preserves the rest of nbdev\'s base notebook keys, and still drops language_info', () => {
		const cleaned: any = cleanNotebook(nbdevNotebook());
		expect(Object.keys(cleaned.metadata).sort()).toEqual(['doc', 'jekyll', 'jupytext', 'kernelspec', 'nbdev', 'widgets']);
		expect(cleaned.metadata.language_info).toBeUndefined();
	});

	it('preserves a cell\'s bare hide_input (Jupyter\'s key, distinct from cellar.hide_input)', () => {
		const cleaned: any = cleanNotebook(nbdevNotebook());
		expect(cleaned.cells[0].metadata.hide_input).toBe(true);
	});

	it('still denies by default — a key outside the named lists is dropped in both scopes', () => {
		// The lists are FIXED and NAMED, not a relaxation of the policy. `solveit` /
		// `solveit_ai` are nbdev's own PROJECT config (`allowed_*_metadata_keys` in its
		// pyproject.toml), not an ecosystem standard, so Cellar drops them - which is
		// exactly what nbdev's own default does too.
		const cleaned: any = cleanNotebook(nbdevNotebook());
		expect(cleaned.metadata.solveit).toBeUndefined();
		expect(cleaned.cells[0].metadata.solveit_ai).toBeUndefined();
		expect(cleaned.cells[0].metadata.collapsed).toBeUndefined();
	});

	it('matches nbdev\'s CURRENT base allowlists exactly, plus Cellar\'s own keys', () => {
		// nbdev/clean.py 3.3.12:
		//   metadata_keys      = {"kernelspec","jekyll","jupytext","doc","widgets","nbdev"}
		//   cell_metadata_keys = {"hide_input","nbdev"}
		const NBDEV_NB = ['kernelspec', 'jekyll', 'jupytext', 'doc', 'widgets', 'nbdev'];
		const NBDEV_CELL = ['hide_input', 'nbdev'];
		for (const k of NBDEV_NB) expect(ALLOWED_NB_METADATA).toContain(k);
		for (const k of NBDEV_CELL) expect(ALLOWED_CELL_METADATA).toContain(k);
		// Cellar adds only its own namespace on top - nothing else crept in.
		expect([...ALLOWED_NB_METADATA].sort()).toEqual([...NBDEV_NB, 'cellar'].sort());
		expect([...ALLOWED_CELL_METADATA].sort()).toEqual([...NBDEV_CELL, 'cellar'].sort());
	});

	it('is idempotent — cleaning an already-clean nbdev notebook changes nothing', () => {
		const once = cleanNotebook(nbdevNotebook());
		expect(stringify(cleanNotebook(once as never))).toBe(stringify(once));
	});

	it('round-trips an nbdev notebook through the real save pipeline unchanged', () => {
		// deserialize -> serialize -> stringify, the exact calls writeNotebook makes.
		const onDisk = JSON.parse(stringify(cleanNotebook(nbdevNotebook())));
		const saved = stringify(serialize(deserialize(onDisk) as never));
		expect(saved).toBe(stringify(onDisk));
	});
});
