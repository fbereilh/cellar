/**
 * `#|default_exp` resolved through nbdev's `lib_path` - the scout report's section
 * 5.2 bug.
 *
 * Cellar honoured the directive that decides WHERE a module goes while ignoring the
 * config that decides the ROOT it is measured from, so opening nbdev's own
 * `nbs/api/04_export.ipynb` and marking a cell wrote a stray `export.py` at the
 * WORKSPACE ROOT while the project's real module is `nbdev/export.py`. Honouring
 * half of nbdev is worse than honouring none: the target resolves plausibly and
 * writes to the wrong file.
 *
 * ## The two paths the brief requires, both covered here
 *
 *  - **In an nbdev project**, a directive target resolves under `lib_path`.
 *  - **Outside one**, it stays workspace-relative, BYTE-FOR-BYTE as before, so no
 *    existing notebook changes where it writes. That is the regression half and it
 *    is asserted as a positive, not implied.
 *
 * ## The rules, measured against real nbdev 3.3.13 rather than remembered
 *
 * `lib_path` is `[tool.nbdev].lib_path` when present, else `[project].name` with
 * `-` folded to `_`; either way it is resolved against the DIRECTORY HOLDING the
 * `pyproject.toml`, and an absent project name degenerates to that directory. All
 * four were driven through `nbdev.config.get_config()` and a real `nb_export`.
 *
 * ## Refusing rather than degrading
 *
 * An nbdev project whose `lib_path` cannot be read with confidence (an inline
 * `[tool.nbdev]`, unparseable TOML, a non-string value) makes the directive target
 * UNRESOLVABLE rather than workspace-relative - falling back would be the very
 * wrong-file write above. The escape hatch is untouched and is asserted: an explicit
 * `metadata.cellar.export_target` never consults any of this.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The workspace is `<root>/nbs`, so `lib_path` can point at a SIBLING directory. */
let ROOT: string;
let WS: string;
let nbmod: typeof import('../../src/lib/server/notebook');
let expy: typeof import('../../src/lib/server/export-py');
let nbdev: typeof import('../../src/lib/server/nbdev');

beforeAll(async () => {
	ROOT = mkdtempSync(join(tmpdir(), 'cellar-nbdev-libpath-'));
	WS = join(ROOT, 'nbs');
	mkdirSync(WS);
	process.env.CELLAR_WORKSPACE = WS;
	nbmod = await import('../../src/lib/server/notebook');
	expy = await import('../../src/lib/server/export-py');
	nbdev = await import('../../src/lib/server/nbdev');
});

/** Write (or remove) the project `pyproject.toml` above the workspace. */
function pyproject(toml: string | null) {
	const p = join(ROOT, 'pyproject.toml');
	if (toml === null) rmSync(p, { force: true });
	else writeFileSync(p, toml);
	// The reader caches on a short TTL; a test changing the config in the same tick
	// must not be served the previous answer.
	nbdev.invalidateNbdevLibPath();
}

let seq = 0;
let NB: string;
beforeEach(() => {
	NB = `nb${seq++}.ipynb`;
});
afterEach(() => pyproject(null));

function writeNb(rel: string, cells: Array<{ id: string; source: string }>, nbCellar?: Record<string, unknown>) {
	const abs = join(WS, rel);
	writeFileSync(
		abs,
		JSON.stringify({
			cells: cells.map((c) => ({
				id: c.id,
				cell_type: 'code',
				source: c.source.split(/(?<=\n)/),
				metadata: {},
				outputs: [],
				execution_count: null
			})),
			metadata: nbCellar ? { cellar: nbCellar } : {},
			nbformat: 4,
			nbformat_minor: 5
		})
	);
	return abs;
}

/** A notebook whose ONLY target is a `#|default_exp` directive, with one marked cell. */
function directiveNb(module: string) {
	return writeNb(NB, [
		{ id: 'a', source: `#| default_exp ${module}` },
		{ id: 'b', source: '#| export\ndef marked(): return 1' }
	]);
}

