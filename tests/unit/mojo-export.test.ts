/**
 * A notebook's Mojo cells export to ONE `.mojo` module, the way its Python cells
 * export to one `.py`.
 *
 * Two tiers, because the toolchain is a 534 MB download Cellar deliberately never
 * installs (and so cannot assume on a test machine) - the
 * `mojo-toolchain-probe.test.ts` convention:
 *
 *  - UNCONDITIONAL: the rules, the generator, the real document write, the
 *    hazard, the target validation, and the `.py` regression this closes. These
 *    run in CI.
 *  - GATED on `CELLAR_MOJO_BIN` (a real `mojo` binary), with the reason IN THE
 *    SUITE NAME so a green run is never mistakable for a verified one. That tier
 *    is what turns "the generated text looks right" into "Mojo compiles it, runs
 *    it, and imports it" - and it carries the two CONTROLS that make the
 *    transforms provable rather than assumed: the un-transformed Python-path
 *    output fails on `__all__` and on a duplicate `main`.
 *
 * Measured against Mojo 1.0.0 (ed45d567) / max 26.5.0 while writing this:
 *   - `mojo doc <file> -o /dev/null` fully type-checks a module with no `main`.
 *   - `__all__ = [...]` at file scope: `error: expressions must not appear at
 *     file scope`.
 *   - two `def main()`: `error: redefinition of function 'main' with identical
 *     signature`.
 *   - an importer does NOT inherit an imported module's `main`, so a module
 *     carrying exactly one is both an importable library and a runnable program.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	canExportCell,
	exportLanguageOf,
	exportTargetLanguage,
	isExportCell
} from '../../src/lib/exportRole';
import {
	MAIN_DROPPED_BADGE,
	MAIN_DROPPED_COMMENT,
	MAIN_DROPPED_REASON,
	dropMainBlock,
	findTopLevelMain,
	hasTopLevelMain,
	mojoMainDroppedIds,
	mojoModuleSources,
	planMojoMains,
	stripMojoMagicHeader
} from '../../src/lib/mojoExport';
import { generateModule, mojoExportHazards } from '../../src/lib/server/export-py';
import { hazardSummaryClause } from '../../src/lib/exportHazard';
import type { Cell } from '../../src/lib/server/types';

vi.mock('../../src/lib/server/dataflow', () => ({
	getNotebookStaleness: async () => ({ sid: null, cells: {} }),
	analyzeDataflow: async () => ({})
}));

let WS: string;
let nbmod: typeof import('../../src/lib/server/notebook');
let svc: typeof import('../../src/lib/server/mcp/service');

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-mojo-export-'));
	process.env.CELLAR_WORKSPACE = WS;
	nbmod = await import('../../src/lib/server/notebook');
	svc = await import('../../src/lib/server/mcp/service');
});

const cell = (id: string, source: string, cellar?: Record<string, unknown>): Cell =>
	({ id, cell_type: 'code', source, metadata: cellar ? { cellar } : {} }) as unknown as Cell;
const mojoCell = (id: string, source: string, over: Record<string, unknown> = {}) =>
	cell(id, source, { language: 'mojo', ...over });

const MAIN = 'def main():\n    print("hi")';

/**
 * The CODE of a generated block, comments dropped.
 *
 * The drop comment necessarily QUOTES `def main()` - that is what makes it
 * legible at the drop site - so an assertion about what the module still DEFINES
 * has to read past the comments, or it passes for the wrong reason.
 */
const codeOf = (text: string) =>
	text
		.split('\n')
		.filter((l) => !l.trimStart().startsWith('#'))
		.join('\n');

// ---------------------------------------------------------------------------
// the target's extension names the module's LANGUAGE
// ---------------------------------------------------------------------------

