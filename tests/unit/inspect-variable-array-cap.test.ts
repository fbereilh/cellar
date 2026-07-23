/**
 * inspect_variable must stay CHEAP when the values are arrays.
 *
 * The reported failure: `inspect_variable('raw')` on a frame whose cells hold
 * arrays returned ten full rows — thousands of tokens of embedding floats — for
 * what was meant to be a look at the shape of the data. A row count alone does
 * not bound a head: ten rows of a 1024-float column is ten thousand numbers.
 *
 * These spawn the REAL probe (`INSPECT_PROBE_HEAD` from `inspect.ts`, the exact
 * string the kernel runs) rather than re-implementing its rules, mirroring
 * `dataflow-load-before-store.test.ts` / `spark-progress.test.ts` — so they can
 * only pass if the code the kernel actually executes behaves as claimed. The
 * pandas cases (the reported one) need pandas in the interpreter and are skipped
 * with the reason IN THE SUITE NAME where it is absent, so a green run can never
 * be mistaken for a verified frame bound; the container/scalar cases run
 * everywhere.
 *
 * Both directions matter and fail oppositely: an unbounded array head is the bug,
 * and a SILENTLY shortened one is worse than the bug (an agent that cannot tell a
 * truncated array from a short one reasons about data that is not there), so the
 * truncation must be marked. A scalar frame must be left exactly as it was.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
	INSPECT_PROBE_HEAD,
	INSPECT_HEAD_ROWS,
	INSPECT_ARRAY_HEAD_ROWS,
	INSPECT_ARRAY_ITEMS,
	INSPECT_STR_CHARS,
	INSPECT_HEAD_BUDGET,
	INSPECT_ARRAY_REPR_CHARS
} from '../../src/lib/server/inspect';

/** Detail objects keyed by variable name, as the probe would print them. */
type Detail = Record<string, unknown>;

/**
 * Run the real probe over a python `setup` block and return `_cellar_inspect`'s
 * verdict for each name. `_cellar_inspect` reads `get_ipython().user_ns` and
 * falls back to `globals()`, which is what the driver's module scope provides.
 */