describe('nbdevLibPath reads nbdev\'s own rule', () => {
	it('takes an explicit lib_path, relative to the config directory', () => {
		pyproject('[project]\nname = "pkg"\n[tool.nbdev]\nlib_path = "src/mylib"\n');
		expect(nbdev.nbdevLibPath(WS)).toEqual({
			ok: true,
			libPath: join(ROOT, 'src/mylib'),
			configPath: join(ROOT, 'pyproject.toml')
		});
	});

	it('falls back to the project name with dashes folded to underscores', () => {
		pyproject('[project]\nname = "my-lib"\n[tool.nbdev]\nnbs_path = "nbs"\n');
		expect(nbdev.nbdevLibPath(WS)).toMatchObject({ ok: true, libPath: join(ROOT, 'my_lib') });
	});

	it('degenerates to the config directory when there is no project name', () => {
		// nbdev: `lib_name = proj.get('name','')` then `config_path / ''`. Odd, but it is
		// what nbdev does, and mirroring it is the point.
		pyproject('[tool.nbdev]\nnbs_path = "nbs"\n');
		expect(nbdev.nbdevLibPath(WS)).toMatchObject({ ok: true, libPath: ROOT });
	});

	it('is null outside an nbdev project, and for a pyproject with no [tool.nbdev]', () => {
		expect(nbdev.nbdevLibPath(WS)).toBeNull();
		pyproject('[project]\nname = "plain"\n');
		expect(nbdev.nbdevLibPath(WS)).toBeNull();
	});

	it('refuses a [tool.nbdev] it cannot read as a plain table', () => {
		pyproject('[project]\nname = "pkg"\n\n[tool]\nnbdev = { lib_path = "src" }\n');
		const r = nbdev.nbdevLibPath(WS);
		expect(r).toMatchObject({ ok: false });
		expect((r as { reason: string }).reason).toMatch(/not a plain table/);
	});

	it('refuses a lib_path that is not a plain string', () => {
		pyproject('[project]\nname = "pkg"\n[tool.nbdev]\nlib_path = ["a", "b"]\n');
		expect(nbdev.nbdevLibPath(WS)).toMatchObject({ ok: false });
	});
});

describe('a directive target resolves under lib_path', () => {
	it('writes the module into the library, not at the workspace root', () => {
		pyproject('[project]\nname = "pkg"\n[tool.nbdev]\nlib_path = "nbs/pkg"\n');
		directiveNb('core');
		const info = nbmod.exportTargetInfo(NB);
		expect(info).toMatchObject({ ok: true, source: 'default_exp', target: 'pkg/core.py' });

		expect(nbmod.exportPy(NB)).toMatchObject({ written: true, count: 1, target: 'pkg/core.py' });
		expect(readFileSync(join(WS, 'pkg/core.py'), 'utf8')).toContain('def marked()');
		// The bug's signature: a stray module beside the notebook.
		expect(existsSync(join(WS, 'core.py'))).toBe(false);
	});

	it('maps a DOTTED module under lib_path, the way nbdev does', () => {
		pyproject('[project]\nname = "pkg"\n[tool.nbdev]\nlib_path = "nbs/pkg"\n');
		directiveNb('sub.utils');
		expect(nbmod.exportTargetInfo(NB)).toMatchObject({
			ok: true,
			target: 'pkg/sub/utils.py'
		});
	});

	it('refuses when lib_path resolves OUTSIDE the workspace, rather than writing there', () => {
		// The nbdev project legitimately sits above the workspace, so its library can
		// too. The module may only ever be written inside the workspace, and the
		// existing containment guard is what says so - no new escape hatch.
		pyproject('[project]\nname = "pkg"\n[tool.nbdev]\nlib_path = "pkg"\n');
		directiveNb('core');
		const info = nbmod.exportTargetInfo(NB);
		expect(info).toMatchObject({ ok: false, source: 'default_exp' });
		// This is the COMMON real nbdev layout (Cellar opened in `nbs/`, `lib_path` a
		// sibling), so the refusal has to name it and both ways out - the generic guard's
		// "path escapes workspace" is nothing a user can act on.
		const why = (info as { error: string }).error;
		expect(why).toMatch(/OUTSIDE the workspace/);
		expect(why).toContain(join(ROOT, 'pkg'));
		expect(why).toMatch(/Open Cellar at the project root/);
		expect(why).toMatch(/explicit export target/);
		// The manual export SURFACES the refusal (that is how the button reports it);
		// what matters either way is that nothing was written outside the workspace.
		expect(() => nbmod.exportPy(NB)).toThrow(/OUTSIDE the workspace/);
		expect(existsSync(join(ROOT, 'pkg/core.py'))).toBe(false);
	});

	it('refuses - never degrades - when the project config cannot be read', () => {
		pyproject('[project]\nname = "pkg"\n\n[tool]\nnbdev = { lib_path = "src" }\n');
		directiveNb('core');
		const info = nbmod.exportTargetInfo(NB);
		expect(info).toMatchObject({ ok: false, source: 'default_exp' });
		expect((info as { error: string }).error).toMatch(/nbdev project/);
		expect(() => nbmod.exportPy(NB)).toThrow(/nbdev project/);
		// The stray-at-the-workspace-root write is what refusing prevents - and the
		// path that mattered is the SAVE, which is best-effort and must not break: it
		// records the reason instead, and still writes no module.
		nbmod.setSource('b', '#| export\ndef marked(): return 2', NB);
		expect(existsSync(join(WS, 'core.py'))).toBe(false);
		expect(nbmod.lastExportError(NB)).toMatch(/nbdev project/);
	});

	it('leaves an explicit export_target completely alone - the escape hatch', () => {
		pyproject('[project]\nname = "pkg"\n\n[tool]\nnbdev = { lib_path = "src" }\n');
		writeNb(NB, [{ id: 'b', source: '#| export\ndef marked(): return 1' }], {
			export_target: 'chosen/mod.py'
		});
		expect(nbmod.exportTargetInfo(NB)).toMatchObject({
			ok: true,
			source: 'metadata',
			target: 'chosen/mod.py'
		});
		expect(nbmod.exportPy(NB)).toMatchObject({ written: true, target: 'chosen/mod.py' });
	});

	it('lets an explicit export_target OUTRANK a directive, unchanged', () => {
		pyproject('[project]\nname = "pkg"\n[tool.nbdev]\nlib_path = "nbs/pkg"\n');
		writeNb(
			NB,
			[
				{ id: 'a', source: '#| default_exp core' },
				{ id: 'b', source: '#| export\ndef marked(): return 1' }
			],
			{ export_target: 'chosen/mod.py' }
		);
		expect(nbmod.exportTargetInfo(NB)).toMatchObject({
			ok: true,
			source: 'metadata',
			target: 'chosen/mod.py'
		});
	});
});

