/**
 * The MOJO NOTEBOOK LANGUAGE: identity, what runs, what is persisted, and - the
 * load-bearing half - the four Python-semantics engines its cells must stay OUT of.
 *
 * Mojo is the NOTEBOOK's language (`metadata.cellar.language`), not a cell tag: a
 * notebook is Python or Mojo and never both, so every plain `code` cell in a Mojo
 * notebook IS a Mojo cell. That is why every predicate here is asked WITH a
 * notebook language, and why the same cell answers differently under each.
 *
 * WHY THOSE FOUR ARE THE POINT. Such a cell stores BARE Mojo (the SQL shape:
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
 * `hasPythonDataflow` in `$lib/cellLanguage`, stated POSITIVELY, so a sixth
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
	isNotebookLanguage,
	isPythonCodeCell,
	isSqlCell,
	languageTagFor,
	logicalCellType,
	logicalTypeFor,
	nbCellType,
	notebookLanguageOf,
	isPyUnsupportedType,
	LOGICAL_CELL_TYPES,
	NOTEBOOK_LANGUAGES
} from '../../src/lib/cellLanguage';
import { canExportCell, isExportCell } from '../../src/lib/exportRole';
import {
	IMPORTS_ROLE,
	importsRoleStranded,
	isImportsCell,
	notebookUsesImportsCell
} from '../../src/lib/importsRole';
import { computeStaleness, STALE_STATE } from '../../src/lib/staleness';
import {
	MOJO_INSTALL_COMMAND,
	MOJO_MAGIC_HEADER,
	MOJO_PACKAGE,
	MOJO_SETUP_MARKER,
	MOJO_SETUP_NO_VERDICT_KEY,
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
/**
 * A Mojo cell is just a plain code cell - what makes it Mojo is the NOTEBOOK it is
 * in, which every predicate below is handed as `MOJO`. The helper exists to say
 * that out loud at each call site rather than to build anything different.
 */
const mojo = (id: string, source: string) => cell(id, source);
/** The notebook language a Mojo notebook declares, passed to every predicate. */
const MOJO = MOJO_LANGUAGE;

/** Mojo taken from Modular's own notebook docs: valid Mojo, and valid-looking Python. */
const MOJO_MAIN = 'def main():\n    print("Hello from Mojo!")\n';
const MOJO_WITH_IMPORT = 'from std.time import sleep\n\ndef main():\n    sleep(1.0)\n    print("done")\n';

