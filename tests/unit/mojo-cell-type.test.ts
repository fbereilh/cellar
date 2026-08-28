/**
 * The `mojo` LOGICAL cell type: identity, what runs, what is persisted, and - the
 * load-bearing half - the four Python-semantics engines it must stay OUT of.
 *
 * WHY THOSE FOUR ARE THE POINT. A Mojo cell stores BARE Mojo (the SQL shape:
 * source on disk stays the language, `server/mojo.ts` compiles it to the `%%mojo`
 * magic at run time), and bare Mojo is precisely the shape that breaks Cellar,
 * because every Python-semantics engine keyed off "is this an nbformat code cell"
 * rather than "is its source Python". Measured on real Mojo before this type
 * existed:
 *
 *   - the `ast`/`symtable` dataflow probe reads `def main(): print(...)` as valid
 *     Python and reports `defines: ['main']` - a wholly FABRICATED dependency edge,
 *     cached as authoritative because the batch still reports ok;
 *   - `consolidateImports` LIFTS `from std.time import sleep` out of the Mojo cell
 *     into the Python imports cell and RUNS it, breaking both halves at once (the
 *     Mojo cell no longer compiles, and the imports cell raises
 *     `ModuleNotFoundError: No module named 'std'`).
 *
 * Both are silent. So the tests below drive the REAL probe and the REAL sweep over
 * a REAL document rather than hand-written fixtures - a fixture would happily
 * "codify" a reality the engines do not produce.
 *
 * They also pin the shape of the fix: the exclusions are `isPythonCodeCell` /
 * `hasPythonDataflow` in `$lib/cellLanguage`, stated POSITIVELY, so a seventh
 * language is out by construction. The final block asserts exactly that - no
 * engine may name `mojo` - because a `&& !isMojoCell(c)` chain would pass every
 * behavioural test here and still leave the next language broken.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { CellView } from '../../src/lib/server/types';
import {
	MOJO_LANGUAGE,
	cellLanguage,
	hasPythonDataflow,
	isMojoCell,
	isPythonCodeCell,
	isSqlCell,
	languageTagFor,
	logicalCellType,
	logicalTypeFor,
	nbCellType,
	isPyUnsupportedType,
	LOGICAL_CELL_TYPES
} from '../../src/lib/cellLanguage';
import { canExportCell, isExportCell } from '../../src/lib/exportRole';
import { computeStaleness, STALE_STATE } from '../../src/lib/staleness';
import {
	MOJO_INSTALL_COMMAND,
	MOJO_MAGIC_HEADER,
	MOJO_PACKAGE,
	MOJO_SETUP_CODE,
	MOJO_SETUP_MARKER,
	hasMojoHeader,
	mojoMissingMessage,
	mojoMissingOutput,
	mojoToCellSource,
	parseMojoSetup
} from '../../src/lib/server/mojo';

const py = vi.hoisted(() => ({ path: null as string | null }));
vi.mock('../../src/lib/server/databricks', () => ({ projectPython: () => py.path }));
import { analyzeDataflow, __resetDataflowState } from '../../src/lib/server/dataflow';

const cell = (id: string, source: string, cellar: Record<string, unknown> = {}): CellView =>
	({ id, cell_type: 'code', source, metadata: { cellar }, outputs: [] }) as unknown as CellView;
const mojo = (id: string, source: string) => cell(id, source, { language: MOJO_LANGUAGE });

/** Mojo taken from Modular's own notebook docs: valid Mojo, and valid-looking Python. */
const MOJO_MAIN = 'def main():\n    print("Hello from Mojo!")\n';
const MOJO_WITH_IMPORT = 'from std.time import sleep\n\ndef main():\n    sleep(1.0)\n    print("done")\n';