describe('outside an nbdev project nothing changes', () => {
	it('a directive target stays workspace-relative, exactly as before', () => {
		// The no-regression half, asserted as a positive: every notebook that resolved
		// to `core.py` at the workspace root still does.
		directiveNb('core');
		expect(nbmod.exportTargetInfo(NB)).toMatchObject({
			ok: true,
			base: 'workspace',
			source: 'default_exp',
			target: 'core.py'
		});
		expect(nbmod.exportPy(NB)).toMatchObject({ written: true, target: 'core.py' });
		expect(readFileSync(join(WS, 'core.py'), 'utf8')).toContain('def marked()');
	});

	it('a dotted directive target still maps to a workspace-relative path', () => {
		directiveNb('pkg.utils');
		expect(nbmod.exportTargetInfo(NB)).toMatchObject({
			ok: true,
			target: 'pkg/utils.py'
		});
	});

	it('a trailing comment on the directive line is not part of the module name', () => {
		// fastcore's directive VALUE is the raw remainder of the line, so it keeps a
		// trailing `# note` (the committed differential fixture pins that). A module
		// name is one token, so the target must stop at the first whitespace - taken
		// whole it named a file literally called `core # note.py`.
		directiveNb('core # the module we export to');
		expect(nbmod.exportTargetInfo(NB)).toMatchObject({
			ok: true,
			base: 'workspace',
			source: 'default_exp',
			target: 'core.py'
		});
		expect(nbmod.exportPy(NB)).toMatchObject({ written: true, target: 'core.py' });
		expect(readFileSync(join(WS, 'core.py'), 'utf8')).toContain('def marked()');
	});

	it('a plain pyproject with no [tool.nbdev] is not an nbdev project', () => {
		pyproject('[project]\nname = "plain"\n[tool.ruff]\nline-length = 100\n');
		directiveNb('core');
		expect(nbmod.exportTargetInfo(NB)).toMatchObject({
			ok: true,
			target: 'core.py'
		});
	});
});
