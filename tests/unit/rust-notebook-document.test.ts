/**
 * A RUST NOTEBOOK inside a real document: the stored setting, the export rules
 * and the `.py` text-notebook refusal.
 *
 * Rust differs from Mojo in two document rules, and both are pinned here:
 *   - it generates no export module, so a target is refused and a stored one is
 *     reported as unresolvable without being rewritten,
 *   - a round trip through Rust leaves the file as it was.
 * The imports sweep is checked too, since a Rust `use` line is not a Python import.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	RUST_LANGUAGE,
	RUST_UNSUPPORTED_REASON,
	TEXT_NOTEBOOK_RUST_MESSAGE,
	TextNotebookLanguageError
} from '../../src/lib/cellLanguage';
import { noModuleLanguageMessage } from '../../src/lib/exportRole';

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

describe('a Rust notebook exports no module', () => {
	it('refuses a new export target and names the reason', () => {
		const nb = makeNotebook('no-target.ipynb', ['let x = 1;'], { language: 'rust' });
		expect(() => nbmod.setExportTarget('lib.py', nb)).toThrow(noModuleLanguageMessage('rust'));
		expect(onDisk(nb).metadata.cellar.export_target).toBeUndefined();
	});

	it('still lets a stored target be cleared', () => {
		const nb = makeNotebook('clear.ipynb', ['let x = 1;'], { language: 'rust', export_target: 'lib.py' });
		nbmod.setExportTarget(null, nb);
		expect(onDisk(nb).metadata.cellar.export_target).toBeUndefined();
	});

	it('keeps a stored target across a switch to Rust and reports it unresolvable', () => {
		const nb = makeNotebook('keep.ipynb', ['x = 1'], { export_target: 'utils.py' });
		nbmod.setNotebookLanguage('rust', nb);
		expect(onDisk(nb).metadata.cellar.export_target).toBe('utils.py');
		const info = nbmod.exportTargetInfo(nb);
		expect(info && !info.ok && info.error).toBe(noModuleLanguageMessage('rust'));
		// Back to Python, the same target resolves again.
		nbmod.setNotebookLanguage('python', nb);
		expect(onDisk(nb).metadata.cellar.export_target).toBe('utils.py');
		expect(nbmod.exportTargetInfo(nb)?.ok).toBe(true);
	});

	it('reports no module language for a target kept across the switch', () => {
		const nb = makeNotebook('kept-lang.ipynb', ['x = 1'], { export_target: 'utils.py' });
		expect(nbmod.exportTargetInfoFor(nb).language).toBe('python');
		nbmod.setNotebookLanguage('rust', nb);
		const info = nbmod.exportTargetInfoFor(nb);
		expect(info.configured).toBe(true);
		expect(info.language).toBeNull();
		expect(nbmod.getNotebook(nb).exportLanguage).toBeNull();
	});

	it('refuses to mark a cell for export', () => {
		const nb = makeNotebook('mark.ipynb', ['fn f() {}'], { language: 'rust' });
		const res = nbmod.setCellExport('cell0', true, nb);
		expect(res.ok).toBe(false);
		expect(onDisk(nb).cells[0].metadata.cellar?.export).toBeUndefined();
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
