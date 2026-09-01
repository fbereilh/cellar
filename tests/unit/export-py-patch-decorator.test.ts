/**
 * `@patch`-decorated functions must NOT land in the generated module's `__all__`.
 *
 * THE REGRESSION GUARD for a live bug. fastcore's `@patch` / `@patch_to` attach a
 * function to a CLASS; they define no module-level API. `topLevelNames` collected
 * every top-level `def` without looking at its decorators, so those functions were
 * listed in `__all__`.
 *
 * That is not cosmetic, and this is the fact that makes it a defect rather than a
 * divergence: `patch` returns `glb.get(f.__name__, ...)` - the module-level binding
 * the name ALREADY had, or **None** - so after `@patch def make(self: C)` the module
 * global `make` is `None`. MEASURED against real fastcore: a module listing `make`
 * in `__all__` makes `from module import *` bind `make = None` in the caller's
 * namespace while the real method sits on `C`. Cellar exported a `None`.
 *
 * FOUND by running Cellar's real `generateModule` against nbdev 3.3.13's own
 * `nb_export` over a pristine clone of `AnswerDotAI/nbdev` (19 exporting notebooks):
 * 2 of 19 modules differed in `__all__` MEMBERSHIP and in both cases the extras were
 * `@patch`-decorated - `maker.py` (`import2relative`, `make`, `make_all`) and
 * `release.py` (`latest_notes`, `release`). That was the only semantic `__all__`
 * difference found.
 *
 * SCOPE, asserted in both directions below: only `__all__` MEMBERSHIP changes. The
 * decorated function is still WRITTEN to the module verbatim - the method has to
 * exist for the patch to happen at all - so a test that only checked `__all__` would
 * pass against a fix that deleted the code.
 *
 * THE MATCHING RULE and its deliberate limits are stated at
 * `METHOD_ATTACHING_DECORATORS` in `export-py.ts`; each limit is pinned here, because
 * the over-match direction (silently dropping a legitimate export named `patch*` from
 * someone's own code) is worse than the bug being fixed.
 *
 * The nbdev DIFFERENTIAL at the end is what makes the rule an observation rather
 * than a reading of nbdev's source. It skips where no nbdev interpreter is
 * discoverable (CI has none) with the reason in the suite name, so a green run is
 * never mistaken for a verified one. Point it at one with
 * `CELLAR_NBDEV_PYTHON=/path/to/python`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NotebookDoc } from '../../src/lib/server/types';

let WS: string;
let expy: typeof import('../../src/lib/server/export-py');

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-export-patch-'));
	process.env.CELLAR_WORKSPACE = WS;
	expy = await import('../../src/lib/server/export-py');
});
afterAll(() => rmSync(WS, { recursive: true, force: true }));

/** The `__all__` line of a generated module, parsed back into its names. */
function allOf(module: string): string[] {
	const line = module.match(/^__all__ = \[(.*)\]$/m);
	if (!line) throw new Error(`no __all__ in:\n${module}`);
	return [...line[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

/** `__all__` of the module `cells` generate, through the real `generateModule`. */
const allFor = (...cells: string[]) => allOf(expy.generateModule(cells, 'n.ipynb'));

describe('generateModule — __all__ omits @patch-decorated definitions', () => {
	it('drops a bare `@patch` def and keeps the ordinary ones', () => {
		expect(
			allFor(
				'from fastcore.basics import patch\n\nclass Maker:\n    def __init__(self): pass',
				'@patch\ndef make(self: Maker, x):\n    return x',
				'def plain(x):\n    return x'
			)
		).toEqual(['Maker', 'plain']);
	});

	it('drops the CALLED forms `@patch(...)` and `@patch_to(...)`', () => {
		expect(
			allFor('@patch(as_prop=True)\ndef prop(self: C): return 1', '@patch_to(C)\ndef pt(self, y): return y', 'KEPT = 1')
		).toEqual(['KEPT']);
	});

	it('drops an `async def` and a `class` carrying the decorator', () => {
		expect(allFor('@patch\nasync def fetch(self: C): pass', '@patch\nclass Odd: pass', 'def plain(): pass')).toEqual([
			'plain'
		]);
	});

	it('drops a def whose decorator STACK merely CONTAINS patch, in either order', () => {
		expect(
			allFor('@delegates(C)\n@patch\ndef a(self: C): pass', '@patch\n@wraps(f)\ndef b(self: C): pass', 'def c(): pass')
		).toEqual(['c']);
	});

	it('drops one whose `@patch(...)` call spans several physical lines', () => {
		expect(allFor('@patch(\n    as_prop=True\n)\ndef multi(self: C): return 1', 'def plain(): pass')).toEqual(['plain']);
	});

	it('drops one separated from its decorator by a blank line and a comment', () => {
		// Legal Python - verified against CPython - so the decorator run must survive it.
		expect(allFor('@patch\n# why this is patched\n\ndef sep(self: C): return 1', 'def plain(): pass')).toEqual(['plain']);
	});

	it('drops one whose decorator is written `@ patch`', () => {
		expect(allFor('@ patch\ndef spaced(self: C): return 1', 'def plain(): pass')).toEqual(['plain']);
	});

	it('scopes the decorator to ITS def - the next definition is unaffected', () => {
		expect(allFor('@patch\ndef first(self: C): pass\n\ndef second(): pass')).toEqual(['second']);
	});

	it('does not leak the flag across CELLS', () => {
		expect(allFor('@patch\ndef first(self: C): pass', 'def second(): pass')).toEqual(['second']);
	});
});

describe('generateModule — the matching rule stays NARROW', () => {
	it('leaves every OTHER decorator alone', () => {
		expect(
			allFor(
				'@delegates(C)\ndef deleg(**kw): pass',
				'@call_parse\ndef cli(): pass',
				'@docs\nclass Documented: pass',
				'@property\ndef prop_like(): pass'
			)
		).toEqual(['deleg', 'cli', 'Documented', 'prop_like']);
	});

	it('does NOT match a merely patch-PREFIXED name - the over-match this set exists to avoid', () => {
		// nbdev's own rule is `decor_id(d).startswith('patch')`, which DOES drop these.
		// Cellar is deliberately narrower: a user-authored `@patchwork` is not fastcore's
		// `patch`, and silently losing its export is worse than the bug being fixed.
		expect(allFor('@patchwork\ndef a(): pass', '@patched\ndef b(): pass', '@patch_all(x)\ndef c(): pass')).toEqual([
			'a',
			'b',
			'c'
		]);
	});

	it('does NOT match an ALIASED or NAMESPACED decorator - the stated limit', () => {
		// `from fastcore.basics import patch as p` / `@fc.patch`. Recovering these needs
		// import resolution this scanner does not do, and nbdev does not match them either
		// (`decor_id` reads a bare Name's `id` or a Call's `func.id`). Such a function keeps
		// its wrong `__all__` entry - pre-existing behaviour, pinned so it stays a KNOWN gap.
		expect(allFor('from fastcore.basics import patch as p\n@p\ndef aliased(self: C): pass')).toEqual(['aliased']);
		expect(allFor('import fastcore.basics as fc\n@fc.patch\ndef ns(self: C): pass')).toEqual(['ns']);
	});

	it('never reads a `@patch` inside a STRING or an indented body as a decorator', () => {
		expect(
			allFor(
				'DOC = """\n@patch\ndef fake(self: C): pass\n"""',
				'class Holder:\n    @patch\n    def inner(self): pass',
				'def outer():\n    @patch\n    def nested(self): pass'
			)
		).toEqual(['DOC', 'Holder', 'outer']);
	});

	it('leaves a module with no decorator at all byte-identical to before the fix', () => {
		const cells = ['import os', 'X = 1', 'y: int = 2', 'A, B = 3, 4', 'def foo(): pass', 'class Bar: pass'];
		expect(expy.generateModule(cells, 'n.ipynb')).toBe(
			'# AUTOGENERATED BY CELLAR! DO NOT EDIT!\n' +
				'# Source notebook: n.ipynb\n\n' +
				"__all__ = ['X', 'y', 'A', 'B', 'foo', 'Bar']\n\n" +
				cells.join('\n\n') +
				'\n'
		);
	});
});

describe('exportNotebookToPy — the END-USER path', () => {
	const cell = (id: string, source: string) => ({
		id,
		cell_type: 'code' as const,
		source,
		metadata: { cellar: { export: true } }
	});

	it('writes the patched method but leaves it OUT of __all__', () => {
		const doc: NotebookDoc = {
			path: join(WS, 'core.ipynb'),
			metadata: { cellar: { export_target: 'core.py' } },
			cells: [
				cell('a', 'from fastcore.basics import patch\n\nclass Maker:\n    def __init__(self): pass'),
				cell('b', '@patch\ndef make(self: Maker, x):\n    return x'),
				cell('c', '@patch(as_prop=True)\ndef prop(self: Maker):\n    return 1'),
				cell('d', 'def plain(x):\n    return x')
			]
		} as unknown as NotebookDoc;

		const res = expy.exportNotebookToPy(doc);
		expect(res.written).toBe(true);
		const text = readFileSync(join(WS, 'core.py'), 'utf8');

		expect(allOf(text)).toEqual(['Maker', 'plain']);
		// The CODE is untouched: only `__all__` membership was wrong, and the method
		// still has to exist for `@patch` to attach it.
		expect(text).toContain('@patch\ndef make(self: Maker, x):\n    return x');
		expect(text).toContain('@patch(as_prop=True)\ndef prop(self: Maker):\n    return 1');
	});
});

/**
 * The DIFFERENTIAL: Cellar's `__all__` membership must agree with nbdev's own
 * exporter on the fastcore decorators. Compared as SETS - nbdev orders assignment
 * targets before definition names while Cellar preserves source order, a
 * pre-existing and deliberate divergence this task does not touch.
 */
function findNbdevPython(): string | null {
	const candidates = [
		process.env.CELLAR_NBDEV_PYTHON,
		join(process.cwd(), '.venv', 'bin', 'python'),
		join(process.env.HOME ?? '', '.cellar', 'host-venv', 'bin', 'python'),
		join(process.env.HOME ?? '', '.local', 'share', 'uv', 'tools', 'nbdev', 'bin', 'python')
	].filter((p): p is string => !!p);
	for (const py of candidates) {
		if (!existsSync(py)) continue;
		try {
			execFileSync(py, ['-c', 'import nbdev.maker'], { stdio: 'ignore' });
			return py;
		} catch {
			/* not this one */
		}
	}
	return null;
}

const PYTHON = findNbdevPython();
const VERSION = PYTHON
	? execFileSync(PYTHON, ['-c', 'import nbdev;print(nbdev.__version__)'], { encoding: 'utf8' }).trim()
	: '';

/** nbdev's own `__all__` for these cell sources, through the real `ModuleMaker`. */
function nbdevAll(cells: string[]): string[] {
	const script = [
		'import sys, json',
		'from nbdev.maker import ModuleMaker, make_code_cells',
		'srcs = json.loads(sys.argv[1])',
		"mm = ModuleMaker(dest='.', name='x', nb_path='n.ipynb', is_new=True)",
		'print(json.dumps(list(mm.make_all(make_code_cells(*srcs)))))'
	].join('\n');
	return JSON.parse(execFileSync(PYTHON!, ['-c', script, JSON.stringify(cells)], { encoding: 'utf8' }));
}

describe.skipIf(!PYTHON)(
	`differential vs nbdev's own exporter${PYTHON ? ` (nbdev ${VERSION})` : ' (SKIPPED: no nbdev interpreter found)'}`,
	() => {
		const cells = [
			'from fastcore.basics import patch, patch_to\nclass Maker: pass',
			'@patch\ndef make(self: Maker, x): return x',
			'@patch(as_prop=True)\ndef prop(self: Maker): return 1',
			'@patch_to(Maker)\ndef pt(self, y): return y',
			'@delegates(Maker)\ndef deleg(**kw): pass',
			'def plain(x): return x',
			'PI = 3.14'
		];

		it('agrees on the fastcore decorators', () => {
			expect([...allFor(...cells)].sort()).toEqual([...nbdevAll(cells)].sort());
		});

		it('nbdev really DROPS these names - so the agreement above is not vacuous', () => {
			expect(nbdevAll(cells)).not.toContain('make');
			expect(nbdevAll(cells)).not.toContain('prop');
			expect(nbdevAll(cells)).not.toContain('pt');
			expect(nbdevAll(cells)).toContain('plain');
		});

		it('documents the ONE deliberate disagreement: nbdev prefix-matches, Cellar does not', () => {
			const odd = ['@patchwork\ndef weird(): pass', 'def plain(): pass'];
			expect(nbdevAll(odd)).not.toContain('weird');
			expect(allFor(...odd)).toContain('weird');
		});
	}
);