describe('mojo is a first-class logical cell type', () => {
	it('is in the ONE vocabulary and maps onto an nbformat code cell', () => {
		expect(LOGICAL_CELL_TYPES).toContain('mojo');
		expect(nbCellType('mojo')).toBe('code');
		expect(languageTagFor('mojo')).toBe(MOJO_LANGUAGE);
	});

	it('is identified by the tag, and only on a code cell', () => {
		expect(isMojoCell(mojo('a', MOJO_MAIN))).toBe(true);
		expect(logicalCellType(mojo('a', MOJO_MAIN))).toBe('mojo');
		expect(cellLanguage(mojo('a', MOJO_MAIN))).toBe('mojo');
		// The tag on a markdown/raw cell (a hand edit) names nothing: the nbformat
		// type wins, exactly as it does for the sql tag.
		const marked = { cell_type: 'markdown', metadata: { cellar: { language: MOJO_LANGUAGE } } };
		expect(isMojoCell(marked)).toBe(false);
		expect(logicalCellType(marked)).toBe('markdown');
	});

	it('leaves python, sql and chat cells reading exactly as before', () => {
		expect(logicalCellType(cell('p', 'x = 1'))).toBe('code');
		expect(logicalCellType(cell('s', 'select 1', { language: 'sql' }))).toBe('sql');
		expect(logicalCellType(cell('c', 'why?', { language: 'chat' }))).toBe('chat');
		expect(isMojoCell(cell('p', 'x = 1'))).toBe(false);
		expect(isMojoCell(cell('s', 'select 1', { language: 'sql' }))).toBe(false);
	});

	it('round-trips through the ONE forward+inverse tag mapping the cell:type event uses', () => {
		for (const t of LOGICAL_CELL_TYPES) {
			expect(logicalTypeFor(nbCellType(t), languageTagFor(t))).toBe(t);
		}
		// A tag from a newer Cellar reads as the code cell it already is on disk.
		expect(logicalTypeFor('code', 'zig')).toBe('code');
	});

	it('is refused on a .py TEXT notebook, through the SAME shared list as raw and chat', () => {
		expect(isPyUnsupportedType('mojo')).toBe(true);
		for (const t of ['code', 'sql', 'markdown']) expect(isPyUnsupportedType(t)).toBe(false);
	});
});

describe('a mojo cell compiles to the %%mojo cell magic at RUN time', () => {
	it('wraps bare Mojo in the magic header', () => {
		expect(mojoToCellSource(MOJO_MAIN)).toBe(`${MOJO_MAGIC_HEADER}\n${MOJO_MAIN}`);
	});

	it('is a no-op for an empty cell, like an empty Python cell', () => {
		expect(mojoToCellSource('')).toBe('');
		expect(mojoToCellSource('   \n\n ')).toBe('');
		expect(mojoToCellSource(null)).toBe('');
		expect(mojoToCellSource(undefined)).toBe('');
	});

	it('passes a source that ALREADY carries the header through verbatim', () => {
		// Pasting an example straight out of Modular's docs must not double the header.
		const pasted = `${MOJO_MAGIC_HEADER}\n${MOJO_MAIN}`;
		expect(mojoToCellSource(pasted)).toBe(pasted);
		// Leading blank lines are IPython's own tolerance for where a cell magic sits.
		const spaced = `\n\n${MOJO_MAGIC_HEADER}\n${MOJO_MAIN}`;
		expect(mojoToCellSource(spaced)).toBe(spaced);
	});

	it('preserves the magic SUBCOMMAND forms, which are the only way past `mojo run`', () => {
		for (const header of ['%%mojo build --emit shared-lib -o m.so', '%%mojo precompile -o kernels.mojoc', '%%mojo package']) {
			const src = `${header}\nfrom python import PythonObject\n`;
			expect(mojoToCellSource(src)).toBe(src);
			expect(hasMojoHeader(src)).toBe(true);
		}
	});

	it('does not mistake a %%mojo appearing BELOW the first line for a header', () => {
		const src = 'def main():\n    print("%%mojo")\n';
		expect(hasMojoHeader(src)).toBe(false);
		expect(mojoToCellSource(src)).toBe(`${MOJO_MAGIC_HEADER}\n${src}`);
		// ...and a lookalike prefix is not the magic either.
		expect(hasMojoHeader('%%mojolang\nx')).toBe(false);
	});
});

