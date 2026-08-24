/**
 * Exported `__future__` imports — the module must COMPILE.
 *
 * THE REGRESSION GUARD for a live bug: `generateModule` always emitted `__all__`
 * before the first cell, but Python requires a future statement to precede every
 * other statement in the module. So an exported cell carrying
 * `from __future__ import annotations` produced a module Python REFUSES TO
 * COMPILE while the export reported `written: true` — a silently broken library.
 *
 * Cellar's own imports-cell renderer deliberately puts `__future__` first inside
 * that cell (`imports.ts`), so marking the imports cell for export is the likeliest
 * way to hit it.
 *
 * METHODOLOGY, and it is load-bearing: this must be verified with `compile()`, NOT
 * `ast.parse()`. `ast.parse` does not enforce the future-placement rule and accepts
 * the broken module happily, so a test built on it passes while the bug survives.
 * The `ast.parse` blindness is itself asserted below so nobody "simplifies" the
 * check into it later, and the pre-fix byte layout is asserted to FAIL compile so
 * the guard can never be vacuous.
 *
 * The hoist is strictly more correct than nbdev's own `_last_future` (`maker.py`),
 * which moves whole CELLS up to the last one containing a future import — leaving
 * an uncompilable module when a future import trails real code, where Cellar's
 * statement-level hoist does not.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let WS: string;
let expy: typeof import('../../src/lib/server/export-py');

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-export-future-'));
	process.env.CELLAR_WORKSPACE = WS;
	expy = await import('../../src/lib/server/export-py');
});

/** `python3` here uses only stdlib (`ast`), so this needs no venv and no package. */
function pythonAvailable(): boolean {
	try {
		execFileSync('python3', ['-c', 'import ast'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}
const HAS_PY = pythonAvailable();

/**
 * Ask Python whether `src` compiles, and — separately — whether `ast.parse`
 * accepts it. The two disagree exactly on the future-placement rule, which is the
 * whole point of this file.
 */
function pythonVerdict(src: string): { compiles: boolean; astParses: boolean; error: string } {
	const probe = [
		'import ast, json, sys',
		'src = sys.stdin.read()',
		'try: compile(src, "m", "exec"); c, e = True, ""',
		'except SyntaxError as ex: c, e = False, ex.msg',
		'try: ast.parse(src); a = True',
		'except SyntaxError: a = False',
		'print(json.dumps({"compiles": c, "astParses": a, "error": e}))'
	].join('\n');
	const out = execFileSync('python3', ['-c', probe], { input: src, encoding: 'utf8' });
	return JSON.parse(out);
}

/** A doc with a target and every given source marked for export. */
function docWith(sources: string[]) {
	return {
		path: 'demo.ipynb',
		metadata: { cellar: { export_target: 'out/core.py' } },
		cells: sources.map((source, i) => ({
			id: `c${i}`,
			cell_type: 'code' as const,
			source,
			outputs: [],
			metadata: { cellar: { export: true } }
		}))
	} as never;
}

describe('generateModule — hoisting module-level __future__ imports', () => {
	it('emits the future block ABOVE __all__', () => {
		const out = expy.generateModule(['from __future__ import annotations\nimport os', 'def f(x: int) -> str:\n    return str(x)'], 'demo.ipynb');
		expect(out.indexOf('from __future__ import annotations')).toBeLessThan(out.indexOf('__all__'));
		// It is lifted OUT of its cell, not duplicated.
		expect(out.match(/from __future__ import annotations/g)).toHaveLength(1);
		// ...and the rest of that cell stays in document order, below __all__.
		expect(out.indexOf('__all__')).toBeLessThan(out.indexOf('import os'));
	});

	it('hoists one that TRAILS real code — where nbdev\'s whole-cell rule still breaks', () => {
		const out = expy.generateModule(['def f(x): return x', 'from __future__ import annotations'], 'demo.ipynb');
		expect(out.indexOf('from __future__ import annotations')).toBeLessThan(out.indexOf('__all__'));
		expect(out.indexOf('__all__')).toBeLessThan(out.indexOf('def f'));
	});

	it('dedupes the same statement across cells', () => {
		const out = expy.generateModule(['from __future__ import annotations', 'from __future__ import annotations\nX = 1'], 'demo.ipynb');
		expect(out.match(/from __future__ import annotations/g)).toHaveLength(1);
		expect(out).toContain("__all__ = ['X']");
	});

	it('moves a bracket-continued import WHOLE', () => {
		const out = expy.generateModule(['from __future__ import (annotations,\n                        division)\nZ = 3'], 'demo.ipynb');
		expect(out).toContain('from __future__ import (annotations,\n                        division)');
		expect(out.indexOf('division)')).toBeLessThan(out.indexOf('__all__'));
	});

	it('drops a cell that held NOTHING but a future import', () => {
		const out = expy.generateModule(['from __future__ import annotations\n', 'Y = 2'], 'demo.ipynb');
		// No stray blank block where the emptied cell was.
		expect(out).not.toMatch(/\n\n\n/);
	});

	it('NEVER moves one that is nested or inside a string', () => {
		const nested = 'def g():\n    from __future__ import annotations\n    return 1';
		const inString = 'S = """from __future__ import annotations"""';
		const out = expy.generateModule([nested, inString], 'demo.ipynb');
		// Both stay exactly where they were: below __all__, unmoved.
		expect(out.indexOf('__all__')).toBeLessThan(out.indexOf('def g'));
		expect(out).toContain(nested);
		expect(out).toContain(inString);
	});

	it('leaves a semicolon-joined statement alone (the documented limit)', () => {
		const src = 'from __future__ import annotations; x = 1';
		const out = expy.generateModule([src], 'demo.ipynb');
		// Not hoisted - hoisting would reorder the rider with it.
		expect(out.indexOf('__all__')).toBeLessThan(out.indexOf(src));
	});

	it('HOISTS one whose trailing COMMENT contains a semicolon', () => {
		// The `;` guard is about a semicolon-JOINED statement; a `;` inside a comment
		// joins nothing. Reading the raw bytes instead of the CODE silently skipped the
		// hoist and emitted the uncompilable layout this whole feature removes.
		const out = expy.generateModule(['from __future__ import annotations # keep; please\nX = 1'], 'demo.ipynb');
		expect(out.indexOf('from __future__ import annotations')).toBeLessThan(out.indexOf('__all__'));
		expect(out.indexOf('__all__')).toBeLessThan(out.indexOf('X = 1'));
		// It moves verbatim, comment and all.
		expect(out).toContain('from __future__ import annotations # keep; please');
	});

	it('does not double-count a statement that differs only by its comment', () => {
		const out = expy.generateModule([
			'from __future__ import annotations',
			'from __future__ import annotations  # again\nY = 2'
		], 'demo.ipynb');
		expect(out.match(/from __future__ import annotations/g)).toHaveLength(1);
	});

	it('leaves no double blank line where a hoisted import was followed by one', () => {
		const out = expy.generateModule(['from __future__ import annotations\n\nimport os\nX = 1'], 'demo.ipynb');
		// generateModule's contract: single blank line between blocks, no incidental
		// whitespace. A naive splice left the residue OPENING with a blank line.
		expect(out).not.toMatch(/\n\n\n/);
		expect(out).toContain("__all__ = ['X']\n\nimport os\nX = 1\n");
	});

	it('collapses the seam a hoist leaves in the MIDDLE of a cell', () => {
		const out = expy.generateModule(['X = 1\n\nfrom __future__ import annotations\n\nY = 2'], 'demo.ipynb');
		expect(out).not.toMatch(/\n\n\n/);
		expect(out).toContain('X = 1\n\nY = 2');
	});

	it('leaves consecutive hoisted imports no blank residue at the top', () => {
		const out = expy.generateModule([
			'from __future__ import annotations\n\nfrom __future__ import division\n\nZ = 3'
		], 'demo.ipynb');
		expect(out).not.toMatch(/\n\n\n/);
		expect(out).toContain("__all__ = ['Z']\n\nZ = 3\n");
	});

	it('leaves a module with no future import byte-identical to before', () => {
		const out = expy.generateModule(['import os\n\ndef h(): return 1'], 'demo.ipynb');
		expect(out).toBe(
			['# AUTOGENERATED BY CELLAR! DO NOT EDIT!', '# Source notebook: demo.ipynb', '', "__all__ = ['h']", '', 'import os', '', 'def h(): return 1', ''].join('\n')
		);
	});

	it('stays deterministic and idempotent', () => {
		const srcs = ['from __future__ import annotations\nimport os', 'def f(): pass'];
		expect(expy.generateModule(srcs, 'demo.ipynb')).toBe(expy.generateModule(srcs, 'demo.ipynb'));
	});
});

describe.skipIf(!HAS_PY)('the exported module really COMPILES (python3; skipped without it)', () => {
	it('exports a notebook with `from __future__ import annotations` to a module python compiles', () => {
		const res = expy.exportNotebookToPy(docWith(['from __future__ import annotations\nimport os', 'def f(x: int) -> str:\n    return str(x)']));
		expect(res.written).toBe(true);
		const module = readFileSync(join(WS, res.target!), 'utf8');
		const v = pythonVerdict(module);
		expect(v.error).toBe('');
		expect(v.compiles).toBe(true);
	});

	it('the PRE-FIX byte layout FAILS compile — so this guard is not vacuous', () => {
		// Exactly what generateModule used to emit: __all__ before the future import.
		const preFix = ['# AUTOGENERATED BY CELLAR! DO NOT EDIT!', '# Source notebook: demo.ipynb', '', "__all__ = ['f']", '', 'from __future__ import annotations', '', 'def f(x: int) -> str:', '    return str(x)', ''].join('\n');
		const v = pythonVerdict(preFix);
		expect(v.compiles).toBe(false);
		expect(v.error).toContain('__future__');
		// THE METHODOLOGY TRAP: ast.parse accepts the broken module, so a test built
		// on it would have passed against the bug. Do not swap compile() for it.
		expect(v.astParses).toBe(true);
	});

	it('compiles when the future import trails real code across cells', () => {
		const res = expy.exportNotebookToPy({
			...(docWith(['def f(x): return x', 'from __future__ import annotations\nimport os']) as any),
			metadata: { cellar: { export_target: 'out/trailing.py' } }
		} as never);
		expect(res.written).toBe(true);
		expect(pythonVerdict(readFileSync(join(WS, res.target!), 'utf8')).compiles).toBe(true);
	});

	it('compiles when the future import carries a semicolon in its comment', () => {
		const res = expy.exportNotebookToPy({
			...(docWith(['from __future__ import annotations # keep; please\nimport os', 'def f(x: int) -> str:\n    return str(x)']) as any),
			metadata: { cellar: { export_target: 'out/comment.py' } }
		} as never);
		expect(res.written).toBe(true);
		const v = pythonVerdict(readFileSync(join(WS, res.target!), 'utf8'));
		expect(v.error).toBe('');
		expect(v.compiles).toBe(true);
	});

	it('compiles a module with no future import at all (no regression)', () => {
		const res = expy.exportNotebookToPy({
			...(docWith(['import os\n\ndef h(): return 1']) as any),
			metadata: { cellar: { export_target: 'out/plain.py' } }
		} as never);
		expect(res.written).toBe(true);
		expect(pythonVerdict(readFileSync(join(WS, res.target!), 'utf8')).compiles).toBe(true);
	});

	it('re-exporting is a byte-for-byte no-op (idempotent on disk)', () => {
		const doc = { ...(docWith(['from __future__ import annotations\nX = 1']) as any), metadata: { cellar: { export_target: 'out/idem.py' } } } as never;
		const first = expy.exportNotebookToPy(doc);
		expect(first.written).toBe(true);
		const bytes = readFileSync(join(WS, first.target!), 'utf8');
		const second = expy.exportNotebookToPy(doc);
		expect(second.written).toBe(false);
		expect(second.reason).toBe('unchanged');
		expect(readFileSync(join(WS, first.target!), 'utf8')).toBe(bytes);
	});
});
