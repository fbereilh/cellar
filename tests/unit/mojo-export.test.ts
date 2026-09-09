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
	exportEligibilityLanguage,
	exportModuleLanguage,
	exportLanguageOf,
	exportCellCount,
	exportMarkStranded,
	exportStrandedCount,
	exportStrandedExplanation,
	exportStrandedSummary,
	exportTargetLanguage,
	isExportCell,
	EXPORT_STRANDED_BADGE,
	EXPORT_STRANDED_CELL_TITLE
} from '../../src/lib/exportRole';
import {
	MAIN_DROPPED_BADGE,
	MAIN_DROPPED_COMMENT,
	MAIN_DROPPED_REASON,
	MAIN_KEPT_COMMENT,
	dropMainBlock,
	findTopLevelMain,
	hasTopLevelMain,
	mojoMainDroppedIds,
	mojoModuleSources,
	planMojoMains,
	stripMojoMagicHeader
} from '../../src/lib/mojoExport';
import { generateModule, mojoExportHazards } from '../../src/lib/server/export-py';
import { hazardReport, hazardSummaryClause, humanExportHazards } from '../../src/lib/exportHazard';
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
	it('reads a cell language from its NOTEBOOK, or from its own %%mojo magic', () => {
		// A plain code cell is written in whatever language its notebook is - that IS
		// the language axis, so it is passed in rather than read off the cell.
		expect(exportLanguageOf(cell('p', 'x = 1'), 'python')).toBe('python');
		expect(exportLanguageOf(cell('p', 'x = 1'), 'mojo')).toBe('mojo');
		// THE LIVE DEFECT this closes, and the ONE thing that is not the notebook's:
		// a plain code cell pasted out of Modular's docs reads as Python to every
		// type-based test while its body is Mojo. It stays Mojo under either notebook.
		expect(exportLanguageOf(cell('g', `%%mojo\n${MAIN}`), 'python')).toBe('mojo');
		expect(exportLanguageOf(cell('g', `%%mojo\n${MAIN}`), 'mojo')).toBe('mojo');
		expect(exportLanguageOf(cell('g2', `\n\n%%mojo build --emit shared-lib\n${MAIN}`), 'python')).toBe('mojo');
		// ...and only on the FIRST non-blank line, IPython's own rule.
		expect(exportLanguageOf(cell('g3', 'x = 1\n%%mojo'), 'python')).toBe('python');
		// A cell with no module source at all answers null under either language.
		for (const lang of ['python', 'mojo'] as const) {
			expect(exportLanguageOf(cell('s', 'select 1', { language: 'sql' }), lang)).toBeNull();
			expect(exportLanguageOf({ cell_type: 'markdown', source: '# hi' }, lang)).toBeNull();
			expect(exportLanguageOf({ cell_type: 'raw', source: '---' }, lang)).toBeNull();
		}
	});

	it('matches a cell against its own notebook\'s module, and refuses the %%mojo mismatch', () => {
		const code = cell('p', 'def f(): ...');
		const magic = cell('g', `%%mojo\n${MAIN}`);
		// ONE parameter answers both halves - the module's language IS the notebook's -
		// so an ordinary code cell always matches its own notebook's module.
		expect(canExportCell(code, 'python')).toBe(true);
		expect(canExportCell(code, 'mojo')).toBe(true);
		// The magic cell is the exception, and the only one: its SOURCE disagrees with
		// a Python notebook, so it can go in no `.py` module.
		expect(canExportCell(magic, 'python')).toBe(false);
		expect(canExportCell(magic, 'mojo')).toBe(true);
	});

	it('defaults to the legacy Python question, so every pre-language caller is unchanged', () => {
		expect(canExportCell(cell('p', 'x = 1'))).toBe(true);
		expect(canExportCell(cell('g', `%%mojo\n${MAIN}`))).toBe(false);
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

	it('a column-0 comment INSIDE the body does not end the block', () => {
		// The reviewer's exact repro, and a defect that shipped broken Mojo. A comment
		// produces no INDENT/DEDENT token, so this source compiles and RUNS under Mojo
		// 1.0.0 (printing 1 then 2). Read as a top-level line it ended the body early
		// and left `    print(2)` orphaned at file scope, which the compiler rejects
		// with "expressions must not appear at file scope".
		const src = 'def main():\n    print(1)\n# a separator\n    print(2)\n';
		const out = dropMainBlock(src);
		expect(out).toBe(`${MAIN_DROPPED_COMMENT}\n`);
		expect(out).not.toContain('print(2)');
		expect(out).not.toContain('# a separator');
		// ...and through the ONE function the exporter really calls.
		const { sources } = mojoModuleSources([src, 'def main():\n    print("keeper")']);
		expect(sources[0]).toBe(`${MAIN_DROPPED_COMMENT}\n`);
	});

	it('gives a TRAILING comment back to the residue, so it is never swallowed', () => {
		// A comment between `main` and the next top-level definition belongs to what
		// FOLLOWS. Dropping the block must not delete it - the trailing-blank walk had
		// to learn about comments too, or the fix above would silently eat one.
		const src = 'def main():\n    print(1)\n\n# belongs to helper\ndef helper():\n    return 1\n';
		const out = dropMainBlock(src);
		expect(out).toContain('# belongs to helper');
		expect(out).toContain('def helper():');
		expect(codeOf(out)).not.toContain('print(1)');
		// The two halves in one source: the interior comment stays INSIDE the block,
		// the trailing one stays OUT of it.
		const both = 'def main():\n    print(1)\n# interior\n    print(2)\n# trailing\ndef helper():\n    return 1\n';
		const out2 = dropMainBlock(both);
		expect(out2).not.toContain('# interior');
		expect(out2).not.toContain('print(2)');
		expect(out2).toContain('# trailing');
		expect(out2).toContain('def helper():');
	});

	it('keeps an INDENTED trailing comment inside the dropped block, at either edge', () => {
		// The give-back is for COLUMN-0 comments, which belong to the top-level
		// definition that FOLLOWS. An indented one cannot: it is the last line of the
		// body being dropped, and handing it back left a fragment of the discarded
		// block sitting at file scope right after the drop comment - a git-tracked
		// artifact reading as an exporter bug.
		const src = 'def main():\n    print(1)\n    # done\nX = 1\n';
		const out = dropMainBlock(src);
		expect(out).not.toContain('# done');
		expect(out).toContain('X = 1');
		expect(codeOf(out)).not.toContain('print(1)');
		// At the very END of the cell there is no following definition at all, so an
		// indented trailing comment has even less claim to survive.
		const tail = dropMainBlock('def main():\n    print(1)\n    # done\n');
		expect(tail).toBe(`${MAIN_DROPPED_COMMENT}\n`);
		// The mirror, so neither rule can swallow the other: a column-0 comment at the
		// same position is still handed back.
		const col0 = dropMainBlock('def main():\n    print(1)\n# done\nX = 1\n');
		expect(col0).toContain('# done');
		expect(col0).toContain('X = 1');
	});

	it('a `#` opening a line INSIDE a triple-quoted string is not a comment', () => {
		// The comment rule may not override the string tracking: string content that
		// happens to start with `#` is not a line that can extend a suite, and reading
		// it as one would run the block past the string's close.
		const src = 'def main():\n    x = """\n# not a comment\n"""\n\nY = 1\n';
		const out = dropMainBlock(src);
		expect(out).toContain('Y = 1');
		expect(out).not.toContain('# not a comment');
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

// ---------------------------------------------------------------------------
// the EDGES of the dropped block
// ---------------------------------------------------------------------------

/**
 * Three defects of ONE shape have shipped from this scan, each generating a wrong
 * `.mojo` in silence: the magic-header strip cutting at the first newline rather
 * than the first non-blank line, the body scan ending at a column-0 comment, and
 * the decorator walk absorbing only CONTIGUOUS single-line decorators. So the
 * block's edges are covered systematically rather than case by case.
 *
 * Measured against Mojo 1.0.0 while writing this, and the reason the assertions
 * below are about the module's TEXT and not only about whether it compiles: a
 * stranded decorator followed by another `def` COMPILES CLEAN and silently
 * attaches to a function the user never decorated. Only the `struct` and
 * nothing-follows shapes error, so a suite that asserted "it fails to compile"
 * would pass while the worst outcome went undetected. The compiler tier below
 * carries all three consequences.
 */
describe("the dropped block's edges", () => {
	const AFTER = 'def after() -> Int:\n    return 2';

	describe('above the def: decorators belong to the block', () => {
		it('takes a decorator held off by BLANK lines, leaving none stranded', () => {
			const src = `X = 1\n\n@parameter\n\ndef main():\n    print(1)\n\n${AFTER}\n`;
			const out = dropMainBlock(src);
			// The silent shape: stranded, this `@parameter` attaches to `after`.
			expect(out).not.toContain('@parameter');
			expect(out).toContain('X = 1');
			expect(out).toContain(AFTER);
			expect(codeOf(out)).not.toContain('def main');
			expect(codeOf(out)).not.toContain('print(1)');
		});

		it('takes a decorator held off by a COMMENT, and the comment with it', () => {
			const src = `@parameter\n# why this one is parameterised\ndef main():\n    print(1)\n\n${AFTER}\n`;
			const out = dropMainBlock(src);
			expect(out).not.toContain('@parameter');
			// The comment sits BETWEEN the decorator and its def, so it belongs to the
			// block; left behind it would be a stray note about code that is gone.
			expect(out).not.toContain('# why this one is parameterised');
			expect(out).toContain(AFTER);
		});

		it('takes a MULTI-LINE decorator whole, closing bracket and all', () => {
			// The line immediately above the `def` is `)`, not `@`, so an upward walk that
			// only recognises a line starting with `@` leaves the whole call behind.
			const src = `@always_inline(\n    "nodebug"\n)\ndef main():\n    print(1)\n\n${AFTER}\n`;
			const out = dropMainBlock(src);
			expect(out).not.toContain('@always_inline');
			expect(out).not.toContain('nodebug');
			// ...and no orphaned fragment of it either, which is the loud half.
			expect(
				codeOf(out)
					.split('\n')
					.map((l) => l.trim())
			).not.toContain(')');
			expect(out).toContain(AFTER);
		});

		it('takes a RUN of decorators, with blanks and comments between them', () => {
			const src =
				'@parameter\n\n# a note between two decorators\n\n@always_inline(\n    "nodebug"\n)\ndef main():\n    print(1)\n';
			// Every line of the cell belongs to the block, so nothing but the comment is left.
			expect(dropMainBlock(src)).toBe(`${MAIN_DROPPED_COMMENT}\n`);
		});

		it('leaves blanks and comments ABOVE the topmost decorator in the residue', () => {
			// The mirror of the trailing trim: what sits above the run belongs to whatever
			// PRECEDES, so swallowing it would silently delete the user's own note.
			const src = 'X = 1\n\n# a note about X\n\n@parameter\ndef main():\n    print(1)\n';
			expect(dropMainBlock(src)).toBe(`X = 1\n\n# a note about X\n\n${MAIN_DROPPED_COMMENT}\n`);
		});

		it('never mistakes a preceding bracketed statement for a decorator', () => {
			// The upward walk resolves a logical line, so it must not read the `)` closing
			// an ordinary call as a decorator's and swallow the statement above it.
			const indented = 'X = compute(\n    1\n)\ndef main():\n    print(1)\n';
			expect(dropMainBlock(indented)).toBe(`X = compute(\n    1\n)\n${MAIN_DROPPED_COMMENT}\n`);
			// ...including when the continuation dedents to column 0.
			const flush = 'X = compute(\n1\n)\ndef main():\n    print(1)\n';
			expect(dropMainBlock(flush)).toBe(`X = compute(\n1\n)\n${MAIN_DROPPED_COMMENT}\n`);
		});

		it('never mistakes an indented line, or an `@` inside a string, for a decorator', () => {
			const body = 'def helper():\n    pass\ndef main():\n    print(1)\n';
			expect(dropMainBlock(body)).toBe(`def helper():\n    pass\n${MAIN_DROPPED_COMMENT}\n`);
			// String CONTENT that happens to start with `@` is not a decorator, and taking
			// it would cut a hole in the middle of a literal.
			const str = 'DOC = """\n@parameter\n"""\ndef main():\n    print(1)\n';
			const strOut = dropMainBlock(str);
			expect(strOut).toContain('@parameter');
			expect(strOut).toBe(`DOC = """\n@parameter\n"""\n${MAIN_DROPPED_COMMENT}\n`);
		});
	});

	describe('below the header: the body', () => {
		it('carries a bracket continuation that dedents to COLUMN 0', () => {
			// Inside brackets indentation carries no meaning, so `1,` is not a new
			// top-level line. Reading it as one ended the body there and left the rest of
			// the statement - and the indented line after it - orphaned at file scope.
			const src = `def main():\n    var x = add(\n1,\n2,\n)\n    print(x)\n\n${AFTER}\n`;
			const out = dropMainBlock(src);
			expect(out).toBe(`${MAIN_DROPPED_COMMENT}\n\n${AFTER}\n`);
			expect(out).not.toContain('1,');
			expect(out).not.toContain('print(x)');
		});

		it('carries blank runs inside the body', () => {
			const src = `def main():\n    print(1)\n\n\n    print(2)\n\n${AFTER}\n`;
			const out = dropMainBlock(src);
			expect(out).toBe(`${MAIN_DROPPED_COMMENT}\n\n${AFTER}\n`);
			expect(out).not.toContain('print(2)');
		});

		it('carries a string holding `#` and `def main(` without ending early', () => {
			const src = `def main():\n    doc = """\n# not a comment\ndef main():\n"""\n    print(doc)\n\n${AFTER}\n`;
			const out = dropMainBlock(src);
			expect(out).toBe(`${MAIN_DROPPED_COMMENT}\n\n${AFTER}\n`);
			expect(out).not.toContain('# not a comment');
			expect(out).not.toContain('print(doc)');
		});
	});

	describe('the trailing trim, in both directions', () => {
		it('hands trailing blank lines at the end of the cell back', () => {
			expect(dropMainBlock('def main():\n    print(1)\n\n\n')).toBe(`${MAIN_DROPPED_COMMENT}\n\n\n`);
		});

		it('hands a column-0 comment back but keeps an indented one', () => {
			// The two rules meet in one source: the indented comment is the last line of
			// the body being dropped, the column-0 one belongs to `after`.
			const src = `def main():\n    print(1)\n    # done\n# belongs to after\n${AFTER}\n`;
			expect(dropMainBlock(src)).toBe(`${MAIN_DROPPED_COMMENT}\n# belongs to after\n${AFTER}\n`);
		});
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
				'# Source notebook: vectors.ipynb\n' +
				`${MAIN_KEPT_COMMENT}\n\n` +
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
		// The note is a pure function of the cells, so it cannot be what makes a
		// re-export a non-empty git diff.
		const lib = ['def a(): ...'];
		expect(generateModule(lib, 'n.ipynb', 'mojo')).toBe(generateModule(lib, 'n.ipynb', 'mojo'));
	});

	it('writes a plain library when no cell defines main', () => {
		const out = generateModule(['def a(): ...', 'def b(): ...'], 'n.ipynb', 'mojo');
		expect(codeOf(out)).not.toContain('def main');
		expect(out).not.toContain(MAIN_DROPPED_COMMENT);
		expect(out).not.toContain('__all__');
	});

	it('notes the kept main IN THE MODULE, and only when one really survives', () => {
		// The reader of a shared `.mojo` has no notebook and no MCP result in front of
		// them, so the file is the only place they can learn why Python cannot import
		// it. Both directions, because the note would be a FALSE claim on a library
		// module: one with no `main` IS importable from Python.
		expect(generateModule(cells, 'n.ipynb', 'mojo')).toContain(MAIN_KEPT_COMMENT);
		// A single-main notebook drops nothing and still keeps a main, which is the
		// commonest shape there is.
		expect(generateModule([MAIN], 'n.ipynb', 'mojo')).toContain(MAIN_KEPT_COMMENT);
		expect(generateModule(['def a(): ...', 'def b(): ...'], 'n.ipynb', 'mojo')).not.toContain(
			MAIN_KEPT_COMMENT
		);
		// A `%%mojo` header must not hide a main from the note, exactly as it cannot
		// hide one from the plan.
		expect(generateModule([`%%mojo\n${MAIN}`], 'n.ipynb', 'mojo')).toContain(MAIN_KEPT_COMMENT);
	});

	it('states the MEASURED refusal, in Mojo comment syntax, and stays out of the .py path', () => {
		// It is written into a git-tracked generated file, so what it claims has to be
		// the fact the toolchain really answers with (the gated tier below re-measures
		// that refusal against a real `mojo`).
		expect(MAIN_KEPT_COMMENT).toContain('mojo build --emit shared-lib');
		expect(MAIN_KEPT_COMMENT).toContain("shared library should not contain a 'main' function");
		for (const line of MAIN_KEPT_COMMENT.split('\n')) expect(line.startsWith('# ')).toBe(true);
		// The Python module never carries it, whatever its cells define.
		expect(generateModule(['def main():\n    pass'], 'n.ipynb')).not.toContain(MAIN_KEPT_COMMENT);
	});

	it('leaves the first line HEADER, so the clobber guard still recognises the file', () => {
		// `isGeneratedModule` reads the FIRST line only. A note added above it - or in
		// place of it - would make the exporter refuse to overwrite its own module.
		const out = generateModule(cells, 'n.ipynb', 'mojo');
		expect(out.split('\n', 1)[0]).toBe('# AUTOGENERATED BY CELLAR! DO NOT EDIT!');
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

	it('the kept-main finding reaches the AGENT surface only', () => {
		// Captain decision: the measured claim stands, but Python CALLING Mojo is a
		// deferred direction and it is the only direction a kept `main` costs anything,
		// so it may not sit as standing chrome nor ride an ordinary export's success
		// line. `humanExportHazards` is the ONE rule every human surface narrows
		// through; the agent surface passes the full set.
		const both = mojoExportHazards([cell('a', MAIN), cell('b', MAIN)]);
		expect(both.map((h) => h.kind)).toEqual(['mojo-main-dropped', 'mojo-main-kept']);
		// The DROPPED finding keeps every surface: it says code the user wrote is gone.
		expect(humanExportHazards(both).map((h) => h.kind)).toEqual(['mojo-main-dropped']);
		// The commonest shape - one main, nothing dropped - now shows a human NOTHING.
		const keptOnly = mojoExportHazards([cell('a', MAIN), cell('b', 'def h(): ...')]);
		expect(keptOnly.map((h) => h.kind)).toEqual(['mojo-main-kept']);
		expect(humanExportHazards(keptOnly)).toEqual([]);
		// A `.py` export's hazards are untouched by the rule.
		const future = [{ kind: 'future-import-joined' as const, statement: 'x', message: 'y' }];
		expect(humanExportHazards(future)).toEqual(future);
	});

	it('a set is reported through the ONE joining rule, never hazards[0]', () => {
		const both = mojoExportHazards([cell('aaaaaaaa-1111', MAIN), cell('bbbbbbbb-2222', MAIN)]);
		const report = hazardReport(both);
		// Every message is present, so no finding is silently dropped.
		for (const h of both) expect(report).toContain(h.message);
		expect(report).toContain(' Also: ');
		expect(hazardReport([])).toBe('');
		expect(hazardReport([both[0]])).toBe(both[0].message);
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
		// The NOTEBOOK is what makes these Mojo cells, and it must be declared BEFORE
		// the target: the target's extension has to agree with the language, so a
		// `.mojo` path on a Python notebook is refused by design.
		nbmod.setNotebookLanguage('mojo', nb);
		const { ids } = await svc.addCells(
			sources.map((source) => ({ cell_type: 'code' as const, source })),
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

	it('a cell with NO module source contributes nothing to a .mojo module', async () => {
		// In a Mojo notebook every plain code cell IS Mojo, so what is left ineligible
		// is a cell that contributes no module source in any language - a SQL cell
		// here, whose raw SQL would otherwise be concatenated into a file git tracks.
		const nb = nbmod.resolveNotebookPath('mixed.ipynb');
		svc.useNotebook('sess-mixed', 'mixed.ipynb');
		nbmod.setNotebookLanguage('mojo', nb);
		const { ids } = await svc.addCells(
			[
				{ cell_type: 'code', source: 'def only_mojo(): ...' },
				{ cell_type: 'sql', source: 'select SQL_ONLY from t' }
			],
			null,
			{ nb, routeImports: false }
		);
		nbmod.setExportTarget('lib/mixed.mojo', nb);
		const full = ids.map((id) => svc.resolveRef(nb, id));
		// The SQL cell is REFUSED, so it is never even marked.
		expect(nbmod.setCellExport(full[1], true, nb)).toEqual({ ok: false, reason: 'not-code' });
		nbmod.setCellExports(full, true, nb);
		const text = readModule('lib/mixed.mojo')!;
		expect(text).toContain('def only_mojo');
		expect(text).not.toContain('SQL_ONLY');
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

describe('a stranded mark stays clearable', () => {
	const code = { cell_type: 'code', source: 'x = 1', metadata: { cellar: { export: true } } };
	const magic = {
		cell_type: 'code',
		source: `%%mojo\n${MAIN}`,
		metadata: { cellar: { export: true } }
	};
	const md = { cell_type: 'markdown', source: '# hi', metadata: { cellar: { export: true } } };

	it('a plain code mark is NEVER stranded by the language - it moves WITH the notebook', () => {
		// This is what "no second setting that can contradict" buys: the module's
		// language is the notebook's, so switching moves BOTH and a marked code cell
		// stays in the module. There is no stranding to undo on the way back either.
		expect(exportMarkStranded(code, 'python')).toBe(false);
		expect(exportMarkStranded(code, 'mojo')).toBe(false);
		expect(isExportCell(code, 'python')).toBe(true);
		expect(isExportCell(code, 'mojo')).toBe(true);
	});

	it('is the FLAG on a cell whose SOURCE or TYPE cannot contribute', () => {
		// The two reachable shapes: a `%%mojo` cell under a `.py` module (its source
		// disagrees with its notebook), and a cell with no module source at all.
		expect(exportMarkStranded(magic, 'python')).toBe(true);
		expect(exportMarkStranded(magic, 'mojo')).toBe(false);
		expect(exportMarkStranded(md, 'python')).toBe(true);
		expect(exportMarkStranded(md, 'mojo')).toBe(true);
		// An ineligible cell with NO flag has no state to clear.
		expect(exportMarkStranded({ cell_type: 'markdown', source: '# hi' }, 'python')).toBe(false);
	});

	it('counts stranded marks across the notebook, for the one bar explanation', () => {
		// The bar states this notebook-wide fact ONCE, so it needs the count rather
		// than a per-cell sentence.
		const clean = { cell_type: 'code', source: 'x = 1' };
		expect(exportStrandedCount([code, magic, md, clean], 'python')).toBe(2);
		expect(exportStrandedCount([code, magic, md, clean], 'mojo')).toBe(1);
		expect(exportStrandedCount([code, clean], 'python')).toBe(0);
		expect(exportStrandedCount([], 'mojo')).toBe(0);
		expect(exportStrandedCount(null)).toBe(0);
	});

	it('summarises how many stranded cells have a module language of their own', () => {
		// The second number is what decides which REMEDY the bar may name: a cell that
		// contributes no module source in ANY language is stranded whatever the target
		// says, so pointing the target elsewhere cannot resolve it.
		expect(exportStrandedSummary([magic, md], 'python')).toEqual({ count: 2, withLanguage: 1 });
		expect(exportStrandedSummary([md], 'python')).toEqual({ count: 1, withLanguage: 0 });
		expect(exportStrandedSummary([magic], 'python')).toEqual({ count: 1, withLanguage: 1 });
		expect(exportStrandedSummary([code], 'python')).toEqual({ count: 0, withLanguage: 0 });
		expect(exportStrandedSummary(null)).toEqual({ count: 0, withLanguage: 0 });
	});

	it('says NO TARGET and A DIFFERENT LANGUAGE as the different facts they are', () => {
		// `canExportCell` falls back to `python` with nothing configured, so a language
		// alone cannot tell the two apart - and the fallback made every marked Mojo cell
		// claim the notebook "targets a .py module" over a notebook that targets
		// nothing, naming a file that does not exist.
		const withLang = { count: 2, withLanguage: 2 };
		const none = exportStrandedExplanation(withLang, null);
		expect(none).toContain('no target module');
		expect(none).not.toContain('.py');
		expect(none).not.toContain('.mojo');
		expect(none).toContain('Set a target path');

		const py = exportStrandedExplanation(withLang, 'python');
		expect(py).toContain('.py module');
		expect(py).not.toContain('no target module');
		expect(exportStrandedExplanation(withLang, 'mojo')).toContain('.mojo module');

		// Singular and plural both read, since the count is whatever the notebook has.
		expect(exportStrandedExplanation({ count: 1, withLanguage: 1 }, 'mojo')).toContain('1 cell is marked');
		expect(exportStrandedExplanation({ count: 3, withLanguage: 3 }, 'mojo')).toContain('3 cells are marked');

		// It never claims what LANGUAGE the stranded cells are: the set can be mixed (a
		// Mojo cell beside a markdown cell carrying a hand-edited flag), so it states
		// only that the module leaves them out.
		for (const lang of [null, 'python', 'mojo'] as const)
			expect(exportStrandedExplanation(withLang, lang)).not.toMatch(/is not (Python|Mojo)/);
	});

	it('names a remedy that can actually resolve the cells it is about', () => {
		// Keeping the mark through a conversion made "no module source in ANY language"
		// the commonest stranded shape, and for such a cell no target extension can
		// help - so the point-the-target remedy would send the user to change a setting
		// that resolves nothing. The remedy turns on `withLanguage`, not on the target.
		for (const lang of [null, 'python', 'mojo'] as const) {
			const say = exportStrandedExplanation({ count: 2, withLanguage: 0 }, lang);
			expect(say).toContain('contribute no module source');
			expect(say).toContain("clear each mark from the cell's toolbar");
			// ...and it names NO target action, in any of its spellings.
			expect(say).not.toMatch(/Point the target|Set a target/);
			// It states what was observed and no more: never which language they are.
			expect(say).not.toMatch(/is not (Python|Mojo)|their own language/);
		}

		// A cell that DOES have a language keeps the target remedy, since changing the
		// extension really would take it - and the sentence still names no language.
		for (const lang of ['python', 'mojo'] as const) {
			const say = exportStrandedExplanation({ count: 1, withLanguage: 1 }, lang);
			expect(say).toContain('Point the target at a module that takes them');
			expect(say).not.toContain('their own language');
			expect(say).not.toContain('no module source');
		}
		// A MIXED set keeps it too: the target remedy applies to the cells that have a
		// language, and clearing covers the rest.
		const mixed = exportStrandedExplanation({ count: 3, withLanguage: 1 }, 'python');
		expect(mixed).toContain('Point the target');
		expect(mixed).toContain("clear each mark from the cell's toolbar");
	});

	it('the per-cell marker stays a MARKER, never the notebook-wide sentence', () => {
		// Fifteen repointed cells must not produce fifteen copies of one explanation:
		// the cell carries a short marker and the bar carries the reason.
		expect(EXPORT_STRANDED_BADGE.length).toBeLessThan(20);
		expect(EXPORT_STRANDED_CELL_TITLE.length).toBeLessThan(60);
		for (const text of [EXPORT_STRANDED_BADGE, EXPORT_STRANDED_CELL_TITLE]) {
			expect(text).not.toContain('.py');
			expect(text).not.toContain('.mojo');
			expect(text).not.toContain('target');
		}
	});

	it('the server clears it, so the greyed toggle is not a dead control', async () => {
		// The whole point of rendering the toggle for such a cell: marking is gated on
		// eligibility and UNMARKING is gated on nothing, so this is the one surface
		// that can retire an otherwise invisible key.
		//
		// Stranded HERE by the cell's own SOURCE rather than by a target flip: the
		// module's language follows the notebook now, so a plain code cell can no
		// longer be stranded by the setting moving under it. A `%%mojo` cell in a
		// PYTHON notebook is the reachable shape (a paste from Modular's docs).
		const rel = 'stranded.ipynb';
		const nb = nbmod.resolveNotebookPath(rel);
		svc.useNotebook('sess-stranded', rel);
		const { ids } = await svc.addCells([{ cell_type: 'code', source: 'x = 1' }], null, {
			nb,
			routeImports: false
		});
		const id = svc.resolveRef(nb, ids[0]);
		nbmod.setExportTarget('lib/stranded.py', nb);
		nbmod.setCellExports([id], true, nb);
		// The cell becomes Mojo by its own source: eligible for nothing this notebook has.
		nbmod.setSource(id, `%%mojo\n${MAIN}`, nb);
		const stranded = nbmod.listCells(nb).find((c) => c.id === id)!;
		expect(exportMarkStranded(stranded, 'python')).toBe(true);
		expect(isExportCell(stranded, 'python')).toBe(false);
		// Re-MARKING is refused, which is why the toggle sends `false`...
		expect(nbmod.setCellExport(id, true, nb)).toEqual({ ok: false, reason: 'not-code' });
		// ...and clearing works, leaving no key behind in the committed notebook.
		expect(nbmod.setCellExport(id, false, nb)).toEqual({ ok: true });
		const cleared = nbmod.listCells(nb).find((c) => c.id === id)!;
		expect('export' in (cleared.metadata?.cellar ?? {})).toBe(false);
		expect(exportMarkStranded(cleared, 'python')).toBe(false);
	});
});

describe('converting a cell never deletes its export mark', () => {
	/** A notebook with one code cell, a target, and that cell marked. */
	async function marked(rel: string, source: string, target: string) {
		const nb = nbmod.resolveNotebookPath(rel);
		svc.useNotebook(`sess-${rel}`, rel);
		// The target's extension has to agree with the notebook's language, so a
		// `.mojo` target means a Mojo notebook.
		if (target.endsWith('.mojo')) nbmod.setNotebookLanguage('mojo', nb);
		const { ids } = await svc.addCells([{ cell_type: 'code' as const, source }], null, {
			nb,
			routeImports: false
		});
		const id = svc.resolveRef(nb, ids[0]);
		nbmod.setExportTarget(target, nb);
		nbmod.setCellExports([id], true, nb);
		return { nb, id };
	}
	const cellOf = (nb: string, id: string) => nbmod.listCells(nb).find((c) => c.id === id)!;

	it('THE HAPPY PATH: a marked cell survives a NOTEBOOK LANGUAGE switch, both ways', async () => {
		// A conversion used to delete the flag, dropping the cell out of the module
		// with no notice and no stranded marker, because the key itself was gone. The
		// LANGUAGE is the equivalent move now, and it must be even safer: the module's
		// language follows the notebook, so a marked code cell stays marked AND stays
		// eligible - there is nothing stale left on the way back either.
		const { nb, id } = await marked('mojo-convert.ipynb', 'def helper() -> Int:\n    return 1', 'lib/mc.mojo');
		expect(isExportCell(cellOf(nb, id), 'mojo')).toBe(true);

		nbmod.setNotebookLanguage('python', nb);
		expect(nbmod.getExportTarget(nb)).toBe('lib/mc.py');
		const asPython = cellOf(nb, id);
		expect(asPython.metadata?.cellar?.export).toBe(true);
		// Still eligible, so it is still IN the module - not merely still flagged.
		expect(isExportCell(asPython, 'python')).toBe(true);
		expect(exportMarkStranded(asPython, 'python')).toBe(false);
		expect(readFileSync(join(WS, 'lib/mc.py'), 'utf8')).toContain('def helper()');
	});

	it('a mojo -> python -> mojo round trip keeps the mark, the target and the module', async () => {
		const { nb, id } = await marked('mojo-round.ipynb', 'def ring() -> Int:\n    return 2', 'lib/mr.mojo');
		nbmod.setNotebookLanguage('python', nb);
		nbmod.setNotebookLanguage('mojo', nb);
		expect(cellOf(nb, id).metadata?.cellar?.export).toBe(true);
		expect(nbmod.getExportTarget(nb)).toBe('lib/mr.mojo');
		expect(readFileSync(join(WS, 'lib/mr.mojo'), 'utf8')).toContain('def ring()');
	});

	it('a mark that survives onto a MARKDOWN cell is inert, stranded and clearable', async () => {
		// The consequence of keeping the flag: it can now sit on a cell type that had
		// no export affordance at all. Verified rather than assumed - nothing may reach
		// the module, the notebook-wide explanation must not claim a language the cell
		// does not have, and unmarking must still work.
		const { nb, id } = await marked('md-convert.ipynb', 'def one():\n    return 1', 'lib/md.py');
		nbmod.setCellType(id, 'markdown', nb);
		const asMd = cellOf(nb, id);
		expect(asMd.metadata?.cellar?.export).toBe(true);

		// Nothing reaches the module: eligibility, not the flag, decides that.
		expect(isExportCell(asMd, 'python')).toBe(false);
		expect(exportMarkStranded(asMd, 'python')).toBe(true);
		expect(exportCellCount(nbmod.listCells(nb), 'python')).toBe(0);
		expect(nbmod.exportPy(nb)).toMatchObject({ written: false, reason: 'no-cells' });

		// The one explanation reads correctly for it: it says the module leaves the
		// cell out, and never that the cell "is not Python".
		// A markdown cell contributes no module source in ANY language, so the one
		// explanation must name clearing the mark and no target action at all.
		const why = exportStrandedExplanation(exportStrandedSummary(nbmod.listCells(nb), 'python'), 'python');
		expect(why).toContain('contributes no module source');
		expect(why).toContain("clear the mark from the cell's toolbar");
		expect(why).not.toMatch(/Point the target|Set a target/);
		expect(why).not.toMatch(/is not (Python|Mojo)/);

		// ...and the greyed toggle's click still clears it, because unmarking is not
		// gated on eligibility.
		expect(nbmod.setCellExport(id, false, nb)).toEqual({ ok: true });
		expect('export' in (cellOf(nb, id).metadata?.cellar ?? {})).toBe(false);
	});

	it('a RAW cell behaves the same way, and re-MARKING one is still refused', async () => {
		const { nb, id } = await marked('raw-convert-export.ipynb', 'def two():\n    return 2', 'lib/rc.py');
		nbmod.setCellType(id, 'raw', nb);
		expect(cellOf(nb, id).metadata?.cellar?.export).toBe(true);
		expect(isExportCell(cellOf(nb, id), 'python')).toBe(false);
		// Keeping a stale mark is not the same as letting one be CREATED: the setter
		// still gates marking on eligibility, so no new mark can land here.
		expect(nbmod.setCellExport(id, false, nb)).toEqual({ ok: true });
		expect(nbmod.setCellExport(id, true, nb)).toEqual({ ok: false, reason: 'not-code' });
	});

	it('the imports role is still dropped, and outputs still cleared', async () => {
		// Scoped tightly: only the EXPORT flag changed. An imports cell must hold
		// Python, and a non-code cell carries no outputs.
		const { nb, id } = await marked('scope-convert.ipynb', 'import os', 'lib/sc.py');
		nbmod.setCellRole(id, 'imports', nb);
		nbmod.setOutputs(id, [{ output_type: 'stream', name: 'stdout', text: ['x\n'] }], nb);
		nbmod.setCellType(id, 'markdown', nb);
		const asMd = cellOf(nb, id);
		expect(asMd.metadata?.cellar?.role).toBeUndefined();
		expect(asMd.outputs).toEqual([]);
		expect(asMd.metadata?.cellar?.export).toBe(true);
	});
});

describe('setExportTarget accepts .mojo and still refuses anything else', () => {
	it('stores a .mojo target and refuses a .ts one', async () => {
		const nb = nbmod.resolveNotebookPath('target.ipynb');
		svc.useNotebook('sess-target', 'target.ipynb');
		await svc.addCells([{ cell_type: 'code', source: 'x = 1' }], null, { nb, routeImports: false });
		nbmod.setNotebookLanguage('mojo', nb); // the extension follows the language
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

	it('eligibility is a MATCH in both directions, for every cell language', () => {
		// One sentence - a cell is exportable to its notebook's module iff its language
		// matches - gives every answer, so neither language is a special case of the
		// other and a `&& !isMojoCell(cell)` exclusion could not produce this table (it
		// has no `.mojo` module to answer for).
		const code = { cell_type: 'code', source: 'x = 1' };
		const mojoMagic = { cell_type: 'code', source: '%%mojo\ndef main(): ...' };
		const md = { cell_type: 'markdown', source: '# hi' };
		// A plain code cell belongs to its OWN notebook's module, whichever that is:
		// the module's language IS the notebook's, so there is nothing to mismatch.
		expect(canExportCell(code, 'python')).toBe(true);
		expect(canExportCell(code, 'mojo')).toBe(true);
		// A cell whose SOURCE names its own language is the one real mismatch.
		expect(canExportCell(mojoMagic, 'mojo')).toBe(true);
		expect(canExportCell(mojoMagic, 'python')).toBe(false);
		// A cell that contributes no module source at all matches NEITHER.
		expect(canExportCell(md, 'python')).toBe(false);
		expect(canExportCell(md, 'mojo')).toBe(false);
	});

	it('eligibility is judged by the NOTEBOOK, not by the nullable module language', () => {
		// The cell row has BOTH values in hand - the notebook's language and the
		// module's, which is null until a target names one - and only one of them may
		// decide eligibility. `exportEligibilityLanguage` is where that choice lives,
		// so it can be driven here at all: vitest runs without the SvelteKit plugin, so
		// the component cannot be mounted, and e2e runs in neither CI nor the gate.
		//
		// THE CASE THAT MATTERS is a Mojo notebook with NO target yet. Judged by the
		// module language (`module ?? 'python'`) it answers `python`, so the row greys a
		// perfectly valid mark as STRANDED while the notebook-wide explanation - derived
		// from the notebook's language - reports none, and clicking that greyed toggle
		// CLEARS a mark the server considers eligible.
		expect(exportEligibilityLanguage('mojo', null)).toBe('mojo');
		expect(exportEligibilityLanguage('python', null)).toBe('python');
		// Where a target DOES name a module the two values are equal (the module's
		// language FOLLOWS the notebook's), so nothing else moves.
		expect(exportEligibilityLanguage('mojo', 'mojo')).toBe('mojo');
		expect(exportEligibilityLanguage('python', 'python')).toBe('python');

		// And that is what the eligibility rule then ANSWERS, which is the consequence
		// the row renders: a plain code cell of an untargeted Mojo notebook is
		// exportable and NOT stranded, where the old form made it both ineligible and
		// stranded at once.
		const code = { cell_type: 'code', source: 'def main(): ...', metadata: { cellar: { export: true } } };
		const lang = exportEligibilityLanguage('mojo', null);
		expect(canExportCell(code, lang)).toBe(true);
		expect(isExportCell(code, lang)).toBe(true);
		expect(exportMarkStranded(code, lang)).toBe(false);
	});

	it('a surface that SPEAKS ABOUT A MODULE reads the nullable one instead', () => {
		// The other half of that same split, and the two must disagree exactly where a
		// call site got it wrong: with no target configured, ELIGIBILITY still answers
		// the notebook's language while anything naming a module answers null.
		expect(exportModuleLanguage('mojo', false)).toBeNull();
		expect(exportModuleLanguage('python', false)).toBeNull();
		expect(exportEligibilityLanguage('mojo', exportModuleLanguage('mojo', false))).toBe('mojo');
		// Once a target names a module the two coincide - the module's language FOLLOWS
		// the notebook's - so nothing else in the bar or the row moves.
		expect(exportModuleLanguage('mojo', true)).toBe('mojo');
		expect(exportModuleLanguage('python', true)).toBe('python');

		// The consequence the badge renders. Fed the NOTEBOOK's language, a Mojo
		// notebook with no target warns that a `main` will be dropped from an export
		// that cannot happen at all - while the server's once-per-notebook twin, gated
		// on a configured target, says nothing.
		const cells = [cell('a', MAIN, { export: true }), cell('b', MAIN, { export: true })];
		expect([...mojoMainDroppedIds(cells, exportModuleLanguage('mojo', false))]).toEqual([]);
		// With a module to be about it speaks, and names the earlier cell - so the gate
		// is what changed, not the rule.
		expect([...mojoMainDroppedIds(cells, exportModuleLanguage('mojo', true))]).toEqual(['a']);
	});

	it('the client half KEEPS the export mark on a type change, like the server', () => {
		// The two halves must stay in lockstep (`cell:type` carries no metadata, so a
		// client that dropped the flag would draw a cell as unmarked until a reload,
		// with no event able to correct it). Only source can say this: vitest runs
		// without the SvelteKit plugin, so the component cannot be mounted. The SERVER
		// half's behaviour is asserted against the real document above.
		const live = read('LiveNotebook.svelte');
		const fn = live.slice(live.indexOf('function applyCellTypeLocally('));
		const body = fn.slice(0, fn.indexOf('\n\t}\n'));
		expect(body).toContain('if (!runnable && cellar.role === IMPORTS_ROLE) delete cellar.role;');
		expect(body).not.toContain('delete cellar.export');
	});

	it('the export button names no extension when there is no target', () => {
		// A button reading "Export to .py" while its own click handler answers "Set a
		// target module path first" tells the user something untrue. The null branch is
		// the same one `exportModuleLabel`, `exportStrandedExplanation` and the MCP
		// refusal already carry.
		const bar = read('Notebook.svelte');
		expect(bar).toContain("exportLanguage === null ? 'Export' :");
		expect(bar).toContain('{exporting ? \'Exporting…\' : exportButtonLabel}');
		expect(bar).not.toContain('`Export to ${exportExtension}`');
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

	it('the stranded reason is stated ONCE for the notebook, never once per cell', () => {
		// The captain's correction: the greyed toggle stays, but the notebook-wide fact
		// belongs in the bar. Fifteen repointed cells must not render fifteen copies of
		// one sentence, each wrapping that cell's toolbar row - the Databricks runtime
		// card renders its reason once on the card, not once per control.
		const cell = read('Cell.svelte');
		const bar = read('Notebook.svelte');
		// The cell carries the SHORT shared marker and its short shared title...
		expect(cell).toContain('data-testid="export-stranded-badge"');
		expect(cell).toContain('{EXPORT_STRANDED_BADGE}');
		expect(cell).toContain('EXPORT_STRANDED_CELL_TITLE');
		// ...and no sentence of its own, by any route (the CALL form, so the comment
		// that points at the bar's rule is not mistaken for a second copy of it).
		expect(cell).not.toContain('exportStrandedReason');
		expect(cell).not.toContain('exportStrandedExplanation(');
		// ...while the bar renders the one explanation, built by the shared rule.
		expect(bar).toContain('data-testid="export-stranded"');
		expect(bar).toContain('exportStrandedExplanation(exportStranded, exportLanguage)');
		expect(bar).toContain('{strandedExplanation}');
	});

	it('the nullable module language reaches the bar, and it is the NOTEBOOK\'s', () => {
		// `exportLanguage` is null when NO target is configured, and only the nullable
		// value can tell that from a configured one - every SENTENCE reads it, so a
		// fallback applied before the prop is passed down would name a module the
		// notebook does not have.
		//
		// Its VALUE is the notebook's language, never the path's extension: deriving it
		// from the path here would put back the second spelling able to contradict the
		// notebook, which is exactly what this axis removes. BOTH halves of that split
		// now live in `exportRole` (`exportModuleLanguage` / `exportEligibilityLanguage`)
		// and are driven against their real inputs above, so what is left for source to
		// say is only that the nullable one is what reaches the bar.
		const live = read('LiveNotebook.svelte');
		expect(live).toContain('exportLanguage={exportModuleLanguage}');
		expect(live).toContain('exportStranded={exportStranded}');
	});

	it('the unsaved-edit notice names the target module, and names NONE with no target', () => {
		// Same missed-site class as the label sweep: on a `.mojo` notebook a failed
		// autosave during an export or a mark reported ".py module" about a file the
		// notebook never writes. It is also reachable with NO target at all - both
		// callers settle their cell edits before the server ever answers `no-target` -
		// so the null branch is required too, exactly as on the export button and the
		// cell toggle. Wording that lives inline in a component vitest cannot mount, so
		// this is one of the documented `.svelte` source guards.
		const live = read('LiveNotebook.svelte');
		expect(live).toContain(
			"`a cell edit that belongs in the ${exportModuleLanguage === null ? 'module' : `${exportModuleLanguage === 'mojo' ? '.mojo' : '.py'} module`} could not be saved`"
		);
		// The two shapes that name `.py` for a notebook that targets nothing.
		expect(live).not.toContain("const UNSAVED_EXPORT_EDIT = 'a cell edit that belongs in the .py module");
		expect(live).not.toContain(
			"`a cell edit that belongs in the ${exportModuleLanguage === 'mojo' ? '.mojo' : '.py'} module could not be saved`"
		);
	});

	it('the export toggle REVERTS an ineligible mark the server refused', () => {
		// The route's 409 is asserted behaviourally in
		// `tests/unit/nbdev-export-directive.test.ts`; what only source can say is that
		// the browser ACTS on it. `not-code` is reachable from the UI because
		// eligibility is a notebook-level fact this tab mirrors over SSE, so a target
		// change in flight elsewhere lets it offer a mark the document refuses - and an
		// unreverted optimistic write leaves the row, and the export bar's count,
		// asserting a mark that exists in no file. One of the documented `.svelte`
		// guards: vitest runs without the SvelteKit plugin, so the component cannot be
		// mounted, and e2e is absent from both CI and the gate.
		const live = read('LiveNotebook.svelte');
		const fn = live.slice(live.indexOf('async function setExport('));
		const body = fn.slice(0, fn.indexOf('\n\t}\n'));
		expect(body).toContain(
			"if (verdict?.reason !== 'export-directive-owns-cell' && verdict?.reason !== 'not-code') return;"
		);
		expect(body).toContain("verdict.reason === 'not-code'");
		expect(body).toContain('exportIneligibleNotice(id)');
	});

	it('the notebook derives the badge set from the shared rule, per cell', () => {
		// WHICH language it is fed is the split asserted behaviourally above (a
		// module-speaking surface reads the nullable one); what only source can say is
		// that the set is derived from the shared rule and handed down per cell.
		expect(read('LiveNotebook.svelte')).toMatch(/mojoMainDropped = \$derived\(\s*mojoMainDroppedIds\(/);
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

		const noMainText = generateModule(CELLS.map((c) => c.replace(/\ndef main\(\):[\s\S]*$/, '\n')), 'n.ipynb', 'mojo');
		writeFileSync(join(dir, 'nomain.mojo'), noMainText);
		const noMain = mojo(dir, ['build', 'nomain.mojo', '--emit', 'shared-lib', '-o', join(dir, 'nomain.so')]);
		expect(noMain.ok, noMain.out).toBe(true);
		expect(existsSync(join(dir, 'nomain.so'))).toBe(true);

		// The IN-MODULE note is written against exactly this measurement, so it is
		// asserted against the two modules the measurement just produced: present on
		// the one the toolchain refuses, absent from the one it builds.
		expect(readFileSync(join(dir, 'vectors.mojo'), 'utf8')).toContain(MAIN_KEPT_COMMENT);
		expect(noMainText).not.toContain(MAIN_KEPT_COMMENT);
		expect(withMain.out).toContain("shared library should not contain a 'main' function");
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

	it('a column-0 comment inside a dropped main leaves a module that compiles', () => {
		// "Silently uncompilable" is a property only the compiler can prove. The shipped
		// scan ended the body at the comment and orphaned `print(2)` at file scope; the
		// CONTROL below runs the same cells through the un-fixed shape so this case
		// cannot pass vacuously.
		const cells = ['def main():\n    print(1)\n# a separator\n    print(2)\n', 'def main():\n    print("keeper")'];
		writeFileSync(join(dir, 'col0comment.mojo'), generateModule(mojoModuleSources(cells).sources, 'c0.ipynb', 'mojo'));
		const r = mojo(dir, ['doc', 'col0comment.mojo', '-o', '/dev/null']);
		expect(r.out, r.out).not.toMatch(/error:/);
		expect(r.ok).toBe(true);
		// The INPUT was legitimate all along: the untouched first cell runs and prints
		// 1 then 2, so nothing about it justified generating a broken module.
		writeFileSync(join(dir, 'col0input.mojo'), cells[0]);
		const input = mojo(dir, ['run', 'col0input.mojo']);
		expect(input.ok, input.out).toBe(true);
		expect(input.out.replace(/\s+/g, ' ')).toContain('1 2');

		// CONTROL: the pre-fix residue - the body cut at the comment - is what the
		// compiler rejects, which is what makes the assertion above load-bearing.
		writeFileSync(
			join(dir, 'col0broken.mojo'),
			generateModule([`${MAIN_DROPPED_COMMENT}\n# a separator\n    print(2)\n`, cells[1]], 'cb.ipynb', 'mojo')
		);
		const broken = mojo(dir, ['doc', 'col0broken.mojo', '-o', '/dev/null']);
		expect(broken.ok).toBe(false);
	});

	it('a decorator held off from its main by a BLANK line leaves nothing stranded', () => {
		// The measured consequence that makes this the worst of the three decorator
		// shapes: a stranded decorator followed by another `def` COMPILES CLEAN and
		// silently attaches to a function the user never decorated, so no compile-based
		// assertion can catch it. Both halves are driven here - the fixed module runs
		// correctly, and the pre-fix residue is shown to be SILENT, which is what makes
		// the text assertions in the unit tier load-bearing rather than belt-and-braces.
		const cells = [
			'@parameter\n\ndef main():\n    print("dropped")\n\ndef lead() -> Int:\n    return 7\n',
			'def main():\n    print("kept", lead())\n'
		];
		writeFileSync(join(dir, 'deco_blank.mojo'), generateModule(mojoModuleSources(cells).sources, 'db.ipynb', 'mojo'));
		const r = mojo(dir, ['run', 'deco_blank.mojo']);
		expect(r.ok, r.out).toBe(true);
		expect(r.out).toContain('kept 7');

		writeFileSync(
			join(dir, 'deco_stranded.mojo'),
			`@parameter\n\n${MAIN_DROPPED_COMMENT}\n\ndef lead() -> Int:\n    return 7\n\ndef main():\n    print("kept", lead())\n`
		);
		const stranded = mojo(dir, ['doc', 'deco_stranded.mojo', '-o', '/dev/null']);
		expect(stranded.out, stranded.out).not.toMatch(/error:/);
		expect(stranded.ok).toBe(true);
	});

	it('a decorator held off by a COMMENT is absorbed, and stranding it is LOUD', () => {
		const cells = [
			'@parameter\n# why this one is parameterised\ndef main():\n    print("dropped")\n\nstruct Pair(Copyable, Movable):\n    var a: Int\n    var b: Int\n    def __init__(out self, a: Int, b: Int):\n        self.a = a\n        self.b = b\n',
			'def main():\n    var p = Pair(2, 3)\n    print("kept", p.a + p.b)\n'
		];
		writeFileSync(join(dir, 'deco_comment.mojo'), generateModule(mojoModuleSources(cells).sources, 'dc.ipynb', 'mojo'));
		const r = mojo(dir, ['run', 'deco_comment.mojo']);
		expect(r.ok, r.out).toBe(true);
		expect(r.out).toContain('kept 5');

		// CONTROL: the pre-fix residue - the decorator and its comment left above a
		// `struct` - is what the compiler rejects, which is what makes the assertion
		// above load-bearing for this shape rather than passing vacuously.
		writeFileSync(
			join(dir, 'deco_comment_broken.mojo'),
			`@parameter\n# why this one is parameterised\n${MAIN_DROPPED_COMMENT}\n\nstruct Pair(Copyable, Movable):\n    var a: Int\n    var b: Int\n    def __init__(out self, a: Int, b: Int):\n        self.a = a\n        self.b = b\n`
		);
		expect(mojo(dir, ['doc', 'deco_comment_broken.mojo', '-o', '/dev/null']).ok).toBe(false);
	});

	it('a MULTI-LINE decorator is absorbed whole, fragment and all', () => {
		// Here the fixed-module assertion is itself the proof: any partial absorption
		// leaves `@always_inline(`, its argument or a bare `)` at file scope, and the
		// compiler rejects every one of those.
		const cells = [
			'@always_inline(\n    "nodebug"\n)\ndef main():\n    print("dropped")\n\ndef twice(x: Int) -> Int:\n    return x * 2\n',
			'def main():\n    print("kept", twice(21))\n'
		];
		writeFileSync(join(dir, 'deco_multiline.mojo'), generateModule(mojoModuleSources(cells).sources, 'dm.ipynb', 'mojo'));
		const r = mojo(dir, ['run', 'deco_multiline.mojo']);
		expect(r.ok, r.out).toBe(true);
		expect(r.out).toContain('kept 42');
	});

	it('a bracket continuation dedented to column 0 stays inside the dropped block', () => {
		const cells = [
			'def add(a: Int, b: Int) -> Int:\n    return a + b\n\ndef main():\n    var x = add(\n1,\n2,\n)\n    print("dropped", x)\n',
			'def main():\n    print("kept", add(20, 22))\n'
		];
		// The INPUT is legitimate Mojo - inside brackets indentation carries no meaning -
		// so nothing about it justified generating a broken module.
		writeFileSync(join(dir, 'cont_input.mojo'), cells[0]);
		const input = mojo(dir, ['run', 'cont_input.mojo']);
		expect(input.ok, input.out).toBe(true);

		writeFileSync(join(dir, 'cont.mojo'), generateModule(mojoModuleSources(cells).sources, 'ct.ipynb', 'mojo'));
		const r = mojo(dir, ['run', 'cont.mojo']);
		expect(r.ok, r.out).toBe(true);
		expect(r.out).toContain('kept 42');

		// CONTROL: the pre-fix residue - the body cut at `1,` - orphans the rest of the
		// statement, and the indented line after it, at file scope.
		writeFileSync(
			join(dir, 'cont_broken.mojo'),
			`def add(a: Int, b: Int) -> Int:\n    return a + b\n\n${MAIN_DROPPED_COMMENT}\n1,\n2,\n)\n    print("dropped", x)\n`
		);
		expect(mojo(dir, ['doc', 'cont_broken.mojo', '-o', '/dev/null']).ok).toBe(false);
	});

	it('CONTROL: the Python generator output fails on __all__ AND on duplicate main', () => {
		const r = mojo(dir, ['doc', 'control_py.mojo', '-o', '/dev/null']);
		expect(r.ok).toBe(false);
		expect(r.out).toMatch(/expressions must not appear at file scope/); // __all__
		expect(r.out).toMatch(/redefinition of function 'main'/);
	});
});
