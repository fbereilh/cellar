/**
 * Mojo declaration carry-over - the pure rules (`$lib/mojoCarry`).
 *
 * Two tiers, the `mojo-export.test.ts` convention:
 *  - UNCONDITIONAL: how a source splits into top-level blocks, which blocks reach
 *    a cell's program, and what the program text looks like. These run in CI.
 *  - GATED on `CELLAR_MOJO_BIN` (a real `mojo` binary), with the reason IN THE
 *    SUITE NAME. That tier is what turns "the text looks right" into "Mojo
 *    compiles it and prints the right thing", and it carries the CONTROLS: the
 *    same cells without the carry fail the way the feature exists to remove.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMojoProgram, topLevelBlocks, MOJO_CARRY_MARKER, MOJO_SYNTHESIZED_MAIN, type CarriedCell } from '../../src/lib/mojoCarry';

const STRUCT = '@fieldwise_init\nstruct Point(Copyable):\n    var x: Int\n    var y: Int';
const HELPER = 'def twice(x: Int) -> Int:\n    return x * 2';
const cells = (...sources: string[]): CarriedCell[] => sources.map((source, i) => ({ seq: i + 1, source }));

describe('topLevelBlocks', () => {
	it('splits a source into its top-level statements and names what each declares', () => {
		const src = `from std.time import sleep, perf_counter as pc\nimport std.math\ncomptime K = 3\n\n${STRUCT}\n\n${HELPER}\n\ndef main():\n    print(1)\n`;
		const blocks = topLevelBlocks(src);
		expect(blocks.map((b) => [b.kind, b.names])).toEqual([
			['import', ['sleep', 'pc']],
			['import', ['std']],
			['comptime', ['K']],
			['struct', ['Point']],
			['def', ['twice']],
			['def', ['main']]
		]);
		// A decorator travels with the declaration under it.
		expect(blocks[3].text).toBe(STRUCT);
	});

	it('keeps a body that holds column-0 comments, strings and bracket continuations whole', () => {
		const src = 'def f() -> Int:\n    var s = """\ndef fake():\n"""\n# a separator\n    var x = add(\n1,\n)\n    return x\n\ndef g():\n    pass';
		const blocks = topLevelBlocks(src);
		expect(blocks.map((b) => b.names)).toEqual([['f'], ['g']]);
		expect(blocks[0].text).toContain('return x');
	});

	it('leaves a trailing comment out of the block above it', () => {
		const blocks = topLevelBlocks('def f():\n    pass\n\n# about g\ndef g():\n    pass');
		expect(blocks[0].text).toBe('def f():\n    pass');
	});

	it('reads a multi-line import list, and names nothing for a star import', () => {
		const blocks = topLevelBlocks('from a import (\n    b,  # why\n    c as d,\n)\nfrom e import *');
		expect(blocks.map((b) => b.names)).toEqual([['b', 'd'], []]);
	});

	it('does not mistake `comptime if` for a declaration', () => {
		expect(topLevelBlocks('comptime if X:\n    pass')[0]).toMatchObject({ kind: 'other', names: [] });
	});
});

describe('buildMojoProgram', () => {
	it('leaves a self-contained cell byte-identical, whatever ran before', () => {
		// The Modular-style notebook: every cell is a whole program that declares
		// its own helpers. Carrying a second `twice` would be a hard compile error.
		const cell = `${HELPER}\n\ndef main():\n    print(twice(2))`;
		const out = buildMojoProgram(cell, cells(`${HELPER}\n\ndef main():\n    print(twice(1))`, STRUCT));
		expect(out).toEqual({ program: cell, synthesizedMain: false, carried: [] });
	});

	it('appends what the cell reaches AFTER its own source, so its line numbers hold', () => {
		const cell = 'def main():\n    print(twice(2))';
		const out = buildMojoProgram(cell, cells(HELPER, STRUCT));
		expect(out.program).toBe(`${cell}\n\n${MOJO_CARRY_MARKER}\n${HELPER}\n`);
		expect(out.carried).toEqual(['twice']);
		expect(out.synthesizedMain).toBe(false);
	});

	it('follows dependencies through carried blocks, and brings their cell\'s imports', () => {
		const a = `from std.math import sqrt\n\n${STRUCT}`;
		const b = 'def norm(p: Point) -> Float64:\n    return sqrt(Float64(p.x * p.x + p.y * p.y))';
		const out = buildMojoProgram('def main():\n    print(norm(Point(3, 4)))', cells(a, b));
		expect(out.carried).toEqual(['sqrt', 'Point', 'norm']);
	});

	it('gives a definitions-only cell a no-op main', () => {
		const out = buildMojoProgram(HELPER, []);
		expect(out.synthesizedMain).toBe(true);
		expect(out.program).toBe(`${HELPER}\n\n${MOJO_SYNTHESIZED_MAIN}\n`);
	});

	it('never carries another cell\'s main', () => {
		const out = buildMojoProgram('def helper():\n    main()', cells('def main():\n    print(1)'));
		expect(out.program).not.toContain('print(1)');
	});

	it('takes each name from the cell that RAN last, with all of that cell\'s overloads', () => {
		const old = 'def area(x: Int) -> Int:\n    return 1';
		const next = 'def area(x: Int) -> Int:\n    return 2\n\ndef area(x: Float64) -> Float64:\n    return 2.0';
		const out = buildMojoProgram('def main():\n    print(area(1))', [
			{ seq: 5, source: next },
			{ seq: 2, source: old }
		]);
		expect(out.program).toContain('return 2\n');
		expect(out.program).toContain('return 2.0');
		expect(out.program).not.toContain('return 1');
	});

	it('lets the running cell shadow a carried name, including an imported one', () => {
		const out = buildMojoProgram('from mine import sqrt\n\ndef main():\n    print(norm())', cells('from std.math import sqrt\n\ndef norm() -> Float64:\n    return sqrt(4.0)'));
		expect(out.carried).toEqual(['norm']);
		expect(out.program).not.toContain('std.math');
	});

	it('leaves an empty cell and a `%%mojo` cell exactly alone, in both directions', () => {
		expect(buildMojoProgram('', cells(HELPER)).program).toBe('');
		const magic = '%%mojo build -o x.so\ndef f():\n    twice(1)';
		expect(buildMojoProgram(magic, cells(HELPER))).toEqual({ program: magic, synthesizedMain: false, carried: [] });
		// A magic cell contributes nothing either.
		expect(buildMojoProgram('def main():\n    print(twice(1))', cells(`%%mojo\n${HELPER}`)).carried).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// the REAL toolchain
// ---------------------------------------------------------------------------

const MOJO_BIN = process.env.CELLAR_MOJO_BIN ?? '';
const why = MOJO_BIN ? '' : ' [SKIPPED: set CELLAR_MOJO_BIN to a real `mojo` binary]';

describe.skipIf(!MOJO_BIN)(`carried programs against a REAL mojo${why}`, () => {
	let dir: string;
	let n = 0;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'cellar-mojo-carry-'));
	});
	/** Run one program the way the `%%mojo` magic does. Never throws. */
	function run(program: string): { ok: boolean; out: string } {
		const file = join(dir, `cell${++n}.mojo`);
		writeFileSync(file, program);
		try {
			return { ok: true, out: execFileSync(MOJO_BIN, ['run', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }) };
		} catch (e) {
			const err = e as { stdout?: string; stderr?: string };
			return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
		}
	}

	const A = `from std.math import sqrt\ncomptime SCALE = 2\n\n${STRUCT}`;
	const B = 'def norm(p: Point) -> Float64:\n    return sqrt(Float64(p.x * p.x + p.y * p.y)) * SCALE';
	const C = 'def main():\n    print(norm(Point(3, 4)))';

	it('CONTROL: without the carry, a definitions-only cell and a later use both fail', () => {
		expect(run(A).out).toContain('does not define a `main` function');
		expect(run(C).out).toContain('unknown declaration');
	});

	it('runs a three-cell notebook: definitions, a function built on them, then a use', () => {
		const a = buildMojoProgram(A, []);
		expect(run(a.program)).toEqual({ ok: true, out: '' });
		const b = buildMojoProgram(B, cells(A));
		expect(run(b.program)).toEqual({ ok: true, out: '' });
		const c = buildMojoProgram(C, cells(A, B));
		expect(run(c.program)).toEqual({ ok: true, out: '10.0\n' });
	});

	it('CONTROL: carrying EVERYTHING breaks a Modular-style notebook, the closure does not', () => {
		const one = `${HELPER}\n\ndef main():\n    print(twice(1))`;
		const two = `${HELPER}\n\ndef main():\n    print(twice(2))`;
		expect(run(`${two}\n${HELPER}\n`).out).toContain('redefinition');
		expect(run(buildMojoProgram(two, cells(one)).program)).toEqual({ ok: true, out: '4\n' });
	});

	it('keeps a compile error in the cell on the cell\'s own line', () => {
		const out = run(buildMojoProgram('def main():\n    print(twice(1))\n    oops()', cells(HELPER)).program).out;
		expect(out).toMatch(/cell\d+\.mojo:3:\d+: error/);
	});

	it('a re-run with a changed definition replaces the old one', () => {
		const v2 = 'def twice(x: Int) -> Int:\n    return x * 20';
		const use = 'def main():\n    print(twice(1))';
		expect(run(buildMojoProgram(use, [{ seq: 1, source: HELPER }, { seq: 3, source: v2 }]).program).out).toBe('20\n');
	});
});