describe('mojo is the NOTEBOOK\'s language, never a cell type', () => {
	it('is NOT in the cell-type vocabulary - the selector is the only way to it', () => {
		// A per-cell `mojo` type would be a second spelling of a notebook-level fact,
		// i.e. exactly the mixed-language notebook the model rules out.
		expect(LOGICAL_CELL_TYPES).not.toContain('mojo');
		expect(languageTagFor('code')).toBeNull();
		// ...while the NOTEBOOK vocabulary is the two languages, and nothing else.
		expect([...NOTEBOOK_LANGUAGES].sort()).toEqual(['mojo', 'python']);
		for (const l of NOTEBOOK_LANGUAGES) expect(isNotebookLanguage(l)).toBe(true);
		for (const bad of ['sql', 'Mojo', '', null, undefined, 0]) expect(isNotebookLanguage(bad)).toBe(false);
	});

	it('reads the notebook metadata, and ONLY an exact `mojo` means Mojo', () => {
		expect(notebookLanguageOf({ cellar: { language: MOJO_LANGUAGE } })).toBe('mojo');
		// Absence is the permanent spelling of Python - no migration, no shim.
		expect(notebookLanguageOf({ cellar: {} })).toBe('python');
		expect(notebookLanguageOf({})).toBe('python');
		expect(notebookLanguageOf(null)).toBe('python');
		expect(notebookLanguageOf(undefined)).toBe('python');
		// A hand-edited or newer-Cellar value falls to the default that runs the
		// notebook the way it has always run, rather than guessing.
		for (const junk of ['Mojo', 'python3', 'zig', '', 1, true])
			expect(notebookLanguageOf({ cellar: { language: junk } })).toBe('python');
	});

	it('makes every plain code cell of that notebook a Mojo cell', () => {
		const c = mojo('a', MOJO_MAIN);
		expect(isMojoCell(c, MOJO)).toBe(true);
		expect(cellLanguage(c, MOJO)).toBe('mojo');
		// The SAME cell in a Python notebook is Python - which is the whole point: the
		// language is not a property of the cell.
		expect(isMojoCell(c, 'python')).toBe(false);
		expect(cellLanguage(c, 'python')).toBe('python');
		// ...and its LOGICAL type is `code` under either, since that is what it is.
		expect(logicalCellType(c)).toBe('code');
	});

	it('leaves markdown, raw, sql and chat cells untouched by the language', () => {
		// The selector changes what a CODE cell is and nothing else. Each of these
		// reads identically under both notebook languages.
		const md = { cell_type: 'markdown', metadata: {} };
		const raw = { cell_type: 'raw', metadata: {} };
		const sql = cell('s', 'select 1', { language: 'sql' });
		const chat = cell('c', 'why?', { language: 'chat' });
		for (const lang of NOTEBOOK_LANGUAGES) {
			expect(logicalCellType(md)).toBe('markdown');
			expect(logicalCellType(raw)).toBe('raw');
			expect(logicalCellType(sql)).toBe('sql');
			expect(logicalCellType(chat)).toBe('chat');
			expect(isMojoCell(md, lang)).toBe(false);
			expect(isMojoCell(raw, lang)).toBe(false);
			expect(isMojoCell(sql, lang)).toBe(false);
			expect(isMojoCell(chat, lang)).toBe(false);
			expect(cellLanguage(sql, lang)).toBe('sql');
			expect(cellLanguage(chat, lang)).toBe('chat');
		}
	});

	it('round-trips through the ONE forward+inverse tag mapping the cell:type event uses', () => {
		for (const t of LOGICAL_CELL_TYPES) {
			expect(logicalTypeFor(nbCellType(t), languageTagFor(t))).toBe(t);
		}
		// A tag from a newer Cellar - or a legacy per-cell `mojo` one - reads as the
		// code cell it already is on disk.
		expect(logicalTypeFor('code', 'zig')).toBe('code');
		expect(logicalTypeFor('code', MOJO_LANGUAGE)).toBe('code');
	});

	it('is refused on a .py TEXT notebook at the NOTEBOOK level, not as a cell type', () => {
		// The refusal moved with the setting: a `.py` document stores no notebook
		// metadata, so it cannot hold the declaration - the same argument raw and chat
		// are refused by, one level up.
		expect(isPyUnsupportedType('mojo')).toBe(false);
		expect(isPyUnsupportedType('raw')).toBe(true);
		expect(isPyUnsupportedType('chat')).toBe(true);
		for (const t of ['code', 'sql', 'markdown']) expect(isPyUnsupportedType(t)).toBe(false);
	});
});

/**
 * The imports role SURVIVES a language switch, because a switch touches no cell -
 * which is the design, not an oversight. So a designation made while the notebook
 * was Python is still there afterwards, doing nothing.
 *
 * That state is neither deleted nor left silent: the badge keeps asserting it and
 * the control stays reachable, greyed, able only to CLEAR - the hidden-vs-greyed
 * distinction the nbdev export toggle already draws. Hidden instead, the user is
 * left with `metadata.cellar.role` in their committed `.ipynb`, chrome asserting
 * it, and no way to remove it short of switching the notebook back.
 */