describe('exportTargetLanguage', () => {
	it('reads .py and .mojo, and nothing else', () => {
		expect(exportTargetLanguage('lib/utils.py')).toBe('python');
		expect(exportTargetLanguage('lib/kernels.mojo')).toBe('mojo');
		expect(exportTargetLanguage('LIB/UTILS.PY')).toBe('python');
		expect(exportTargetLanguage('lib/a.MOJO')).toBe('mojo');
		expect(exportTargetLanguage('lib/notes.md')).toBeNull();
		expect(exportTargetLanguage('lib/mojo')).toBeNull(); // an extension, not a name
		expect(exportTargetLanguage(null)).toBeNull();
		expect(exportTargetLanguage('')).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// a cell is exportable to a target iff its LANGUAGE matches
// ---------------------------------------------------------------------------

describe('eligibility is a language MATCH, not a Python rule with a Mojo hole', () => {
	it('reads a cell language from its type OR its %%mojo magic', () => {
		expect(exportLanguageOf(cell('p', 'x = 1'))).toBe('python');
		expect(exportLanguageOf(mojoCell('m', MAIN))).toBe('mojo');
		// THE LIVE DEFECT this closes: a plain code cell pasted out of Modular's docs
		// reads as Python to every type-based test while its body is Mojo.
		expect(exportLanguageOf(cell('g', `%%mojo\n${MAIN}`))).toBe('mojo');
		expect(exportLanguageOf(cell('g2', `\n\n%%mojo build --emit shared-lib\n${MAIN}`))).toBe('mojo');
		// ...and only on the FIRST non-blank line, IPython's own rule.
		expect(exportLanguageOf(cell('g3', 'x = 1\n%%mojo'))).toBe('python');
		expect(exportLanguageOf(cell('s', 'select 1', { language: 'sql' }))).toBeNull();
		expect(exportLanguageOf({ cell_type: 'markdown', source: '# hi' })).toBeNull();
		expect(exportLanguageOf({ cell_type: 'raw', source: '---' })).toBeNull();
	});

	it('refuses a Mojo cell for .py and a Python cell for .mojo, in both directions', () => {
		const py = cell('p', 'def f(): ...');
		const mo = mojoCell('m', MAIN);
		const magic = cell('g', `%%mojo\n${MAIN}`);
		expect(canExportCell(py, 'python')).toBe(true);
		expect(canExportCell(py, 'mojo')).toBe(false);
		expect(canExportCell(mo, 'mojo')).toBe(true);
		expect(canExportCell(mo, 'python')).toBe(false);
		expect(canExportCell(magic, 'python')).toBe(false);
		expect(canExportCell(magic, 'mojo')).toBe(true);
	});

	it('defaults to the legacy Python question, so every pre-.mojo caller is unchanged', () => {
		expect(canExportCell(cell('p', 'x = 1'))).toBe(true);
		expect(canExportCell(mojoCell('m', MAIN))).toBe(false);
		expect(isExportCell(cell('p', 'x = 1', { export: true }))).toBe(true);
	});

	it('a MARKED %%mojo cell is not in the .py module and IS in the .mojo one', () => {
		const magic = cell('g', `%%mojo\n${MAIN}`, { export: true });
		expect(isExportCell(magic, 'python')).toBe(false);
		expect(isExportCell(magic, 'mojo')).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// finding a top-level `def main()`
// ---------------------------------------------------------------------------

describe('findTopLevelMain', () => {
	it('finds a plain top-level main and nothing else', () => {
		expect(hasTopLevelMain(MAIN)).toBe(true);
		expect(hasTopLevelMain('def helper():\n    return 1')).toBe(false);
		expect(hasTopLevelMain('')).toBe(false);
		// A NESTED main is not the module's entry point.
		expect(hasTopLevelMain('struct S:\n    def main(self):\n        pass')).toBe(false);
		// Mojo 1.0 removed `fn`, so `def` is the only form; a name that merely starts
		// with `main` is a different function.
		expect(hasTopLevelMain('def mainly():\n    pass')).toBe(false);
		expect(hasTopLevelMain('def main[T: Int]():\n    pass')).toBe(true);
		expect(hasTopLevelMain('def main() raises:\n    pass')).toBe(true);
	});

	it('never reads a `def main(` inside a multi-line string', () => {
		// A docstring OPENS indented but its continuation lines sit at column 0, so a
		// plain indent scan would cut a hole in the middle of a string literal.
		const src = 'def doc():\n    """\ndef main():\n    print(1)\n    """\n    return 1';
		expect(hasTopLevelMain(src)).toBe(false);
		expect(dropMainBlock(src)).toBe(src);
	});

	it('takes decorators above the def with the block, never leaving one dangling', () => {
		const src = 'X = 1\n\n@parameter\ndef main():\n    print(1)\n';
		const out = dropMainBlock(src);
		expect(codeOf(out)).not.toContain('@parameter');
		expect(codeOf(out)).not.toContain('def main');
		expect(out).toContain('X = 1');
	});

	it('consumes a bracket-continued header and stops at the next top-level line', () => {
		const src = ['def main(', '):', '    print(1)', '', 'def after():', '    return 2'].join('\n');
		const out = dropMainBlock(src);
		expect(out).toContain('def after():');
		expect(codeOf(out)).not.toContain('def main(');
		expect(codeOf(out)).not.toContain('print(1)');
	});

	it('leaves everything else in the cell byte-identical', () => {
		const src = ['from std.math import sqrt', '', 'def hyp(a: Float64) -> Float64:', '    return sqrt(a)', '', MAIN].join('\n');
		const out = dropMainBlock(src);
		expect(out).toContain('from std.math import sqrt');
		expect(out).toContain('def hyp(a: Float64) -> Float64:');
		expect(out).toContain(MAIN_DROPPED_COMMENT);
		expect(codeOf(out)).not.toContain('print("hi")');
	});
});

describe('stripMojoMagicHeader', () => {
	it('removes only a leading %%mojo line', () => {
		expect(stripMojoMagicHeader(`%%mojo\n${MAIN}`)).toBe(MAIN);
		expect(stripMojoMagicHeader(`%%mojo build --emit shared-lib -o m.so\n${MAIN}`)).toBe(MAIN);
		expect(stripMojoMagicHeader(MAIN)).toBe(MAIN); // an ordinary Cellar mojo cell
		expect(stripMojoMagicHeader('x = 1\n%%mojo')).toBe('x = 1\n%%mojo');
	});

	it('cuts through the magic LINE when blank lines sit above it', () => {
		// IPython tolerates blank lines above a cell magic and `cellMagicName` skips
		// them, so such a cell IS a `%%mojo` cell and IS eligible for a `.mojo` target.
		// Cutting at the first NEWLINE instead of the first non-blank LINE removed the
		// blank line and left `%%mojo` in the module - measured against Mojo 1.0.0 as
		// `error: unexpected token in expression`, i.e. a module that cannot compile
		// generated from a cell the exporter accepted.
		expect(stripMojoMagicHeader(`\n%%mojo\n${MAIN}`)).toBe(MAIN);
		expect(stripMojoMagicHeader(`\n\n   \n%%mojo\n${MAIN}`)).toBe(MAIN);
		// The whole cell being a header leaves nothing behind, not a stray line.
		expect(stripMojoMagicHeader('\n%%mojo')).toBe('');
	});

	it('no exported source can carry a magic line into the module', () => {
		// The property the two cases above are instances of, asserted over the one
		// function the exporter really calls.
		const { sources } = mojoModuleSources([`\n%%mojo\n${MAIN}`, `%%mojo\ndef helper():\n    return 1`]);
		expect(sources.join('\n')).not.toContain('%%mojo');
	});
});

// ---------------------------------------------------------------------------
// the `main` plan: the LAST main-carrying cell keeps it
// ---------------------------------------------------------------------------

describe('planMojoMains', () => {
	const helper = 'def helper():\n    return 1';

	it('keeps the LAST cell that carries a main and drops the earlier ones', () => {
		expect(planMojoMains([MAIN, helper, MAIN])).toEqual({ keep: 2, dropped: [0] });
		expect(planMojoMains([MAIN, MAIN, MAIN])).toEqual({ keep: 2, dropped: [0, 1] });
	});

	it('the LAST cell WITH a main wins, not the last exported cell', () => {
		// Modular's mode puts a main in every cell, so the two readings coincide on a
		// typical notebook - this is the case that separates them, and this reading is
		// what still yields a RUNNABLE module when the final cell is a helper.
		expect(planMojoMains([MAIN, helper])).toEqual({ keep: 0, dropped: [] });
	});

	it('no main anywhere is a plain library, not an error', () => {
		expect(planMojoMains([helper, 'X = 1'])).toEqual({ keep: null, dropped: [] });
		expect(planMojoMains([])).toEqual({ keep: null, dropped: [] });
	});

	it('is applied to the STRIPPED sources, so a %%mojo header cannot hide a main', () => {
		const { sources, dropped } = mojoModuleSources([`%%mojo\n${MAIN}`, `%%mojo\n${MAIN}`]);
		expect(dropped).toEqual([0]);
		expect(sources[0]).toBe(`${MAIN_DROPPED_COMMENT}\n`);
		expect(sources[1]).toBe(MAIN);
		expect(sources.join('\n')).not.toContain('%%mojo');
	});
});

describe('mojoMainDroppedIds - what the notebook badges', () => {
	it('names every marked mojo cell but the last main-carrying one', () => {
		const cells = [
			mojoCell('a', MAIN, { export: true }),
			mojoCell('b', 'def helper(): ...', { export: true }),
			mojoCell('c', MAIN, { export: true }),
			mojoCell('d', MAIN) // NOT marked: not in the module, so nothing is dropped
		];
		expect([...mojoMainDroppedIds(cells, 'mojo')]).toEqual(['a']);
	});

	it('is empty for a .py target, and for a notebook with at most one main', () => {
		const cells = [mojoCell('a', MAIN, { export: true }), mojoCell('b', MAIN, { export: true })];
		expect(mojoMainDroppedIds(cells, 'python').size).toBe(0);
		expect(mojoMainDroppedIds(cells, null).size).toBe(0);
		expect(mojoMainDroppedIds([mojoCell('a', MAIN, { export: true })], 'mojo').size).toBe(0);
	});

	it('tracks an edit: a later main makes an earlier badge appear, and removing it clears', () => {
		const first = mojoCell('a', MAIN, { export: true });
		const later = mojoCell('b', 'def helper(): ...', { export: true });
		expect(mojoMainDroppedIds([first, later], 'mojo').size).toBe(0);
		later.source = MAIN;
		expect([...mojoMainDroppedIds([first, later], 'mojo')]).toEqual(['a']);
		later.source = 'def helper(): ...';
		expect(mojoMainDroppedIds([first, later], 'mojo').size).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// the generated module
// ---------------------------------------------------------------------------

describe('generateModule for a .mojo target', () => {
	const cells = [`%%mojo\ncomptime EPS = 1e-9\n\n${MAIN}`, `%%mojo\ndef dot() -> Int:\n    return 1\n\n${MAIN}`];

	it('emits the header, no __all__, no %%mojo, and at most one main', () => {
		const out = generateModule(cells, 'vectors.ipynb', 'mojo');
		expect(out).toBe(
			'# AUTOGENERATED BY CELLAR! DO NOT EDIT!\n' +
				'# Source notebook: vectors.ipynb\n\n' +
				'comptime EPS = 1e-9\n\n' +
				`${MAIN_DROPPED_COMMENT}\n\n` +
				'def dot() -> Int:\n    return 1\n\n' +
				`${MAIN}\n`
		);
		expect(out).not.toContain('__all__');
		expect(out).not.toContain('%%mojo');
		expect(out.match(/^def main\(/gm)).toHaveLength(1);
	});

	it('is deterministic and idempotent', () => {
		expect(generateModule(cells, 'n.ipynb', 'mojo')).toBe(generateModule(cells, 'n.ipynb', 'mojo'));
	});

	it('writes a plain library when no cell defines main', () => {
		const out = generateModule(['def a(): ...', 'def b(): ...'], 'n.ipynb', 'mojo');
		expect(codeOf(out)).not.toContain('def main');
		expect(out).not.toContain(MAIN_DROPPED_COMMENT);
		expect(out).not.toContain('__all__');
	});

	it('leaves the Python path byte-identical', () => {
		// The `lang` argument DEFAULTS to python, so every existing caller is unchanged.
		const py = ['def add(a, b):\n    return a + b', 'PI = 3.14'];
		expect(generateModule(py, 'analysis.ipynb')).toBe(generateModule(py, 'analysis.ipynb', 'python'));
		expect(generateModule(py, 'analysis.ipynb')).toContain("__all__ = ['add', 'PI']");
	});
});

// ---------------------------------------------------------------------------
// the notebook-level hazard
// ---------------------------------------------------------------------------

describe('what the main handling costs is reported once, for the notebook', () => {
	it('names every cell that LOST a main, and the one that kept it', () => {
		const cells = [cell('aaaaaaaa-1111', MAIN), cell('bbbbbbbb-2222', 'def h(): ...'), cell('cccccccc-3333', MAIN)];
		const h = mojoExportHazards(cells).find((x) => x.kind === 'mojo-main-dropped')!;
		expect(h).toBeTruthy();
		expect(h.message).toContain('aaaaaaaa');
		expect(h.message).toContain('cccccccc'); // the one that KEPT it, so it can be found
		expect(h.message).not.toContain('bbbbbbbb'); // it never had one
		// It may NEVER be worded as "will not compile": dropping the main is what makes
		// the module valid (`$lib/exportHazard`'s header).
		expect(h.message).not.toMatch(/will not (import|compile)/);
		expect(h.message).toMatch(/Everything else in those cells is exported/);
	});

	it('MEASURED: a module that KEEPS a main can never be imported by a Python cell', () => {
		// `mojo build --emit shared-lib` - which is how `mojo.importer` compiles a
		// `.mojo` module for a Python `import` - refuses a module defining main
		// ("shared library should not contain a 'main' function", Mojo 1.0.0). So at
		// export time this is CERTAIN, not a guess, and it is said then rather than met
		// as an opaque ImportError minutes later.
		const h = mojoExportHazards([cell('dddddddd-4444', MAIN)]).find((x) => x.kind === 'mojo-main-kept')!;
		expect(h).toBeTruthy();
		expect(h.message).toContain('dddddddd'); // the cell to edit
		expect(h.message).toMatch(/NO PYTHON CELL CAN IMPORT IT/);
		expect(h.message).toMatch(/shared library should not contain a 'main' function/);
		// NOT a compile failure: the module is valid Mojo, and the message says so.
		expect(h.message).not.toMatch(/will not compile/);
		expect(h.message).toMatch(/still valid Mojo/);
		expect(h.message).toMatch(/Remove that cell's main/);
	});

	it('fires for a kept main even when NOTHING was dropped - the commonest shape', () => {
		expect(mojoExportHazards([cell('a', MAIN), cell('b', 'def h(): ...')]).map((h) => h.kind)).toEqual([
			'mojo-main-kept'
		]);
	});

	it('reports BOTH when a main was dropped AND one survives, discard first', () => {
		expect(mojoExportHazards([cell('a', MAIN), cell('b', MAIN)]).map((h) => h.kind)).toEqual([
			'mojo-main-dropped',
			'mojo-main-kept'
		]);
	});

	it('is silent for a module with no main at all - a plain library is fine', () => {
		expect(mojoExportHazards([cell('a', 'def h(): ...'), cell('b', 'X = 1')])).toEqual([]);
		expect(mojoExportHazards([])).toEqual([]);
	});

	it('the one-clause summary is keyed by KIND, never by hazards[0]', () => {
		// A surface that read `hazards[0]` would say "code was dropped" over a module
		// that dropped none, or "it will not import" over one that compiles.
		expect(hazardSummaryClause(mojoExportHazards([cell('a', MAIN), cell('b', MAIN)]))).toBe('code was dropped');
		expect(hazardSummaryClause(mojoExportHazards([cell('a', MAIN)]))).toBe('no Python cell can import it');
		expect(hazardSummaryClause([{ kind: 'future-import-joined', statement: 'x', message: 'y' }])).toBe(
			'it will not import'
		);
	});
});

// ---------------------------------------------------------------------------
// the real document write
// ---------------------------------------------------------------------------

describe('a notebook whose target is .mojo exports its Mojo cells to one module', () => {
	const modulePath = (rel: string) => join(WS, rel);
	const readModule = (rel: string) => (existsSync(modulePath(rel)) ? readFileSync(modulePath(rel), 'utf8') : null);

	async function mojoNotebook(name: string, sources: string[], target = `lib/${name.replace('.ipynb', '')}.mojo`) {
		const nb = nbmod.resolveNotebookPath(name);
		svc.useNotebook(`sess-${name}`, name);
		const { ids } = await svc.addCells(
			sources.map((source) => ({ cell_type: 'mojo' as const, source })),
			null,
			{ nb, routeImports: false }
		);
		nbmod.setExportTarget(target, nb);
		const full = ids.map((id) => svc.resolveRef(nb, id));
		nbmod.setCellExports(full, true, nb);
		return { nb, ids: full, target };
	}

	it('writes a valid-shaped .mojo module and keeps exactly one main', async () => {
		const { target } = await mojoNotebook('vec.ipynb', [`%%mojo\ncomptime EPS = 1e-9\n\n${MAIN}`, `%%mojo\ndef dot() -> Int:\n    return 1\n\n${MAIN}`]);
		const text = readModule(target)!;
		expect(text).toContain('# AUTOGENERATED BY CELLAR! DO NOT EDIT!');
		expect(text).not.toContain('__all__');
		expect(text).not.toContain('%%mojo');
		expect(text.match(/^def main\(/gm)).toHaveLength(1);
		expect(text).toContain(MAIN_DROPPED_COMMENT);
	});

	it('re-exporting identical content writes nothing (idempotent, zero git diff)', async () => {
		const { nb, target } = await mojoNotebook('idem.ipynb', [`def a(): ...`]);
		const first = readModule(target);
		const again = nbmod.exportPy(nb);
		expect(again.written).toBe(false);
		expect(again.reason).toBe('unchanged');
		expect(readModule(target)).toBe(first);
	});

	it('carries both main hazards on the export result', async () => {
		const { nb } = await mojoNotebook('haz.ipynb', [MAIN, MAIN]);
		const r = nbmod.exportPy(nb);
		expect(r.hazards.map((h) => h.kind)).toEqual(['mojo-main-dropped', 'mojo-main-kept']);
	});

	it('a module with no main carries NO hazard - the importable-from-Python shape', async () => {
		const { nb } = await mojoNotebook('lib-only.ipynb', ['def a(): ...', 'def b(): ...']);
		expect(nbmod.exportPy(nb).hazards).toEqual([]);
	});

	it('refuses to overwrite a file it did not generate', async () => {
		mkdirSync(join(WS, 'lib'), { recursive: true });
		writeFileSync(join(WS, 'lib/hand.mojo'), 'def hand_written(): ...\n');
		const { nb } = await mojoNotebook('clob.ipynb', ['def a(): ...'], 'lib/hand.mojo');
		const r = nbmod.exportPy(nb);
		expect(r.written).toBe(false);
		expect(r.reason).toBe('foreign-module');
		expect(readModule('lib/hand.mojo')).toBe('def hand_written(): ...\n');
	});

	it('a PYTHON cell contributes nothing to a .mojo module', async () => {
		const nb = nbmod.resolveNotebookPath('mixed.ipynb');
		svc.useNotebook('sess-mixed', 'mixed.ipynb');
		const { ids } = await svc.addCells(
			[
				{ cell_type: 'mojo', source: 'def only_mojo(): ...' },
				{ cell_type: 'code', source: 'import os\nPY_ONLY = 1' }
			],
			null,
			{ nb, routeImports: false }
		);
		nbmod.setExportTarget('lib/mixed.mojo', nb);
		const full = ids.map((id) => svc.resolveRef(nb, id));
		// The Python cell is REFUSED, so it is never even marked.
		expect(nbmod.setCellExport(full[1], true, nb)).toEqual({ ok: false, reason: 'not-code' });
		nbmod.setCellExports(full, true, nb);
		const text = readModule('lib/mixed.mojo')!;
		expect(text).toContain('def only_mojo');
		expect(text).not.toContain('PY_ONLY');
	});

	it('THE REGRESSION: a %%mojo cell can never reach a .py module', async () => {
		const nb = nbmod.resolveNotebookPath('regress.ipynb');
		svc.useNotebook('sess-regress', 'regress.ipynb');
		const { ids } = await svc.addCells(
			[
				{ cell_type: 'code', source: 'def keeps_working(): return 1' },
				{ cell_type: 'code', source: `%%mojo\n${MAIN}` }
			],
			null,
			{ nb, routeImports: false }
		);
		nbmod.setExportTarget('lib/regress.py', nb);
		const full = ids.map((id) => svc.resolveRef(nb, id));
		expect(nbmod.setCellExport(full[1], true, nb)).toEqual({ ok: false, reason: 'not-code' });
		nbmod.setCellExports(full, true, nb);
		const text = readModule('lib/regress.py')!;
		expect(text).toContain('def keeps_working');
		expect(text).not.toContain('%%mojo');
		expect(codeOf(text)).not.toContain('def main');
	});
});

describe('setExportTarget accepts .mojo and still refuses anything else', () => {
	it('stores a .mojo target and refuses a .ts one', async () => {
		const nb = nbmod.resolveNotebookPath('target.ipynb');
		svc.useNotebook('sess-target', 'target.ipynb');
		await svc.addCells([{ cell_type: 'code', source: 'x = 1' }], null, { nb, routeImports: false });
		expect(nbmod.setExportTarget('lib/k.mojo', nb).target).toBe('lib/k.mojo');
		expect(() => nbmod.setExportTarget('src/app.ts', nb)).toThrow(/not a \.py or \.mojo file/);
		expect(nbmod.getExportTarget(nb)).toBe('lib/k.mojo');
	});
});

// ---------------------------------------------------------------------------
// wiring guards (vitest runs without the SvelteKit plugin, so no component mounts)
// ---------------------------------------------------------------------------

describe('the wiring the browser ships', () => {
	const read = (p: string) => readFileSync(new URL(`../../src/lib/${p}`, import.meta.url), 'utf8');

	it('states Mojo as a target MATCH, never as an exclusion', () => {
		// A bare `&& !isMojoCell(cell)` is the version that would have to be UNPICKED
		// the moment a .mojo target existed - the whole point of the target-aware shape.
		const src = read('exportRole.ts');
		expect(src).not.toMatch(/!\s*isMojoCell/);
		expect(src).toMatch(/exportLanguageOf\(cell\) === lang/);
	});

	it('the cell badge reads the SHARED wording, not a local sentence', () => {
		const src = read('Cell.svelte');
		expect(src).toContain('data-testid="main-dropped-badge"');
		expect(src).toContain('{MAIN_DROPPED_BADGE}');
		expect(src).toContain('title={MAIN_DROPPED_REASON}');
		// The reason names BOTH halves the captain asked for: that this cell's main is
		// not exported, and WHY (a later exported cell has one).
		expect(MAIN_DROPPED_REASON).toMatch(/not exported/);
		expect(MAIN_DROPPED_REASON).toMatch(/later exported cell/);
		expect(MAIN_DROPPED_BADGE.length).toBeLessThan(30); // it sits in the toolbar row
	});

	it('the notebook derives the badge set from the shared rule, per cell', () => {
		expect(read('LiveNotebook.svelte')).toMatch(/mojoMainDropped = \$derived\(mojoMainDroppedIds\(cells, exportLanguage\)\)/);
		expect(read('Notebook.svelte')).toContain('mainDropped={mojoMainDropped.has(cell.id)}');
	});
});

// ---------------------------------------------------------------------------
// the REAL toolchain
// ---------------------------------------------------------------------------

const MOJO_BIN = process.env.CELLAR_MOJO_BIN ?? '';
const why = MOJO_BIN ? '' : ' [SKIPPED: set CELLAR_MOJO_BIN to a real `mojo` binary]';

/** Run mojo, returning `{ ok, out }` - never throwing, so a failure is assertable. */
function mojo(dir: string, args: string[]): { ok: boolean; out: string } {
	try {
		return { ok: true, out: execFileSync(MOJO_BIN, args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }) };
	} catch (e) {
		const err = e as { stdout?: string; stderr?: string };
		return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
	}
}

describe.skipIf(!MOJO_BIN)(`the generated module against a REAL mojo${why}`, () => {
	// Modular-style: EVERY cell carries a main, exactly as its own documentation
	// notebook does (5 of 5 cells there).
	const CELLS = [
		'%%mojo\nfrom std.math import sqrt\ncomptime EPS = 1e-9\n\ndef main():\n    print("eps =", EPS)',
		'%%mojo\nstruct Vec2(Copyable, Movable):\n    var x: Float64\n    var y: Float64\n    def __init__(out self, x: Float64, y: Float64):\n        self.x = x\n        self.y = y\n    def norm(self) -> Float64:\n        return sqrt(self.x * self.x + self.y * self.y)\n\ndef main():\n    print(Vec2(3.0, 4.0).norm())',
		'%%mojo\ndef dot(a: Vec2, b: Vec2) -> Float64:\n    return a.x * b.x + a.y * b.y\n\ndef main():\n    print(dot(Vec2(1.0, 2.0), Vec2(3.0, 4.0)))',
		'%%mojo\ndef scale(v: Vec2, k: Float64) -> Vec2:\n    return Vec2(v.x * k, v.y * k)\n\ndef main():\n    var s = scale(Vec2(1.0, 2.0), 3.0)\n    print("scaled", s.x, s.y)'
	];

	let dir: string;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'cellar-mojo-compile-'));
		writeFileSync(join(dir, 'vectors.mojo'), generateModule(CELLS, 'vectors.ipynb', 'mojo'));
		writeFileSync(
			join(dir, 'app.mojo'),
			'from vectors import Vec2, dot, scale, EPS\ndef main():\n    var a = Vec2(3.0, 4.0)\n    print(a.norm(), dot(a, scale(a, 2.0)), EPS)\n'
		);
		// The CONTROLS: the un-transformed Python-path output, so the two transforms
		// are provable rather than assumed.
		writeFileSync(join(dir, 'control_py.mojo'), generateModule(CELLS.map((c) => stripMojoMagicHeader(c)), 'c.ipynb'));
	});

	it('type-checks clean', () => {
		const r = mojo(dir, ['doc', 'vectors.mojo', '-o', '/dev/null']);
		expect(r.out, r.out).not.toMatch(/error:/);
		expect(r.ok).toBe(true);
	});

	it('RUNS directly - the one surviving main makes it a program', () => {
		const r = mojo(dir, ['run', 'vectors.mojo']);
		expect(r.ok, r.out).toBe(true);
		expect(r.out).toContain('scaled 3.0 6.0');
	});

	it('IMPORTS as a library from another file', () => {
		const r = mojo(dir, ['run', 'app.mojo']);
		expect(r.ok, r.out).toBe(true);
		expect(r.out).toContain('5.0 50.0 1e-09');
	});

	it('the KEPT main really does make it un-importable from Python, and removing it fixes that', () => {
		// The measurement the `mojo-main-kept` hazard's claim rests on, re-run rather
		// than taken on trust: a Python `import` of a `.mojo` module goes through
		// `mojo build --emit shared-lib` (`mojo/importer.py`), and that refuses a
		// module defining main. Both directions, so neither half can pass vacuously.
		const withMain = mojo(dir, ['build', 'vectors.mojo', '--emit', 'shared-lib', '-o', join(dir, 'withmain.so')]);
		expect(withMain.ok).toBe(false);
		expect(withMain.out).toMatch(/shared library should not contain a 'main' function/);

		writeFileSync(join(dir, 'nomain.mojo'), generateModule(CELLS.map((c) => c.replace(/\ndef main\(\):[\s\S]*$/, '\n')), 'n.ipynb', 'mojo'));
		const noMain = mojo(dir, ['build', 'nomain.mojo', '--emit', 'shared-lib', '-o', join(dir, 'nomain.so')]);
		expect(noMain.ok, noMain.out).toBe(true);
		expect(existsSync(join(dir, 'nomain.so'))).toBe(true);
	});

	it('a cell whose %%mojo header sits under a blank line still compiles', () => {
		// The regression that shipped: `stripMojoMagicHeader` cut at the first NEWLINE,
		// so a header on line 2 survived into the module. Driven through the real
		// compiler because the failure is the compiler's (`unexpected token in
		// expression`), not something the generated text announces.
		writeFileSync(
			join(dir, 'blankline.mojo'),
			generateModule(
				[`\n%%mojo\ndef lead() -> Int:\n    return 7`, '%%mojo\ndef main():\n    print(lead())'],
				'b.ipynb',
				'mojo'
			)
		);
		const r = mojo(dir, ['doc', 'blankline.mojo', '-o', '/dev/null']);
		expect(r.out, r.out).not.toMatch(/error:/);
		expect(r.ok).toBe(true);
	});

	it('CONTROL: the Python generator output fails on __all__ AND on duplicate main', () => {
		const r = mojo(dir, ['doc', 'control_py.mojo', '-o', '/dev/null']);
		expect(r.ok).toBe(false);
		expect(r.out).toMatch(/expressions must not appear at file scope/); // __all__
		expect(r.out).toMatch(/redefinition of function 'main'/);
	});
});
