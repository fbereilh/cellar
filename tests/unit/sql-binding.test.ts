/**
 * SQL cells: the `-- >> name` result binding, and the staleness graph edges it buys.
 *
 * A SQL cell's result used to land ONLY in the hardcoded `_sql_df`, which is
 * last-write-wins: two SQL cells and the second clobbers the first. A cell may now
 * open with a `-- >> sales_df` prefix line to name its own (stable) binding. Two
 * halves are tested here because they must not drift apart:
 *
 *   1. `sql.ts` — parse the prefix line, strip it from the query, validate the name
 *      (it is interpolated into generated Python), and keep the no-prefix path
 *      byte-for-byte as it was, so existing notebooks are unmoved.
 *   2. `dataflow.ts` — a SQL cell never reaches the `symtable` probe (its source is
 *      SQL), so it gets a SYNTHETIC `defines` of exactly the names `sql.ts` binds.
 *      Without it a Python cell reading a SQL result has no upstream edge and never
 *      goes stale when the query is edited — the bug this closes.
 */
import { describe, it, expect, vi } from 'vitest';
import { parseSqlCell, sqlToPython, SQL_RESULT_VAR, SQL_ROW_CAP } from '../../src/lib/server/sql';
import { computeStaleness } from '../../src/lib/staleness';
import type { CellView } from '../../src/lib/server/types';

// The probe spawns the project interpreter; `null` ⇒ the real `python3`. SQL cells
// never reach it, but the Python cells in the staleness test do.
vi.mock('../../src/lib/server/databricks', () => ({ projectPython: () => null }));
import { analyzeDataflow } from '../../src/lib/server/dataflow';

const sqlCell = (id: string, source: string, extra: Record<string, unknown> = {}): CellView =>
	({
		id,
		cell_type: 'code',
		source,
		outputs: [],
		metadata: { cellar: { language: 'sql', ...extra } }
	}) as unknown as CellView;

const pyCell = (id: string, source: string, extra: Record<string, unknown> = {}): CellView =>
	({ id, cell_type: 'code', source, outputs: [], metadata: { cellar: { ...extra } } }) as unknown as CellView;

describe('parseSqlCell — the prefix line', () => {
	it('parses the name and strips the line from the query', () => {
		const b = parseSqlCell('-- >> sales_df\nSELECT * FROM sales');
		expect(b.boundVar).toBe('sales_df');
		expect(b.query).toBe('SELECT * FROM sales');
		expect(b.error).toBeNull();
	});

	it('binds the named var AND keeps _sql_df as the documented last-result alias', () => {
		expect(parseSqlCell('-- >> sales_df\nSELECT 1').resultVars).toEqual(['sales_df', '_sql_df']);
	});

	it('tolerates whitespace around the marker and the name', () => {
		expect(parseSqlCell('  --  >>   sales_df  \nSELECT 1').boundVar).toBe('sales_df');
	});

	it('finds the prefix line past leading blank lines', () => {
		const b = parseSqlCell('\n\n-- >> sales_df\nSELECT 1');
		expect(b.boundVar).toBe('sales_df');
		expect(b.query).toBe('SELECT 1');
	});

	it('only reads the FIRST non-blank line — a later marker stays an ordinary SQL comment', () => {
		const b = parseSqlCell('SELECT 1\n-- >> not_a_binding');
		expect(b.boundVar).toBeNull();
		expect(b.query).toBe('SELECT 1\n-- >> not_a_binding');
	});

	it('a cell with no prefix line keeps the legacy _sql_df binding', () => {
		const b = parseSqlCell('SELECT * FROM sales');
		expect(b.boundVar).toBeNull();
		expect(b.resultVars).toEqual([SQL_RESULT_VAR]);
		expect(b.error).toBeNull();
	});

	it('an empty cell binds nothing', () => {
		expect(parseSqlCell('').resultVars).toEqual([]);
		expect(parseSqlCell('-- >> sales_df\n   ').resultVars).toEqual([]);
	});

	it('de-duplicates an explicit `-- >> _sql_df`', () => {
		expect(parseSqlCell('-- >> _sql_df\nSELECT 1').resultVars).toEqual(['_sql_df']);
	});
});