describe('an imports role kept across a language switch stays CLEARABLE', () => {
	it('a Mojo notebook uses no imports cell, so MARKING one can never mean anything', () => {
		expect(notebookUsesImportsCell('python')).toBe(true);
		expect(notebookUsesImportsCell(MOJO)).toBe(false);
	});

	it('a cell that ALREADY carries the role is STRANDED there, not merely ineligible', () => {
		const marked = cell('a', MOJO_MAIN, { role: IMPORTS_ROLE });
		const plain = cell('b', MOJO_MAIN);
		// The mark is still on the cell after the switch - nothing per-cell was written.
		expect(isImportsCell(marked)).toBe(true);
		// Stranded is the MARKED case only: a cell with no role has no state to clear,
		// so its control stays hidden rather than rendering greyed and inert.
		expect(importsRoleStranded(marked, MOJO)).toBe(true);
		expect(importsRoleStranded(plain, MOJO)).toBe(false);
		// And in a Python notebook nothing is stranded at all - the role works there.
		expect(importsRoleStranded(marked, 'python')).toBe(false);
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
		// Under MOJO, no cell of the notebook is Python - so nothing is probed at all.
		const df = await analyzeDataflow([mojo('m', MOJO_MAIN), cell('p', 'main()')], MOJO);
		expect(df.m).toBeUndefined();
		expect(df.p).toBeUndefined();
		// The SAME cells in a PYTHON notebook are probed exactly as they always were -
		// which is what shows the exclusion is the notebook's language, not a blanket.
		const py = await analyzeDataflow([mojo('m', MOJO_MAIN), cell('p', 'main()')]);
		expect(py.m?.defines).toEqual(['main']); // the fabricated edge, in a Python notebook
		expect(py.p).toEqual({ defines: [], uses: ['main'] });
	});

	it('still probes ordinary Python cells in a PYTHON notebook, so the exclusion is not a blanket', async () => {
		const df = await analyzeDataflow([cell('p', 'import os\nresult = os.getcwd()'), cell('q', 'print(result)')]);
		expect(df.p?.defines).toContain('result');
		expect(df.q?.uses).toContain('result');
	});

	it('keeps a SQL cell in the probe even in a Mojo notebook - its wrapper really binds', async () => {
		// A SQL cell is a per-cell KIND, not the notebook's language, so the selector
		// does not touch it: `sql.ts` still compiles it to a `spark.sql(...)` wrapper
		// that binds `_sql_df`, and the synthetic contribution must survive.
		const df = await analyzeDataflow([cell('s', 'select 1', { language: 'sql' })], MOJO);
		expect(df.s?.defines).toContain('_sql_df');
	});

	it('reads a mojo cell that is NOT valid Python without failing the batch for its neighbours', async () => {
		// `struct` / `fn` / `var x: Int` are Mojo, not Python. The probe's per-cell
		// except would swallow them as edge-free, which is indistinguishable from a
		// genuinely edge-free cell - so keeping them out entirely is what makes the
		// neighbours' answers trustworthy.
		const df = await analyzeDataflow(
			[
				mojo('m', 'struct Point:\n    var x: Int\n\nfn main():\n    print("hi")\n'),
				cell('p', 'total = 1'),
				cell('q', 'print(total)')
			],
			MOJO
		);
		// Nothing in a Mojo notebook is handed to `ast` at all, so the unparseable cell
		// cannot fail a batch for anyone: there is no batch.
		expect(df.m).toBeUndefined();
		expect(df.p).toBeUndefined();
		expect(df.q).toBeUndefined();
	});
});