describe('THE FABRICATED-EDGE REGRESSION: a mojo cell never reaches the Python probe', () => {
	beforeEach(() => {
		py.path = null; // the real python3; `ast`/`symtable` are stdlib
		__resetDataflowState();
	});

	it('reports NO dataflow for a mojo cell whose Mojo happens to parse as Python', async () => {
		// Before the type existed this cell landed in the probe's Python bucket and
		// came back `defines: ['main']` - an edge to a name the `mojo run` subprocess
		// destroys the instant the cell ends.
		const df = await analyzeDataflow([mojo('m', MOJO_MAIN), cell('p', 'main()')]);
		expect(df.m).toBeUndefined();
		expect(df.p).toEqual({ defines: [], uses: ['main'] });
	});

	it('still probes ordinary Python cells beside it, so the exclusion is not a blanket', async () => {
		const df = await analyzeDataflow([mojo('m', MOJO_MAIN), cell('p', 'import os\nresult = os.getcwd()'), cell('q', 'print(result)')]);
		expect(df.m).toBeUndefined();
		expect(df.p?.defines).toContain('result');
		expect(df.q?.uses).toContain('result');
	});

	it('reads a mojo cell that is NOT valid Python without failing the batch for its neighbours', async () => {
		// `struct` / `fn` / `var x: Int` are Mojo, not Python. The probe's per-cell
		// except would swallow them as edge-free, which is indistinguishable from a
		// genuinely edge-free cell - so keeping them out entirely is what makes the
		// neighbours' answers trustworthy.
		const df = await analyzeDataflow([
			mojo('m', 'struct Point:\n    var x: Int\n\nfn main():\n    print("hi")\n'),
			cell('p', 'total = 1'),
			cell('q', 'print(total)')
		]);
		expect(df.m).toBeUndefined();
		expect(df.q?.uses).toEqual(['print', 'total']);
	});
});

describe('THE STALENESS REGRESSION: a mojo cell has no verdict, so it shows no chip', () => {
	const RAN = { at: 1000, durationMs: 1, actor: 'user' as const, status: 'ok', session: 7 };
	const stale = (cells: CellView[], df: Record<string, { defines: string[]; uses: string[] }>) =>
		computeStaleness(
			cells.map((c) => ({ ...c, metadata: { ...c.metadata, cellar: { ...c.metadata?.cellar, lastRun: RAN } } })) as never,
			df,
			7
		);

	it('reports n/a for a mojo cell - not fresh, and never stale', () => {
		const cells = [mojo('m', MOJO_MAIN), cell('p', 'x = 1')];
		const out = stale(cells, { p: { defines: ['x'], uses: [] } });
		expect(out.m.state).toBe(STALE_STATE.NA);
		expect(out.p.state).toBe(STALE_STATE.FRESH);
	});

	it('keeps SQL cells in the graph, which is why the predicate is not just isPythonCodeCell', () => {
		// `sql.ts` compiles a SQL cell to a wrapper that really does bind `_sql_df`, so
		// a Python cell reading it MUST go stale when the query is edited. Excluding
		// SQL along with mojo would silently break that.
		const sqlCell = cell('s', 'select 1', { language: 'sql' });
		const reader = cell('p', 'print(_sql_df)');
		const cells = [
			{ ...sqlCell, metadata: { cellar: { language: 'sql', lastRun: { ...RAN, at: 2000 } } } },
			{ ...reader, metadata: { cellar: { lastRun: RAN } } }
		] as unknown as CellView[];
		const out = computeStaleness(cells as never, { s: { defines: ['_sql_df'], uses: [] }, p: { defines: [], uses: ['_sql_df'] } }, 7);
		expect(out.s.state).toBe(STALE_STATE.FRESH);
		expect(out.p.state).toBe(STALE_STATE.STALE);
	});

	it('hasPythonDataflow: exactly code + sql, positively stated', () => {
		expect(hasPythonDataflow(cell('p', 'x'))).toBe(true);
		expect(hasPythonDataflow(cell('s', 'select 1', { language: 'sql' }))).toBe(true);
		expect(hasPythonDataflow(mojo('m', MOJO_MAIN))).toBe(false);
		expect(hasPythonDataflow(cell('c', 'why?', { language: 'chat' }))).toBe(false);
		expect(hasPythonDataflow({ cell_type: 'markdown' })).toBe(false);
		expect(hasPythonDataflow({ cell_type: 'raw' })).toBe(false);
		// A FOREIGN nbformat cell_type reads as neither: the strict test is what keeps
		// an externally-authored cell out of the Python machinery.
		expect(hasPythonDataflow({ cell_type: 'foo' })).toBe(false);
	});

	it('isPythonCodeCell: exactly plain code', () => {
		expect(isPythonCodeCell(cell('p', 'x'))).toBe(true);
		expect(isPythonCodeCell(cell('s', 'select 1', { language: 'sql' }))).toBe(false);
		expect(isPythonCodeCell(mojo('m', MOJO_MAIN))).toBe(false);
		expect(isPythonCodeCell({ cell_type: 'foo' })).toBe(false);
	});
});

