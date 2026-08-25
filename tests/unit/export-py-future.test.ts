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
 *
 * WHAT THE HOIST CANNOT REACH, and what happens instead. A `__future__` import
 * sharing its line with another statement (`from __future__ import annotations;
 * x = 1`) is still left where it is - hoisting it would reorder the statement
 * riding with it, and relocating a user's code is out of scope for an export. So
 * the module really is uncompilable, and the fix is in the REPORT: it is detected
 * and carried out on `ExportResult.hazards`, so no surface reports that export as a
 * plain success. The headline case is asserted below with `compile()` and fails
 * without that detection.
 *
 * THE BOUNDARY of that claim is asserted too, in its own block at the end: a hazard
 * is a POSITIVE finding, and the class of "module that fails compile while the
 * export reports success" is WIDER than what is detected (a marked cell holding an
 * IPython magic, top-level `await`, a bare `return` or a nested `__future__` import
 * is already uncompilable on its own, and the module inherits that). Pinned in both
 * directions so nobody reads an empty `hazards` as "this module compiles".
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

	it('leaves a semicolon-joined statement alone, and REPORTS it', () => {
		const src = 'from __future__ import annotations; x = 1';
		const out = expy.generateModule([src], 'demo.ipynb');
		// Still not hoisted - hoisting would reorder the rider with it, and relocating
		// a user's code is out of scope for an export.
		expect(out.indexOf('__all__')).toBeLessThan(out.indexOf(src));
		// What is NOT left alone is the REPORT. This is the whole fix: the module is
		// written and cannot be imported, so the export may not call it a success.
		const hazards = expy.exportHazards([src]);
		expect(hazards).toHaveLength(1);
		expect(hazards[0].kind).toBe('future-import-joined');
		expect(hazards[0].statement).toBe(src);
		// The message names the construct AND the one edit that fixes it.
		expect(hazards[0].message).toContain('__future__');
		expect(hazards[0].message).toContain('line of its own');
	});

	it('reports a joined line whose __future__ import is SECOND, not first', () => {
		// `x = 1; from __future__ import annotations` does not compile even standalone,
		// so a module built from it cannot either. Reporting it beats the silence it
		// used to get, and the hoist declines it for the same reason.
		const hazards = expy.exportHazards(['x = 1; from __future__ import annotations']);
		expect(hazards).toHaveLength(1);
	});

	it('reports NOTHING for the shapes it hoists, or for ordinary code', () => {
		// Not vacuous in the other direction: the check must not fire on every export.
		expect(expy.exportHazards(['import os\n\ndef h(): return 1'])).toEqual([]);
		expect(expy.exportHazards(['from __future__ import annotations\nX = 1'])).toEqual([]);
		expect(expy.exportHazards(['from __future__ import annotations;\nX = 1'])).toEqual([]);
		expect(expy.exportHazards(['from __future__ import annotations # keep; please'])).toEqual([]);
		expect(expy.exportHazards(['S = """from __future__ import annotations; x = 1"""'])).toEqual([]);
		expect(expy.exportHazards(['def g():\n    from __future__ import annotations; x = 1'])).toEqual([]);
		expect(expy.exportHazards(['a = 1; b = 2'])).toEqual([]);
	});

	it('reports NOTHING for a `;` that sits INSIDE a string literal', () => {
		// The splitter behind this check is fed ARBITRARY exported-cell source, and
		// `stripComments` keeps string bodies verbatim - so a `;` inside a literal used
		// to split the statement around it and the trailing fragment matched
		// `FUTURE_RE`. That warned "the module will not import" about a module that
		// compiles, which is the false-claim class this feature exists to remove with
		// the sign flipped, and unclearable except by editing a perfectly valid string.
		expect(expy.exportHazards(['DOC = "run it; from __future__ import annotations is not allowed here"'])).toEqual([]);
		expect(expy.exportHazards(["DOC = 'a; from __future__ import annotations b'"])).toEqual([]);
		// Same root cause on a longer logical line: the `;` merely falls BEFORE the
		// future-import text rather than after it, which is all the committed
		// triple-quoted case above happened to avoid.
		expect(expy.exportHazards(['S = """hold on; from __future__ import annotations later"""'])).toEqual([]);
		expect(expy.exportHazards(['S = """line one\nhold on; from __future__ import annotations later\n"""'])).toEqual([]);
	});

	it('still reports the genuinely JOINED line - the string fix narrows, never disables', () => {
		expect(expy.exportHazards(['from __future__ import annotations; x = 1'])).toHaveLength(1);
		// ...even when a string sits on the same line, so the awareness cannot be read
		// as "any line holding a quote is exempt".
		expect(expy.exportHazards(['from __future__ import annotations; x = "a;b"'])).toHaveLength(1);
	});

	it('HOISTS unchanged around a string holding a semicolon', () => {
		// The hoist path was never harmed by the mis-split (`parts.length !== 1` only
		// meant "do not hoist", which was already right), so the fix must not move it:
		// the future import still lifts and the string cell is emitted untouched.
		const inString = 'X = "a;b"';
		const out = expy.generateModule(['from __future__ import annotations\nY = 1', inString], 'demo.ipynb');
		expect(out.indexOf('from __future__ import annotations')).toBeLessThan(out.indexOf('__all__'));
		expect(out).toContain(inString);
		expect(expy.exportHazards([inString])).toEqual([]);
	});

	it('HOISTS a BARE trailing semicolon - there is no rider to reorder', () => {
		const out = expy.generateModule(['from __future__ import annotations;\nX = 1'], 'demo.ipynb');
		expect(out.indexOf('from __future__ import annotations')).toBeLessThan(out.indexOf('__all__'));
		expect(out.indexOf('__all__')).toBeLessThan(out.indexOf('X = 1'));
	});

	it('HOISTS the no-space-before-parenthesis spelling', () => {
		// `from __future__ import(annotations)` needs no space and python compiles it,
		// so requiring `\s+\S` after `import` left it unhoisted.
		const out = expy.generateModule(['from __future__ import(annotations)\nX = 1'], 'demo.ipynb');
		expect(out.indexOf('from __future__ import(annotations)')).toBeLessThan(out.indexOf('__all__'));
		expect(out.indexOf('__all__')).toBeLessThan(out.indexOf('X = 1'));
	});

	it('still refuses a run-together `importannotations`', () => {
		const src = 'from __future__ importannotations\nX = 1';
		const out = expy.generateModule([src], 'demo.ipynb');
		// Not a future statement at all (and not valid python); nothing is hoisted.
		expect(out.indexOf('__all__')).toBeLessThan(out.indexOf('importannotations'));
	});

	it('dedupes a statement that differs only by a trailing semicolon', () => {
		const out = expy.generateModule(
			['from __future__ import annotations', 'from __future__ import annotations;\nY = 2'],
			'demo.ipynb'
		);
		expect(out.match(/from __future__ import annotations/g)).toHaveLength(1);
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

	it('compiles a cell whose STRING holds a `;` and future-import text, and reports no hazard', () => {
		// The two halves of the same claim, driven together: the module python really
		// does compile, and the export really does say nothing about it. Asserting the
		// empty hazards alone would not show the warning had been FALSE.
		const sources = [
			'DOC = "run it; from __future__ import annotations is not allowed here"',
			'S = """hold on; from __future__ import annotations later"""',
			'def f(x): return x'
		];
		const res = expy.exportNotebookToPy({
			...(docWith(sources) as any),
			metadata: { cellar: { export_target: 'out/string-semicolon.py' } }
		} as never);
		expect(res.written).toBe(true);
		expect(res.hazards).toEqual([]);
		const v = pythonVerdict(readFileSync(join(WS, res.target!), 'utf8'));
		expect(v.error).toBe('');
		expect(v.compiles).toBe(true);
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

	it('compiles when the future import carries a BARE trailing semicolon', () => {
		const res = expy.exportNotebookToPy({
			...(docWith(['from __future__ import annotations;\nimport os', 'def f(x: int) -> str:\n    return str(x)']) as any),
			metadata: { cellar: { export_target: 'out/baresemi.py' } }
		} as never);
		expect(res.written).toBe(true);
		const v = pythonVerdict(readFileSync(join(WS, res.target!), 'utf8'));
		expect(v.error).toBe('');
		expect(v.compiles).toBe(true);
	});

	it('compiles the no-space-before-parenthesis spelling', () => {
		const res = expy.exportNotebookToPy({
			...(docWith(['from __future__ import(annotations)\nimport os', 'def f(x: int) -> str:\n    return str(x)']) as any),
			metadata: { cellar: { export_target: 'out/paren.py' } }
		} as never);
		expect(res.written).toBe(true);
		const v = pythonVerdict(readFileSync(join(WS, res.target!), 'utf8'));
		expect(v.error).toBe('');
		expect(v.compiles).toBe(true);
	});

	it('a semicolon-JOINED future import is WRITTEN, uncompilable, and NEVER a plain success', () => {
		// THE HEADLINE. Cellar cannot hoist this line (that would reorder the statement
		// riding with it), so the module really does not compile - and the export must
		// SAY so rather than reporting `written: true` and nothing else. This test fails
		// without the fix: `hazards` was not there, so the result was a plain success.
		const src = 'from __future__ import annotations; x = 1';
		expect(pythonVerdict(src).compiles).toBe(true); // the CELL itself is legal python
		const res = expy.exportNotebookToPy({
			...(docWith([src, 'def f(y): return y']) as any),
			metadata: { cellar: { export_target: 'out/joined.py' } }
		} as never);
		// The module IS written: refusing would leave a stale, compilable module on
		// disk while the notebook moved on - the silent degrade, which is worse.
		expect(res.written).toBe(true);
		const v = pythonVerdict(readFileSync(join(WS, res.target!), 'utf8'));
		expect(v.compiles).toBe(false);
		expect(v.error).toContain('__future__');
		// ...and the REPORT is no longer plain success.
		expect(res.hazards).toHaveLength(1);
		expect(res.hazards[0].kind).toBe('future-import-joined');
		expect(res.hazards[0].message).toContain('line of its own');
	});

	it('re-exporting the broken module keeps reporting it (`unchanged` is not clean)', () => {
		// The broken bytes are still ON DISK, so a re-export that writes nothing must
		// not report the plain success the first one was corrected out of.
		const doc = {
			...(docWith(['from __future__ import annotations; x = 1']) as any),
			metadata: { cellar: { export_target: 'out/joined-again.py' } }
		} as never;
		expect(expy.exportNotebookToPy(doc).written).toBe(true);
		const second = expy.exportNotebookToPy(doc);
		expect(second.written).toBe(false);
		expect(second.reason).toBe('unchanged');
		expect(second.hazards).toHaveLength(1);
		expect(pythonVerdict(readFileSync(join(WS, second.target!), 'utf8')).compiles).toBe(false);
	});

	it('a healthy export reports NO hazards (the guard is not vacuous)', () => {
		const res = expy.exportNotebookToPy({
			...(docWith(['from __future__ import annotations\nimport os', 'def f(x: int) -> str:\n    return str(x)']) as any),
			metadata: { cellar: { export_target: 'out/clean.py' } }
		} as never);
		expect(res.written).toBe(true);
		expect(res.hazards).toEqual([]);
		expect(pythonVerdict(readFileSync(join(WS, res.target!), 'utf8')).compiles).toBe(true);
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

describe.skipIf(!HAS_PY)('THE BOUNDARY of what a hazard claims (python3; skipped without it)', () => {
	// The deliverable of "check whether any OTHER construct reaches the same end",
	// made EXECUTABLE rather than left as prose: a hazard is a POSITIVE finding
	// about a construct that was detected, and its ABSENCE is not a compile
	// guarantee. Both halves are measured here against real CPython, so the next
	// reader knows the boundary was checked and can see exactly where it sits.

	/** Export `sources` as the marked cells of a fresh notebook and read the module back. */
	function exportModule(sources: string[], name: string) {
		const res = expy.exportNotebookToPy({
			...(docWith(sources) as any),
			metadata: { cellar: { export_target: `out/${name}.py` } }
		} as never);
		return { res, module: readFileSync(join(WS, res.target!), 'utf8') };
	}

	it('ASSEMBLY-INDUCED breakage is exactly the __future__ case: nothing else is position-sensitive', () => {
		// Cellar's assembly does two things that could break a module: it puts a
		// comment header + `__all__` above the cells, and it concatenates cells at
		// indent 0. Measured, only a `__future__` statement cares about position.
		expect(pythonVerdict('x = 1\n\ny = 2').compiles).toBe(true); // concatenation is always valid
		expect(pythonVerdict('__all__ = []\n\nimport os\nclass K: pass').compiles).toBe(true);
		// An encoding declaration pushed below line 2 by the header is IGNORED by
		// Python, not an error - so the header cannot break a module through it.
		expect(pythonVerdict('# AUTOGEN\n# Source\n# -*- coding: utf-8 -*-\nx = 1').compiles).toBe(true);
		// And the one that does care: a valid cell after another valid cell.
		expect(pythonVerdict('x = 1\n\nfrom __future__ import annotations').compiles).toBe(false);
	});

	it('PRE-EXISTING breakage reaches the same end and is deliberately NOT detected', () => {
		// Each of these cells fails `compile` on its OWN - the module inherits that
		// rather than being broken by the assembly - so Cellar reports no hazard while
		// the module still does not compile. That is the stated limit of the claim, and
		// it is pinned so that "no hazard" can never be read as "this module compiles".
		const inherited: Array<[string, string]> = [
			['magic', '%matplotlib inline\nX = 1'],
			['shell', '!ls\nX = 1'],
			['await', 'X = await thing()'],
			['ret', 'return 1'],
			['nested-future', 'def g():\n    from __future__ import annotations\n    return 1']
		];
		for (const [name, src] of inherited) {
			expect(pythonVerdict(src).compiles, `${name}: the CELL itself must already be uncompilable`).toBe(false);
			const { res, module } = exportModule([src], `inherit-${name}`);
			expect(res.written).toBe(true);
			expect(pythonVerdict(module).compiles, `${name}: the module inherits it`).toBe(false);
			expect(res.hazards, `${name}: not detected - see $lib/exportHazard's boundary note`).toEqual([]);
		}
	});
});
