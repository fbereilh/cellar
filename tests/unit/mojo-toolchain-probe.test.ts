/**
 * The Mojo setup probe and the compiled `%%mojo` cell, run for REAL.
 *
 * Two tiers, because the toolchain is a 534 MB download Cellar deliberately never
 * installs (and therefore cannot assume on a test machine):
 *
 *  - UNCONDITIONAL, on a plain `python3`: `MOJO_SETUP_CODE` is embedded in
 *    TypeScript as a template literal, so a stray backtick or a broken indent is a
 *    runtime error inside a silent kernel exec - the one place a mistake is
 *    invisible. Running it for real is cheap and catches exactly that, and it also
 *    exercises the three behaviours that DO NOT need the toolchain: the observed
 *    absence, the mid-session install recovery, and the no-verdict a probe reaches
 *    when something that is not an ImportError stops it. A STUB `mojo` package on
 *    `sys.path` is all those need - no IPython, no `max` - so they run in CI, where
 *    the gated tier below never does.
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
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

/**
 * Run `MOJO_SETUP_CODE` for real in a plain `python3` with `site` as the only extra
 * `sys.path` entry, and report what it printed plus whether it left its scratch name
 * behind in the namespace it ran in. `between`, when given, is driver Python run
 * BETWEEN two probes of the same namespace - which is how the mid-session install is
 * exercised without a 534 MB download.
 */
function runProbe(site: string, between?: string): { markers: string[]; leaked: boolean } {
	const dir = mkdtempSync(join(tmpdir(), 'cellar-mojo-probe-run-'));
	const codeFile = join(dir, 'probe.py');
	writeFileSync(codeFile, MOJO_SETUP_CODE);
	const driver = join(dir, 'driver.py');
	writeFileSync(
		driver,
		[
			'import os, pathlib, sys',
			'code = compile(pathlib.Path(sys.argv[1]).read_text(), "probe", "exec")',
			'site = pathlib.Path(sys.argv[2])',
			'site.mkdir(parents=True, exist_ok=True)',
			'sys.path.insert(0, str(site))',
			'g = {}',
			'exec(code, g)',
			...(between ? [between, 'exec(code, g)'] : []),
			'print("__LEAKED__", "_cellar_mojo_setup" in g)',
			''
		].join('\n')
	);
	const out = execFileSync('python3', [driver, codeFile, site], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 120_000
	});
	return {
		markers: out.split('\n').filter((l) => l.startsWith(MOJO_SETUP_MARKER)),
		leaked: out.includes('__LEAKED__ True')
	};
}

describe('the embedded setup probe, RUN for real on a plain python3', () => {
	it('reports the OBSERVED absence and leaves no scratch name behind', () => {
		// The probe is embedded as a template literal, so a stray backtick or a broken
		// indent is a runtime error inside a silent kernel exec - the one place a
		// mistake is invisible. And it runs in the USER's kernel namespace on every
		// first mojo run, so it must clean up after itself like every other injection.
		const { markers, leaked } = runProbe(join(mkdtempSync(join(tmpdir(), 'cellar-mojo-site-')), 'site'));
		expect(markers).toHaveLength(1);
		const setup = parseMojoSetup(markers[0]);
		expect(setup).not.toBeNull();
		expect(setup?.ready).toBe(false);
		expect(setup?.detail).toMatch(/No module named 'mojo'/);
		expect(leaked).toBe(false);
	});

	it('picks up an install made AFTER a not-ready probe, in the SAME namespace', () => {
		// The whole point of the missing-toolchain instruction is that the user runs
		// `uv pip install max` and re-runs the cell, so the second probe of the same
		// session must see the new package. Python caches each `sys.path` entry's
		// directory listing keyed on that directory's mtime, so the driver puts the
		// mtime BACK after creating the package: that is the stale-cache condition the
		// probe's `importlib.invalidate_caches()` exists for, made deterministic
		// instead of depending on the filesystem's timestamp granularity. Drop that
		// call and this test fails (verified).
		const site = join(mkdtempSync(join(tmpdir(), 'cellar-mojo-site-')), 'site');
		const install = [
			'before = site.stat()',
			'pkg = site / "mojo"',
			'pkg.mkdir()',
			'(pkg / "__init__.py").write_text("")',
			'(pkg / "notebook.py").write_text("")',
			'os.utime(site, (before.st_atime, before.st_mtime))'
		].join('\n');
		const { markers } = runProbe(site, install);
		expect(markers).toHaveLength(2);
		expect(parseMojoSetup(markers[0])?.ready).toBe(false);
		expect(parseMojoSetup(markers[1])?.ready).toBe(true);
	});

	it('reaches NO VERDICT when something that is not an ImportError stops it', () => {
		// THE STOP-BUTTON REGRESSION. The probe runs inside a cell that has already
		// emitted `run:start` and holds the queue's `running` slot, so the user can
		// press Stop while it is executing; `interruptKernel` signals unconditionally
		// and the KeyboardInterrupt lands in the import. Caught by a blanket
		// `except BaseException`, that was reported as `ready:false` and rendered as
		// `MojoToolchainMissing` - a 534 MB install instruction for a cell the user
		// simply cancelled. It must be NO VERDICT (null), so the run falls through to
		// `execute()`, which owns the watchdog and reports honestly.
		const site = join(mkdtempSync(join(tmpdir(), 'cellar-mojo-site-')), 'site');
		mkdirSync(join(site, 'mojo'), { recursive: true });
		writeFileSync(join(site, 'mojo', '__init__.py'), 'raise KeyboardInterrupt()\n');
		writeFileSync(join(site, 'mojo', 'notebook.py'), '');
		const { markers, leaked } = runProbe(site);
		expect(markers).toHaveLength(1);
		expect(parseMojoSetup(markers[0])).toBeNull();
		// It still never raises out of the probe, and still cleans up after itself.
		expect(leaked).toBe(false);
	});
});

describe(`the REAL %%mojo path${why}`, () => {
	it.skipIf(!MOJO_PY)('registers the magic, and the compiled cell runs Mojo', () => {
		const out = runInIPython(MOJO_PY, [MOJO_SETUP_CODE, mojoToCellSource('def main():\n    print("Hello from Mojo!")\n')]);
		const marker = out.split('\n').find((l) => l.startsWith(MOJO_SETUP_MARKER)) ?? '';
		expect(parseMojoSetup(marker)?.ready).toBe(true);
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
		expect(setup?.ready).toBe(false);
		expect(setup?.detail).toMatch(/No module named 'mojo'/);
		expect(out).toContain('__CELL_0__ success=True'); // never raises: it reports
	});
});