describe('THE NBDEV-EXPORT REGRESSION: Mojo source can never reach the generated .py', () => {
	it('canExportCell is false for a mojo cell and true for a python one', () => {
		expect(canExportCell(cell('p', 'x = 1'))).toBe(true);
		expect(canExportCell(mojo('m', MOJO_MAIN))).toBe(false);
		expect(canExportCell(cell('s', 'select 1', { language: 'sql' }))).toBe(false);
	});

	it('a hand-edited export flag on a mojo cell is INERT, not merely un-settable', () => {
		// The module nbdev generates is committed to git, so a stale flag must not be
		// able to concatenate Mojo into it through any door.
		const marked = cell('m', MOJO_MAIN, { language: MOJO_LANGUAGE, export: true });
		expect(isExportCell(marked)).toBe(false);
		expect(isExportCell(cell('p', 'def f(): ...', { export: true }))).toBe(true);
	});
});

describe('the toolchain probe: detect and INSTRUCT, never install', () => {
	it('reads a ready marker line', () => {
		expect(parseMojoSetup(`${MOJO_SETUP_MARKER} {"ready": true, "version": "26.5.0"}`)).toEqual({
			ready: true,
			version: '26.5.0'
		});
	});

	it('reads a not-ready marker and keeps its reason', () => {
		const out = parseMojoSetup(`${MOJO_SETUP_MARKER} {"ready": false, "detail": "ModuleNotFoundError: No module named 'mojo'"}`);
		expect(out.ready).toBe(false);
		expect(out.detail).toMatch(/No module named 'mojo'/);
	});

	it('FAILS CLOSED on anything it cannot read', () => {
		// "we could not tell" must never read as "the toolchain is there": a false
		// positive sends `%%mojo` to a kernel with no such magic, and IPython answers
		// with an opaque UsageError instead of the install command.
		for (const bad of ['', 'random stdout', `${MOJO_SETUP_MARKER} not json`, `${MOJO_SETUP_MARKER} {"ready": "yes"}`]) {
			expect(parseMojoSetup(bad).ready).toBe(false);
		}
		expect(parseMojoSetup(null).ready).toBe(false);
	});

	it('takes the LAST marker line, so preceding stdout cannot spoof the verdict', () => {
		const stdout = `${MOJO_SETUP_MARKER} {"ready": true}\n${MOJO_SETUP_MARKER} {"ready": false, "detail": "x"}`;
		expect(parseMojoSetup(stdout).ready).toBe(false);
	});

	it('the missing-toolchain message names the command, the size, and refuses to auto-install', () => {
		const msg = mojoMissingMessage({ ready: false, detail: "ModuleNotFoundError: No module named 'mojo'" });
		expect(msg).toContain(MOJO_INSTALL_COMMAND);
		expect(msg).toContain(MOJO_PACKAGE);
		expect(msg).toMatch(/534 MB/);
		expect(msg).toMatch(/does not install it for you/i);
		expect(msg).toMatch(/No module named 'mojo'/);
		// It renders where the user is looking, as the cell's own error output.
		const out = mojoMissingOutput({ ready: false });
		expect(out.output_type).toBe('error');
		expect(out.ename).toBe('MojoToolchainMissing');
		expect(out.traceback.join('\n')).toContain(MOJO_INSTALL_COMMAND);
	});

	it('the setup code invalidates the import caches, so a mid-session install is picked up', () => {
		// The whole point of the instruction is that the user installs and RE-RUNS;
		// without this, Python's cached directory listings hide the new package until
		// a kernel restart and the instruction appears not to work.
		expect(MOJO_SETUP_CODE).toContain('invalidate_caches');
		expect(MOJO_SETUP_CODE).toContain('import mojo.notebook');
		expect(MOJO_SETUP_CODE).toContain(MOJO_SETUP_MARKER);
	});
});