describe('parseSqlCell — name validation (the name is interpolated into Python)', () => {
	const rejects = (source: string) => {
		const b = parseSqlCell(source);
		expect(b.error).toBeTruthy();
		expect(b.boundVar).toBeNull();
		expect(b.resultVars).toEqual([]);
		return b.error as string;
	};

	it('rejects a name that is not a legal identifier', () => {
		expect(rejects('-- >> 2fast\nSELECT 1')).toMatch(/not a valid Python variable name/);
		expect(rejects('-- >> sales-df\nSELECT 1')).toMatch(/not a valid Python variable name/);
		expect(rejects('-- >> df.x\nSELECT 1')).toMatch(/not a valid Python variable name/);
	});

	it('rejects a Python keyword', () => {
		expect(rejects('-- >> class\nSELECT 1')).toMatch(/is a Python keyword/);
		expect(rejects('-- >> None\nSELECT 1')).toMatch(/is a Python keyword/);
	});

	it('accepts a soft keyword, which is a legal Python name', () => {
		expect(parseSqlCell('-- >> match\nSELECT 1').boundVar).toBe('match');
	});

	it('rejects a name Cellar binds in the kernel, so a cell cannot destroy the session', () => {
		expect(rejects('-- >> spark\nSELECT 1')).toMatch(/`spark` is reserved.*the live Spark session/);
		expect(rejects('-- >> w\nSELECT 1')).toMatch(/`w` is reserved.*WorkspaceClient/);
	});

	it('a reserved name fails the cell instead of rebinding spark', () => {
		for (const bad of ['-- >> spark\nSELECT 1', '-- >> w\nSELECT 1']) {
			const py = sqlToPython(bad);
			expect(py.startsWith('raise RuntimeError(')).toBe(true);
			expect(py).not.toContain('spark.sql');
			expect(py).toContain('is reserved');
		}
	});

	it('rejects an empty name and a multi-word tail', () => {
		expect(rejects('-- >>\nSELECT 1')).toMatch(/names no variable/);
		expect(rejects('-- >> a b\nSELECT 1')).toMatch(/exactly ONE variable/);
	});

	it('refuses an injection attempt rather than quoting it', () => {
		const hostile = '-- >> x = 1; import os; os.system("rm -rf /")\nSELECT 1';
		expect(rejects(hostile)).toMatch(/exactly ONE variable/);
		// The whole compiled cell is ONE `raise` statement: the hostile text survives
		// only INSIDE that message's string literal (JSON.stringify is a valid Python
		// str literal for any input), never as code, and nothing else executes.
		const py = sqlToPython(hostile);
		expect(py.split('\n').filter(Boolean)).toHaveLength(1);
		expect(py.startsWith('raise RuntimeError("')).toBe(true);
		expect(py.trimEnd().endsWith('")')).toBe(true);
		expect(py).not.toContain('spark.sql');
	});

	it('every rejection says how to fix it', () => {
		for (const bad of ['-- >>\nSELECT 1', '-- >> 2fast\nSELECT 1', '-- >> class\nSELECT 1']) {
			expect(parseSqlCell(bad).error).toMatch(/-- >> <name>/);
		}
	});
});

describe('sqlToPython — generated code', () => {
	it('binds the named var, aliases _sql_df, and displays the capped pandas frame', () => {
		const py = sqlToPython('-- >> sales_df\nSELECT * FROM sales');
		expect(py).toContain('sales_df = spark.sql("SELECT * FROM sales")');
		expect(py).toContain('_sql_df = sales_df'); // the lazy Spark DF, not the pandas one
		expect(py).toContain(`sales_df.limit(${SQL_ROW_CAP}).toPandas()`);
		expect(py).toContain('except NameError:'); // the spark guard survives
	});

	it('never sends the prefix line to spark.sql', () => {
		const py = sqlToPython('-- >> sales_df\nSELECT * FROM sales');
		const literal = /spark\.sql\((".*?")\)/.exec(py)?.[1] as string;
		expect(JSON.parse(literal)).toBe('SELECT * FROM sales');
		expect(JSON.parse(literal)).not.toContain('>>');
	});

	it('no prefix line ⇒ today\'s exact output (existing notebooks unmoved)', () => {
		expect(sqlToPython('SELECT * FROM sales')).toBe(
			[
				'try:',
				'    spark',
				'except NameError:',
				'    raise RuntimeError("No Spark session is connected. Open the Databricks panel in the Cellar sidebar and connect a cluster to run SQL cells.") from None',
				'_sql_df = spark.sql("SELECT * FROM sales")',
				`_sql_df.limit(${SQL_ROW_CAP}).toPandas()`,
				''
			].join('\n')
		);
	});

	it('emits no self-assigning alias for an explicit `-- >> _sql_df`', () => {
		expect(sqlToPython('-- >> _sql_df\nSELECT 1')).not.toContain('_sql_df = _sql_df');
	});

	it('still strips a trailing semicolon under a prefix line', () => {
		expect(sqlToPython('-- >> df\nSELECT 1;')).toContain('df = spark.sql("SELECT 1")');
	});

	it('an empty cell compiles to nothing', () => {
		expect(sqlToPython('')).toBe('');
		expect(sqlToPython('-- >> df\n')).toBe('');
	});

	it('binds exactly the names parseSqlCell reports, for a non-default resultVar too', () => {
		// The staleness graph is told `resultVars` and nothing else, so a name the code
		// binds but the parse omits would be an edge the graph never sees.
		const bindings = (py: string) =>
			py
				.split('\n')
				.map((l) => /^([A-Za-z_][A-Za-z0-9_]*) = /.exec(l)?.[1])
				.filter(Boolean);

		for (const source of ['SELECT 1', '-- >> sales_df\nSELECT 1', '-- >> foo\nSELECT 1']) {
			for (const resultVar of [undefined, 'foo']) {
				const opts = resultVar ? { resultVar } : {};
				expect(bindings(sqlToPython(source, opts))).toEqual(parseSqlCell(source, resultVar).resultVars);
			}
		}
	});

	it('an unusable name fails the cell instead of emitting broken Python', () => {
		const py = sqlToPython('-- >> class\nSELECT 1');
		expect(py.startsWith('raise RuntimeError(')).toBe(true);
		expect(py).not.toContain('spark.sql');
		expect(py).toContain('is a Python keyword');
	});
});