describe('THE STALENESS REGRESSION: a mojo cell has no verdict, so it shows no chip', () => {
	const RAN = { at: 1000, durationMs: 1, actor: 'user' as const, status: 'ok', session: 7 };
	const stale = (
		cells: CellView[],
		df: Record<string, { defines: string[]; uses: string[] }>,
		nbLang: 'python' | 'mojo' = 'python'
	) =>
		computeStaleness(
			cells.map((c) => ({ ...c, metadata: { ...c.metadata, cellar: { ...c.metadata?.cellar, lastRun: RAN } } })) as never,
			df,
			7,
			null,
			nbLang
		);

	it('reports n/a for EVERY CODE cell of a Mojo notebook - not fresh, and never stale', () => {
		const cells = [mojo('m', MOJO_MAIN), cell('p', 'x = 1')];
		const out = stale(cells, { p: { defines: ['x'], uses: [] } }, MOJO);
		expect(out.m.state).toBe(STALE_STATE.NA);
		expect(out.p.state).toBe(STALE_STATE.NA);
		// The SAME cells in a Python notebook keep their ordinary verdicts.
		const py = stale(cells, { p: { defines: ['x'], uses: [] } });
		expect(py.p.state).toBe(STALE_STATE.FRESH);
	});

	it('a SQL cell KEEPS its verdict in a Mojo notebook - the exclusion is by cell, not by notebook', () => {
		// `hasPythonDataflow` is `isPythonCodeCell(cell, nbLang) || isSqlCell(cell)` and
		// `isSqlCell` is language-INDEPENDENT, because a SQL cell is an orthogonal cell
		// KIND that deliberately coexists in either notebook: it compiles to a wrapper
		// binding `_sql_df` whatever the notebook's language is. So "a Mojo notebook
		// shows no staleness verdict" is true of its CODE cells only, and MCP doctrine
		// clause 12 says exactly that - this is the behaviour that claim rests on.
		const sqlCell = {
			...cell('s', 'select 1', { language: 'sql' }),
			metadata: { cellar: { language: 'sql', lastRun: { ...RAN, at: 2000 } } }
		} as unknown as CellView;
		const codeCell = { ...cell('m', MOJO_MAIN), metadata: { cellar: { lastRun: RAN } } } as unknown as CellView;
		const out = computeStaleness(
			[sqlCell, codeCell] as never,
			{ s: { defines: ['_sql_df'], uses: [] } },
			7,
			null,
			MOJO
		);
		expect(out.s.state).toBe(STALE_STATE.FRESH);
		expect(out.m.state).toBe(STALE_STATE.NA);
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

	it('hasPythonDataflow: exactly code + sql, positively stated, and scoped by the notebook', () => {
		expect(hasPythonDataflow(cell('p', 'x'))).toBe(true);
		expect(hasPythonDataflow(cell('s', 'select 1', { language: 'sql' }))).toBe(true);
		expect(hasPythonDataflow(cell('c', 'why?', { language: 'chat' }))).toBe(false);
		expect(hasPythonDataflow({ cell_type: 'markdown' })).toBe(false);
		expect(hasPythonDataflow({ cell_type: 'raw' })).toBe(false);
		// A FOREIGN nbformat cell_type reads as neither: the strict test is what keeps
		// an externally-authored cell out of the Python machinery.
		expect(hasPythonDataflow({ cell_type: 'foo' })).toBe(false);
		// In a MOJO notebook the code cell is out; the SQL cell stays in, because its
		// wrapper binds names whatever the notebook's language is.
		expect(hasPythonDataflow(cell('p', 'x'), MOJO)).toBe(false);
		expect(hasPythonDataflow(cell('s', 'select 1', { language: 'sql' }), MOJO)).toBe(true);
	});

	it('isPythonCodeCell: exactly plain code, in a Python notebook', () => {
		expect(isPythonCodeCell(cell('p', 'x'))).toBe(true);
		expect(isPythonCodeCell(cell('s', 'select 1', { language: 'sql' }))).toBe(false);
		expect(isPythonCodeCell({ cell_type: 'foo' })).toBe(false);
		// The default is `python`, which is what keeps every untouched caller answering
		// exactly as it did before the notebook had a language at all.
		expect(isPythonCodeCell(cell('p', 'x'), 'python')).toBe(true);
		expect(isPythonCodeCell(cell('p', 'x'), MOJO)).toBe(false);
	});
});

describe('THE NBDEV-EXPORT REGRESSION: Mojo source can never reach the generated .py', () => {
	it('a plain code cell is eligible for its OWN notebook\'s module, whichever that is', () => {
		// The module's language IS the notebook's, so ONE argument answers both halves
		// - which is "no second setting that can contradict the notebook" expressed in
		// the signature. A plain code cell therefore always matches its own notebook's
		// module; what is INELIGIBLE is a cell with no module source, or one whose
		// SOURCE disagrees with its notebook (the next test).
		expect(canExportCell(cell('p', 'x = 1'), 'python')).toBe(true);
		expect(canExportCell(mojo('m', MOJO_MAIN), 'mojo')).toBe(true);
		// A cell with no module source at all is eligible under neither language.
		for (const lang of NOTEBOOK_LANGUAGES) {
			expect(canExportCell(cell('s', 'select 1', { language: 'sql' }), lang)).toBe(false);
			expect(canExportCell(cell('c', 'why?', { language: 'chat' }), lang)).toBe(false);
			expect(canExportCell({ cell_type: 'markdown', source: '# hi' }, lang)).toBe(false);
			expect(canExportCell({ cell_type: 'raw', source: '---' }, lang)).toBe(false);
		}
	});

	it('a `%%mojo` MAGIC cell still never reaches a .py module - the live defect stays closed', () => {
		// This is the one thing that is NOT the notebook's language: a code cell whose
		// SOURCE opens with the magic is Mojo whatever the notebook says, which is what
		// a user gets by pasting an example out of Modular's docs into a Python
		// notebook. Its body must not be concatenated into a `.py` file nbdev commits.
		const pasted = cell('m', mojoToCellSource(MOJO_MAIN));
		expect(canExportCell(pasted, 'python')).toBe(false);
		expect(canExportCell(pasted, 'mojo')).toBe(true);
		expect(isExportCell({ ...pasted, metadata: { cellar: { export: true } } }, 'python')).toBe(false);
	});

	it('a hand-edited export flag is INERT wherever the cell cannot contribute', () => {
		// The module nbdev generates is committed to git, so a stale flag must not be
		// able to concatenate the wrong language into it through any door.
		const sqlMarked = cell('s', 'select 1', { language: 'sql', export: true });
		const mdMarked = { cell_type: 'markdown', source: '# hi', metadata: { cellar: { export: true } } };
		for (const lang of NOTEBOOK_LANGUAGES) {
			expect(isExportCell(sqlMarked, lang)).toBe(false);
			expect(isExportCell(mdMarked, lang)).toBe(false);
		}
		// ...while an ordinary marked code cell reaches its own notebook's module.
		expect(isExportCell(cell('p', 'def f(): ...', { export: true }), 'python')).toBe(true);
		expect(isExportCell(mojo('m', MOJO_MAIN, ), 'mojo')).toBe(false); // unmarked
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
		expect(out?.ready).toBe(false);
		expect(out?.detail).toMatch(/No module named 'mojo'/);
	});

	it('reads a NO-VERDICT marker as null, never as a missing toolchain', () => {
		// The probe reaches this when something that is not an ImportError stops it -
		// a Stop the user pressed, above all. It observed nothing about the toolchain,
		// so it must take the same exit a timed-out or throwing probe takes rather than
		// prescribing a 534 MB install for a cause nobody saw.
		const line = `${MOJO_SETUP_MARKER} {"ready": false, "${MOJO_SETUP_NO_VERDICT_KEY}": true, "detail": "KeyboardInterrupt: "}`;
		expect(parseMojoSetup(line)).toBeNull();
	});

	it('FAILS CLOSED on anything it cannot read', () => {
		// "we could not tell" must never read as "the toolchain is there": a false
		// positive sends `%%mojo` to a kernel with no such magic, and IPython answers
		// with an opaque UsageError instead of the install command.
		for (const bad of ['', 'random stdout', `${MOJO_SETUP_MARKER} not json`, `${MOJO_SETUP_MARKER} {"ready": "yes"}`]) {
			expect(parseMojoSetup(bad)?.ready).toBe(false);
		}
		expect(parseMojoSetup(null)?.ready).toBe(false);
	});

	it('takes the LAST marker line, so preceding stdout cannot spoof the verdict', () => {
		const stdout = `${MOJO_SETUP_MARKER} {"ready": true}\n${MOJO_SETUP_MARKER} {"ready": false, "detail": "x"}`;
		expect(parseMojoSetup(stdout)?.ready).toBe(false);
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
});

describe('the exclusions are shaped so the NEXT language inherits them', () => {
	const read = (p: string) => readFileSync(new URL(`../../src/lib/${p}`, import.meta.url), 'utf8');

	// Behavioural tests above would all pass against `&& !isMojoCell(c)` chains, and
	// the next tagged language would then be broken in four places at once. These
	// guards pin the SHAPE: each engine asks the shared positive predicate, and none
	// of them names mojo at all.
	// `exportRole.ts` is deliberately NOT in this list any more. Export eligibility
	// became TARGET-AWARE when `.mojo` targets landed (`exportTargetLanguage` /
	// `exportLanguageOf`), so it names both languages BY CONSTRUCTION - which is the
	// shape this whole block argues for, not a regression of it: the rule is still
	// one positive predicate, and it is still a MATCH rather than an exclusion.
	// `tests/unit/mojo-export.test.ts` pins that distinction BEHAVIOURALLY, with a
	// truth table over the imported module answering both target languages for every
	// cell language - a flat exclusion cannot produce it, having no `.mojo` target to
	// answer for.
	it('no Python-semantics engine mentions mojo', () => {
		for (const f of ['server/dataflow.ts', 'staleness.ts', 'server/imports-cell.ts']) {
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