describe('the exclusions are shaped so the NEXT language inherits them', () => {
	const read = (p: string) => readFileSync(new URL(`../../src/lib/${p}`, import.meta.url), 'utf8');

	// Behavioural tests above would all pass against `&& !isMojoCell(c)` chains, and
	// the next tagged language would then be broken in four places at once. These
	// guards pin the SHAPE: each engine asks the shared positive predicate, and none
	// of them names mojo at all.
	it('no Python-semantics engine mentions mojo', () => {
		for (const f of ['server/dataflow.ts', 'staleness.ts', 'server/imports-cell.ts', 'exportRole.ts']) {
			const src = read(f);
			expect(src, `${f} must not special-case mojo`).not.toMatch(/isMojoCell|MOJO_LANGUAGE|'mojo'/);
		}
	});

	it('each engine reaches the shared predicate rather than re-deriving one', () => {
		// WHICH predicate an engine consults, not how the call is spelled: a
		// behaviour-preserving `filter((c) => isPythonCodeCell(c))` must still pass.
		// Each must both IMPORT the shared rule from cellLanguage and USE it.
		const shared: Array<[string, string]> = [
			['server/dataflow.ts', 'isPythonCodeCell'],
			['staleness.ts', 'hasPythonDataflow'],
			['server/imports-cell.ts', 'isPythonCodeCell'],
			// The same test as `isPythonCodeCell`, under exportRole's own name for it.
			['exportRole.ts', 'isLogicalCellType']
		];
		for (const [f, predicate] of shared) {
			const src = read(f);
			expect(src, `${f} must import ${predicate} from cellLanguage`).toMatch(
				new RegExp(`import \\{[^}]*\\b${predicate}\\b[^}]*\\} from '[^']*cellLanguage'`)
			);
			// CALLED somewhere other than the import line - a mention in a comment is
			// not a use, and this guard exists precisely to catch a rule that drifted.
			const uses = src
				.split('\n')
				.filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
				.filter((l) => !l.includes('cellLanguage'))
				.filter((l) => l.includes(`${predicate}(`) || l.includes(`filter(${predicate})`));
			expect(uses.length, `${f} must USE ${predicate}`).toBeGreaterThan(0);
		}
	});

	it('imports-cell keeps NO local copy of the rule', () => {
		// It had one (`logicalCellType(cell) === 'code'`), which is the LOOSE form and
		// admitted a foreign nbformat cell_type into the Python import tokenizer.
		expect(read('server/imports-cell.ts')).not.toMatch(/function isPythonCodeCell/);
	});
});

describe('the header check reuses the ONE cell-magic rule, not a second regex', () => {
	// `magics.ts` already owns "which cell magic does this cell open with", including
	// IPython's first-non-blank-line rule - and it is the same rule
	// `normalizeForAnalysis` / `isCellMagicCell` key off. Two copies could disagree
	// about what a `%%mojo` cell is, which is exactly the drift that would let a
	// pass-through source still be wrapped (a doubled header) or vice versa.
	it('agrees with cellMagicName on every shape', async () => {
		const { cellMagicName } = await import('../../src/lib/server/magics');
		for (const src of [
			MOJO_MAGIC_HEADER,
			`${MOJO_MAGIC_HEADER}\n${MOJO_MAIN}`,
			`\n\n${MOJO_MAGIC_HEADER}\nx`,
			'%%mojo build --emit shared-lib -o m.so\nx',
			'%%mojolang\nx',
			'%%bash\necho hi',
			MOJO_MAIN,
			'',
			'def main():\n    print("%%mojo")'
		]) {
			expect(hasMojoHeader(src), src.slice(0, 30)).toBe(cellMagicName(src) === 'mojo');
		}
	});

	it('a magic-normalized `%%mojo` source still analyzes as NOTHING', async () => {
		// The compiled form is what the kernel sees, and it must stay safe for the
		// Python engines too: a user who types the magic by hand into a plain code
		// cell gets the same protection the tag gives, from the pre-existing guard.
		const { normalizeForAnalysis, isCellMagicCell } = await import('../../src/lib/server/magics');
		const compiled = mojoToCellSource(MOJO_WITH_IMPORT);
		expect(normalizeForAnalysis(compiled)).toBe('');
		expect(isCellMagicCell(compiled)).toBe(true);
	});
});