describe('analyzeDataflow — synthetic defines for SQL cells', () => {
	it('a SQL cell defines its bound names and uses nothing', async () => {
		const df = await analyzeDataflow([
			sqlCell('a', '-- >> sales_df\nSELECT * FROM sales'),
			sqlCell('b', 'SELECT * FROM other')
		]);
		expect(df.a).toEqual({ defines: ['sales_df', '_sql_df'], uses: [] });
		expect(df.b).toEqual({ defines: ['_sql_df'], uses: [] });
	});

	it('a SQL cell with an unusable prefix line defines nothing (it binds nothing)', async () => {
		const df = await analyzeDataflow([sqlCell('a', '-- >> class\nSELECT 1')]);
		expect(df.a).toEqual({ defines: [], uses: [] });
	});

	it('leaves Python cells to the real probe', async () => {
		const df = await analyzeDataflow([
			sqlCell('a', '-- >> sales_df\nSELECT 1'),
			pyCell('b', 'total = sales_df.count()')
		]);
		expect(df.a.defines).toContain('sales_df');
		expect(df.b.uses).toContain('sales_df'); // the probe ran, and saw the free name
		expect(df.b.defines).toContain('total');
	});
});

describe('staleness — a Python consumer of a SQL binding', () => {
	const SID = 1 as never;
	const ran = (at: number) => ({ lastRun: { at, session: SID, status: 'ok', actor: 'user', durationMs: 1 } });

	it('gets an upstream edge and goes stale when the SQL cell is edited', async () => {
		// Both ran at t=100; then the SQL cell is edited at t=200.
		const cells = [
			sqlCell('a', '-- >> sales_df\nSELECT * FROM sales', { ...ran(100), editedAt: 200 }),
			pyCell('b', 'total = sales_df.count()', ran(100))
		];
		const dataflow = await analyzeDataflow(cells);
		const stale = computeStaleness(cells, dataflow, SID);

		expect(stale.a.state).toBe('stale'); // self-edit staleness, as before
		expect(stale.b.state).toBe('stale'); // the edge the synthetic defines buys
		expect(stale.b.upstream).toContain('a');
	});

	it('stays fresh while nothing upstream changed', async () => {
		const cells = [
			sqlCell('a', '-- >> sales_df\nSELECT * FROM sales', ran(100)),
			pyCell('b', 'total = sales_df.count()', ran(200))
		];
		const stale = computeStaleness(cells, await analyzeDataflow(cells), SID);
		expect(stale.a.state).toBe('fresh');
		expect(stale.b.state).toBe('fresh');
	});

	it('a consumer of TWO named SQL cells tracks each one independently', async () => {
		// The whole point of naming: `_sql_df` is last-write-wins, so before this both
		// SQL cells defined only `_sql_df` and `c` had no edge to EITHER of them.
		// `upstream` lists only the OFFENDING deps, so edit one cell at a time to show
		// each edge exists on its own.
		const notebook = (edited: 'a' | 'b') => [
			sqlCell('a', '-- >> sales_df\nSELECT * FROM sales', { ...ran(100), ...(edited === 'a' && { editedAt: 300 }) }),
			sqlCell('b', '-- >> costs_df\nSELECT * FROM costs', { ...ran(100), ...(edited === 'b' && { editedAt: 300 }) }),
			pyCell('c', 'joined = sales_df.join(costs_df)', ran(100))
		];
		for (const edited of ['a', 'b'] as const) {
			const cells = notebook(edited);
			const stale = computeStaleness(cells, await analyzeDataflow(cells), SID);
			expect(stale.c.state).toBe('stale');
			expect(stale.c.upstream).toEqual([edited]); // the edited one, and only it
		}
	});
});