function inspect(setup: string, names: string[]): Record<string, Detail> {
	const driver = `
${INSPECT_PROBE_HEAD}
import json as _json
${setup}
print(_json.dumps({_n: _cellar_inspect(_n) for _n in ${JSON.stringify(names)}}))
`;
	const stdout = execFileSync('python3', ['-'], { input: driver, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	return JSON.parse(stdout.trim().split('\n').filter(Boolean).at(-1)!);
}

/** The JSON size of one detail — the cost the agent actually pays. */
const cost = (d: Detail) => JSON.stringify(d).length;

const hasPandas = spawnSync('python3', ['-c', 'import pandas, numpy'], { stdio: 'ignore' }).status === 0;

describe('inspect_variable bounds array-valued data', () => {
	it('truncates arrays inside a container and SAYS it did', () => {
		const d = inspect('raw = [[float(i) for i in range(1000)] for _ in range(50)]', ['raw']).raw;
		expect(d.found).toBe(true);
		expect(d.kind).toBe('sequence');
		expect(d.size).toBe(50); // the true length is still reported
		// The sample shrinks because the items are arrays, and says so.
		expect(d.head_truncated).toBe(true);
		expect(String(d.head_note)).toContain(String(INSPECT_ARRAY_HEAD_ROWS));
		expect((d.head as string[]).length).toBe(INSPECT_ARRAY_HEAD_ROWS);
		// The whole answer stays small — this is the point of the change.
		expect(cost(d)).toBeLessThan(2000);
	});

	it('leaves ordinary scalar values exactly as they were', () => {
		const d = inspect(
			[
				'nums = list(range(1000))',
				'text = "hello"',
				'count = 42',
				'mapping = {"a": 1, "b": 2}'
			].join('\n'),
			['nums', 'text', 'count', 'mapping']
		);
		// A flat list is not "array-valued": it still shows the full HEAD_ROWS items,
		// with no truncation notice, exactly as before.
		expect((d.nums.head as string[]).length).toBe(INSPECT_HEAD_ROWS);
		expect(d.nums.head_truncated).toBeUndefined();
		expect(d.text).toMatchObject({ kind: 'scalar', repr: "'hello'" });
		expect(d.count).toMatchObject({ kind: 'scalar', repr: '42' });
		expect(d.mapping).toMatchObject({ kind: 'dict', size: 2, keys: ['a', 'b'] });
		for (const v of Object.values(d)) expect(v.head_truncated).toBeUndefined();
	});

	it('reports a name that is not defined, unchanged', () => {
		expect(inspect('x = 1', ['nope']).nope).toEqual({ found: false, name: 'nope' });
	});
});

describe.skipIf(!hasPandas)('inspect_variable on a real DataFrame' + (hasPandas ? '' : ' (SKIPPED: no pandas in python3)'), () => {
	const FRAMES = [
		'import numpy as np, pandas as pd',
		// The reported case: a frame whose cells are 1024-float embeddings.
		'raw = pd.DataFrame({"id": range(50), "label": ["row-%d" % i for i in range(50)],',
		'                    "embedding": [list(np.arange(1024, dtype=float)) for _ in range(50)]})',
		// The control: an ordinary scalar frame must not move.
		'plain = pd.DataFrame({"a": range(100), "b": ["x"] * 100})',
		// A Series of arrays hits the same trap through a different branch.
		'ser = pd.Series([list(range(1000)) for _ in range(40)])',
		// A text column: one oversized value, not an array.
		'docs = pd.DataFrame({"body": ["y" * 5000] * 30})'
	].join('\n');

	it('bounds an array-valued frame on every axis, and names the bounds', () => {
		const d = inspect(FRAMES, ['raw']).raw;
		expect(d.kind).toBe('dataframe');
		expect(d.shape).toEqual([50, 3]); // the REAL shape, never the sampled one
		expect(d.head_rows).toBe(INSPECT_ARRAY_HEAD_ROWS);
		expect((d.head as unknown[]).length).toBe(INSPECT_ARRAY_HEAD_ROWS);
		expect(d.head_truncated).toBe(true);
		expect(String(d.head_note)).toMatch(/arrays capped at 8 items/);

		const rows = d.head as Array<Record<string, unknown>>;
		for (const row of rows) {
			// Every column survives — a bounded sample must never read as a frame
			// that simply does not have that column.
			expect(Object.keys(row).sort()).toEqual(['embedding', 'id', 'label']);
			const emb = row.embedding as unknown[];
			// The first ARRAY_ITEMS values, then ONE marker naming what was dropped.
			expect(emb.length).toBe(INSPECT_ARRAY_ITEMS + 1);
			expect(emb.slice(0, INSPECT_ARRAY_ITEMS)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
			expect(String(emb.at(-1))).toBe('… 1016 more (1024 total)');
		}
		// The whole answer is now a look at the data, not a dump of it. Unbounded
		// this was ~10 x 1024 floats; the ceiling holds it near the head budget.
		expect(cost(d)).toBeLessThan(INSPECT_HEAD_BUDGET);
		// The repr is a second copy of the same arrays, so it is cut back too.
		expect(d.repr_truncated).toBe(true);
		expect(String(d.repr).length).toBeLessThanOrEqual(INSPECT_ARRAY_REPR_CHARS + 1);
	});

	it('leaves an ordinary scalar frame at the full sample, untouched', () => {
		const d = inspect(FRAMES, ['plain']).plain;
		expect(d.head_rows).toBe(INSPECT_HEAD_ROWS);
		expect((d.head as unknown[]).length).toBe(INSPECT_HEAD_ROWS);
		expect(d.head_truncated).toBeUndefined();
		expect(d.repr_truncated).toBeUndefined();
		expect(d.head).toEqual(Array.from({ length: INSPECT_HEAD_ROWS }, (_, i) => ({ a: i, b: 'x' })));
	});

	it('bounds a Series of arrays through the same rule', () => {
		const d = inspect(FRAMES, ['ser']).ser;
		expect(d.kind).toBe('series');
		expect(d.size).toBe(40);
		expect(d.head_rows).toBe(INSPECT_ARRAY_HEAD_ROWS);
		expect(Object.keys(d.head as object).length).toBe(INSPECT_ARRAY_HEAD_ROWS);
		expect(d.head_truncated).toBe(true);
		expect(cost(d)).toBeLessThan(INSPECT_HEAD_BUDGET);
	});

	it('caps an oversized STRING cell without dropping the column', () => {
		const d = inspect(FRAMES, ['docs']).docs;
		const rows = d.head as Array<Record<string, string>>;
		expect(rows.length).toBe(INSPECT_HEAD_ROWS); // strings are not "arrays": rows stay
		for (const row of rows) expect(row.body.length).toBeLessThanOrEqual(INSPECT_STR_CHARS + 1);
		expect(d.head_truncated).toBe(true);
		expect(cost(d)).toBeLessThan(INSPECT_HEAD_BUDGET);
	});
});
