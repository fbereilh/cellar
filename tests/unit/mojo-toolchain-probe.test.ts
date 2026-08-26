/**
 * The Mojo setup probe and the compiled `%%mojo` cell, run for REAL.
 *
 * Two tiers, because the toolchain is a 534 MB download Cellar deliberately never
 * installs (and therefore cannot assume on a test machine):
 *
 *  - UNCONDITIONAL: `MOJO_SETUP_CODE` is embedded in TypeScript as a template
 *    literal, so a stray backtick or a broken indent is a runtime error inside a
 *    silent kernel exec - the one place a mistake is invisible. Compiling it with
 *    the real Python compiler is cheap and catches exactly that.
 *  - GATED on `CELLAR_MOJO_PYTHON` (an interpreter with `max` AND `ipython`), with
 *    the reason IN THE SUITE NAME so a green run is never mistakable for a verified
 *    one - the `databricks-logout.test.ts` convention. Point it at a venv built with
 *    `uv pip install max ipython`.
 *
 * The gated half is what proves the compiled form is the form Modular actually
 * runs: `import mojo.notebook` outside an IPython context raises
 * `NameError: Decorator can only run in context where get_ipython exists` (measured
 * against max 26.5.0), so a plain `python -c` check would report the toolchain
 * missing on a machine that has it - which is why the probe runs INSIDE the kernel.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MOJO_SETUP_CODE, MOJO_SETUP_MARKER, mojoToCellSource, parseMojoSetup } from '../../src/lib/server/mojo';

const MOJO_PY = process.env.CELLAR_MOJO_PYTHON ?? '';
const why = MOJO_PY ? '' : ' [SKIPPED: set CELLAR_MOJO_PYTHON to an interpreter with `max` + `ipython`]';

/** Run `code` through a real IPython shell and return everything it printed. */
function runInIPython(python: string, cells: string[]): string {
	const dir = mkdtempSync(join(tmpdir(), 'cellar-mojo-probe-'));
	cells.forEach((c, i) => writeFileSync(join(dir, `c${i}.txt`), c));
	const driver = join(dir, 'driver.py');
	writeFileSync(
		driver,
		[
			'import pathlib, sys',
			'from IPython.core.interactiveshell import InteractiveShell',
			'ip = InteractiveShell.instance()',
			'd = pathlib.Path(sys.argv[1])',
			`for i in range(${cells.length}):`,
			'    r = ip.run_cell((d / f"c{i}.txt").read_text())',
			'    print(f"__CELL_{i}__ success={bool(r.success)} err={type(r.error_in_exec).__name__ if r.error_in_exec else None}")',
			''
		].join('\n')
	);
	return execFileSync(python, [driver, dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 });
}

describe('the embedded setup probe is valid Python', () => {
	it('compiles under the real compiler, so a template-literal slip cannot ship', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cellar-mojo-compile-'));
		const f = join(dir, 'setup.py');
		writeFileSync(f, MOJO_SETUP_CODE);
		expect(() =>
			execFileSync('python3', ['-c', `compile(open(${JSON.stringify(f)}).read(), "setup", "exec")`], { stdio: 'pipe' })
		).not.toThrow();
	});

	it('leaves no scratch name behind in the namespace it runs in', () => {
		// It runs in the USER's kernel namespace on every first mojo run, so it must
		// clean up after itself exactly as every other Cellar injection does.
		expect(MOJO_SETUP_CODE).toContain('del _cellar_mojo_setup');
	});
});

describe(`the REAL %%mojo path${why}`, () => {
	it.skipIf(!MOJO_PY)('registers the magic, and the compiled cell runs Mojo', () => {
		const out = runInIPython(MOJO_PY, [MOJO_SETUP_CODE, mojoToCellSource('def main():\n    print("Hello from Mojo!")\n')]);
		const marker = out.split('\n').find((l) => l.startsWith(MOJO_SETUP_MARKER)) ?? '';
		expect(parseMojoSetup(marker).ready).toBe(true);
		expect(out).toContain('__CELL_0__ success=True');
		expect(out).toContain('Hello from Mojo!');
		expect(out).toContain('__CELL_1__ success=True');
	});

	it.skipIf(!MOJO_PY)('runs a %%mojo SUBCOMMAND form unchanged (the pass-through case)', () => {
		const src = '%%mojo run\ndef main():\n    print("subcommand ok")\n';
		expect(mojoToCellSource(src)).toBe(src);
		const out = runInIPython(MOJO_PY, [MOJO_SETUP_CODE, mojoToCellSource(src)]);
		expect(out).toContain('subcommand ok');
		expect(out).toContain('__CELL_1__ success=True');
	});

	it.skipIf(!MOJO_PY)('surfaces a Mojo COMPILE ERROR as the cell failing, with the diagnostic', () => {
		const out = runInIPython(MOJO_PY, [MOJO_SETUP_CODE, mojoToCellSource('def main():\n    this_does_not_exist()\n')]);
		expect(out).toContain('__CELL_1__ success=False err=MojoCompilationError');
		// Cell-RELATIVE line/column, because the body is written verbatim with no preamble.
		expect(out).toMatch(/cell\.mojo:2:\d+: error: use of unknown declaration/);
	});

	it.skipIf(!MOJO_PY)('MEASURES the no-state-between-cells semantics this type documents', () => {
		// Modular's, not Cellar's: each %%mojo cell is a fresh `mojo run` subprocess.
		// If this ever passes, Modular changed the magic and the UI copy is now wrong.
		const out = runInIPython(MOJO_PY, [
			MOJO_SETUP_CODE,
			mojoToCellSource('def main():\n    var x = 41\n    print(x)\n'),
			mojoToCellSource('def main():\n    print("x is", x)\n')
		]);
		expect(out).toContain('__CELL_1__ success=True');
		expect(out).toContain('__CELL_2__ success=False err=MojoCompilationError');
	});
});

describe('the probe reports HONESTLY when the toolchain is absent', () => {
	it('a bare interpreter with IPython but no max reports not-ready with the real reason', () => {
		const bare = process.env.CELLAR_BARE_PYTHON ?? '';
		if (!bare) return; // covered by the parse-level tests in mojo-cell-type.test.ts
		const out = runInIPython(bare, [MOJO_SETUP_CODE]);
		const marker = out.split('\n').find((l) => l.startsWith(MOJO_SETUP_MARKER)) ?? '';
		const setup = parseMojoSetup(marker);
		expect(setup.ready).toBe(false);
		expect(setup.detail).toMatch(/No module named 'mojo'/);
		expect(out).toContain('__CELL_0__ success=True'); // never raises: it reports
	});
});
