/**
 * A RUST NOTEBOOK inside a real document: the stored setting, the export rules
 * and the `.py` text-notebook refusal.
 *
 * Rust differs from Mojo in two document rules, and both are pinned here:
 *   - it exports a `.rs` module, but a language switch never rewrites a stored
 *     target's extension, so a target kept from Python is reported as a mismatch,
 *   - a round trip through Rust leaves the file as it was.
 * The imports sweep is checked too, since a Rust `use` line is not a Python import.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUST_HEADER } from '../../src/lib/rustExport';
import {
	RUST_LANGUAGE,
	RUST_UNSUPPORTED_REASON,
	TEXT_NOTEBOOK_RUST_MESSAGE,
	TextNotebookLanguageError
} from '../../src/lib/cellLanguage';

vi.mock('../../src/lib/server/run', () => ({
	executeCellRun: vi.fn(async () => ({ outputs: [], status: 'ok', session: 1, kernelDown: false })),
	clearOutputsForQueue: () => {}
}));

vi.mock('../../src/lib/server/jupytext', async () => {
	const actual = await vi.importActual<typeof import('../../src/lib/server/jupytext')>('../../src/lib/server/jupytext');
	return {
		...actual,
		readPyNotebook: () => ({
			format: 'databricks',
			cells: [{ id: null, cell_type: 'code', source: 'print(1)', outputs: [], metadata: {} }]
		}),
		writePyNotebook: (path: string, cells: { source: string }[]) => {
			writeFileSync(path, cells.map((c) => c.source).join('\n') + '\n');
		}
	};
});

let WS: string;
let nbmod: typeof import('../../src/lib/server/notebook');
let imports: typeof import('../../src/lib/server/imports-cell');

function makeNotebook(name: string, sources: string[], cellar?: Record<string, unknown>): string {
	const nb = join(WS, name);
	writeFileSync(
		nb,
		JSON.stringify({
			cells: sources.map((source, i) => ({
				cell_type: 'code',
				source: [source],
				metadata: {},
				outputs: [],
				execution_count: null,
				id: `cell${i}`
			})),
			metadata: cellar ? { cellar } : {},
			nbformat: 4,
			nbformat_minor: 5
		})
	);
	return nb;
}

const onDisk = (nb: string) => JSON.parse(readFileSync(nb, 'utf8'));

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-rust-doc-'));
	process.env.CELLAR_WORKSPACE = WS;
	nbmod = await import('../../src/lib/server/notebook');
	await nbmod.syncExportPeers();
	imports = await import('../../src/lib/server/imports-cell');
});

afterAll(() => rmSync(WS, { recursive: true, force: true }));

describe('the stored setting', () => {
	it('persists rust and touches no cell', () => {
		const nb = makeNotebook('set.ipynb', ['let x = 1;', 'println!("{x}");']);
		const before = nbmod.listCells(nb).map((c) => c.source);
		expect(nbmod.setNotebookLanguage('rust', nb)).toBe('rust');
		expect(nbmod.getNotebookLanguage(nb)).toBe('rust');
		expect(onDisk(nb).metadata.cellar.language).toBe(RUST_LANGUAGE);
		expect(nbmod.listCells(nb).map((c) => c.source)).toEqual(before);
		expect(onDisk(nb).cells.every((c: { metadata: object }) => Object.keys(c.metadata).length === 0)).toBe(true);
	});

	it('switching back to Python removes the key', () => {
		const nb = makeNotebook('roundtrip.ipynb', ['x = 1']);
		nbmod.setNotebookLanguage('rust', nb);
		nbmod.setNotebookLanguage('python', nb);
		expect(nbmod.getNotebookLanguage(nb)).toBe('python');
		expect(onDisk(nb).metadata.cellar).toBeUndefined();
	});
});

describe('a Rust notebook exports a .rs module', () => {
	it('accepts a .rs target and refuses a .py one as a mismatch', () => {
		const nb = makeNotebook('target.ipynb', ['let x = 1;'], { language: 'rust' });
		expect(() => nbmod.setExportTarget('lib.py', nb)).toThrow(/\.rs/);
		expect(onDisk(nb).metadata.cellar.export_target).toBeUndefined();
		nbmod.setExportTarget('lib.rs', nb);
		expect(onDisk(nb).metadata.cellar.export_target).toBe('lib.rs');
		expect(nbmod.exportTargetInfoFor(nb).language).toBe('rust');
	});

	it('still lets a stored target be cleared', () => {
		const nb = makeNotebook('clear.ipynb', ['let x = 1;'], { language: 'rust', export_target: 'lib.rs' });
		nbmod.setExportTarget(null, nb);
		expect(onDisk(nb).metadata.cellar.export_target).toBeUndefined();
	});

	it('keeps a stored .py target across a switch to Rust and reports the mismatch', () => {
		const nb = makeNotebook('keep.ipynb', ['x = 1'], { export_target: 'utils.py' });
		nbmod.setNotebookLanguage('rust', nb);
		expect(onDisk(nb).metadata.cellar.export_target).toBe('utils.py');
		const info = nbmod.exportTargetInfo(nb);
		expect(info && !info.ok && info.error).toMatch(/\.py module/);
		// Back to Python, the same target resolves again.
		nbmod.setNotebookLanguage('python', nb);
		expect(onDisk(nb).metadata.cellar.export_target).toBe('utils.py');
		expect(nbmod.exportTargetInfo(nb)?.ok).toBe(true);
	});

	it('reports the notebook language and the mismatch for a target kept across the switch', () => {
		// The same rule a hand-edited mismatch follows in a Mojo notebook: the module
		// language is the notebook's, and the target's own resolution carries the
		// refusal, so nothing reads the stale extension back as the language.
		const nb = makeNotebook('kept-lang.ipynb', ['x = 1'], { export_target: 'utils.py' });
		expect(nbmod.exportTargetInfoFor(nb).language).toBe('python');
		nbmod.setNotebookLanguage('rust', nb);
		const info = nbmod.exportTargetInfoFor(nb);
		expect(info.configured).toBe(true);
		expect(info.language).toBe('rust');
		const view = nbmod.getNotebook(nb);
		expect(view.exportResolveError).toMatch(/\.py module/);
		expect(view.exportResolved).toBeNull();
	});

	it('marks a code cell for export', () => {
		const nb = makeNotebook('mark.ipynb', ['fn f() {}'], { language: 'rust' });
		const res = nbmod.setCellExport('cell0', true, nb);
		expect(res.ok).toBe(true);
		expect(onDisk(nb).cells[0].metadata.cellar?.export).toBe(true);
	});
});

describe('the main cell mark', () => {
	const cellarOf = (nb: string, i: number) => onDisk(nb).cells[i].metadata.cellar ?? {};

	it('marks one cell, exports it, and moves when another cell is marked', () => {
		const nb = makeNotebook('main-move.ipynb', ['let a = 1;', 'let b = 2;'], { language: 'rust' });
		expect(nbmod.setCellExportMain('cell0', true, nb)).toEqual({ ok: true, changed: true });
		expect(cellarOf(nb, 0)).toEqual({ export: true, export_main: true });
		expect(nbmod.setCellExportMain('cell1', true, nb)).toEqual({ ok: true, changed: true });
		// One main per notebook: the first cell keeps its export mark, loses the main one.
		expect(cellarOf(nb, 0)).toEqual({ export: true });
		expect(cellarOf(nb, 1)).toEqual({ export: true, export_main: true });
	});

	it('reports no change for a mark the cell already holds, in both directions', () => {
		const nb = makeNotebook('main-idem.ipynb', ['let a = 1;'], { language: 'rust' });
		expect(nbmod.setCellExportMain('cell0', false, nb)).toEqual({ ok: true, changed: false });
		nbmod.setCellExportMain('cell0', true, nb);
		expect(nbmod.setCellExportMain('cell0', true, nb)).toEqual({ ok: true, changed: false });
		expect(nbmod.setCellExportMain('cell0', false, nb)).toEqual({ ok: true, changed: true });
		// Clearing the main mark leaves the cell exported.
		expect(cellarOf(nb, 0)).toEqual({ export: true });
	});

	it('clears the main mark when the cell stops being exported', () => {
		const nb = makeNotebook('main-unexport.ipynb', ['let a = 1;'], { language: 'rust' });
		nbmod.setCellExportMain('cell0', true, nb);
		nbmod.setCellExport('cell0', false, nb);
		expect(cellarOf(nb, 0)).toEqual({});
	});

	it('refuses an unknown cell, a Python notebook and a non-code cell', () => {
		const rust = makeNotebook('main-refuse.ipynb', ['let a = 1;'], { language: 'rust' });
		expect(nbmod.setCellExportMain('nope', true, rust)).toEqual({ ok: false, reason: 'no-such-cell' });
		const py = makeNotebook('main-python.ipynb', ['x = 1']);
		expect(nbmod.setCellExportMain('cell0', true, py)).toEqual({ ok: false, reason: 'not-rust' });
		expect(cellarOf(py, 0)).toEqual({});
		nbmod.setCellType('cell0', 'markdown', rust);
		expect(nbmod.setCellExportMain('cell0', true, rust)).toEqual({ ok: false, reason: 'not-code' });
	});

	it('writes statements of the main cell into fn main() and drops the rest', () => {
		const nb = makeNotebook(
			'main-write.ipynb',
			[':dep rand = "0.8"\nfn add(a: i32, b: i32) -> i32 { a + b }\nlet stray = 1;', 'let x = add(1, 2);\nprintln!("{x}");'],
			{ language: 'rust', export_target: 'lib.rs' }
		);
		nbmod.setCellExport('cell0', true, nb);
		nbmod.setCellExportMain('cell1', true, nb);
		const res = nbmod.exportPy(nb);
		expect(res.written || res.reason === 'unchanged').toBe(true);
		const text = readFileSync(join(WS, 'lib.rs'), 'utf8');
		expect(text.split('\n')[0]).toBe(RUST_HEADER);
		expect(text).toContain('fn add(a: i32, b: i32) -> i32 { a + b }');
		expect(text).toMatch(/fn main\(\) \{\n\s+let x = add\(1, 2\);\n\s+println!\("\{x\}"\);\n\}/);
		expect(text).not.toContain('let stray');
		expect(text).not.toMatch(/^:dep/m);
		expect(text).toContain('rand = "0.8"');
		expect(res.hazards.map((h) => h.kind)).toEqual(['rust-code-dropped']);
	});

	it('refuses to overwrite a .rs file Cellar did not write', () => {
		writeFileSync(join(WS, 'mine.rs'), 'fn mine() {}\n');
		const nb = makeNotebook('main-foreign.ipynb', ['fn f() {}'], { language: 'rust', export_target: 'mine.rs' });
		nbmod.setCellExport('cell0', true, nb);
		const res = nbmod.exportPy(nb);
		expect(res).toMatchObject({ written: false, reason: 'foreign-module' });
		expect(readFileSync(join(WS, 'mine.rs'), 'utf8')).toBe('fn mine() {}\n');
	});

	it('does not let a pasted copy claim the main mark beside its original', () => {
		const nb = makeNotebook('main-paste.ipynb', ['let a = 1;'], { language: 'rust' });
		nbmod.setCellExportMain('cell0', true, nb);
		const pasted = nbmod.addCell('cell0', 'code', nb, null, 'let a = 1;', { export: true, export_main: true });
		const cellar = onDisk(nb).cells.find((c: { id: string }) => c.id === pasted.id).metadata.cellar;
		expect(cellar.export).toBe(true);
		expect(cellar.export_main).toBeUndefined();
		expect(cellarOf(nb, 0).export_main).toBe(true);
	});
});

describe('the imports sweep', () => {
	it('leaves a Rust notebook untouched', async () => {
		const nb = makeNotebook('sweep.ipynb', ['use std::fmt;\nimport os\nlet x = 1;'], { language: 'rust' });
		const before = nbmod.listCells(nb).map((c) => c.source);
		const res = await imports.consolidateImports(nb);
		expect(res.changed).toBe(false);
		expect(nbmod.listCells(nb).map((c) => c.source)).toEqual(before);
	});
});

describe('a .py text notebook', () => {
	it('refuses rust and stays Python', () => {
		const py = join(WS, 'dbx.py');
		writeFileSync(py, '# Databricks notebook source\nprint(1)\n');
		let thrown: unknown;
		try {
			nbmod.setNotebookLanguage('rust', py);
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(TextNotebookLanguageError);
		expect((thrown as TextNotebookLanguageError).reason).toBe(RUST_UNSUPPORTED_REASON);
		expect((thrown as Error).message).toBe(TEXT_NOTEBOOK_RUST_MESSAGE);
		expect(nbmod.getNotebookLanguage(py)).toBe('python');
	});
});
