/**
 * A `.py` notebook is discoverable and PINNABLE over MCP.
 *
 * A jupytext / Databricks-source `.py` is a live, kernel-attached notebook
 * everywhere else in Cellar, but the two MCP entry points an agent needs did not
 * know it: `use_notebook` appended `.ipynb` unconditionally (so `parity.py` became
 * a nonexistent `parity.py.ipynb`) and `list_notebooks` filtered to `.ipynb`.
 *
 * That is a correctness bug, not a discovery gap. `use_notebook` is the ONLY way a
 * session pins its working notebook; unpinned, the target follows the USER'S
 * focused tab, so an agent working a `.py` had its writes silently redirected the
 * moment the human switched tabs - `add_and_run`/`edit_cell` landing in the wrong
 * file with no signal. The last test here reproduces exactly that.
 *
 * The jupytext CONVERTER is stubbed (reading a real `.py` shells out to the project
 * venv's python; the `notebook-root-py` precedent). What is NOT stubbed is
 * `isPyNotebookFile`, the marker sniff - it decides what may be listed and opened,
 * so it is the thing under test.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../src/lib/server/jupytext', async () => {
	const actual = await vi.importActual<typeof import('../../src/lib/server/jupytext')>(
		'../../src/lib/server/jupytext'
	);
	return {
		...actual,
		// Two cells, no python. `isPyNotebookFile`/`isPyPath` stay REAL - the sniff is
		// what gates both entry points, so stubbing it would test nothing.
		readPyNotebook: () => ({
			format: 'databricks',
			cells: [
				{ id: null, cell_type: 'code', source: 'x = 1', outputs: [], metadata: {} },
				{ id: null, cell_type: 'code', source: 'print(x)', outputs: [], metadata: {} }
			]
		}),
		writePyNotebook: (path: string) => writeFileSync(path, '# Databricks notebook source\nx = 1\n')
	};
});

let WS: string;
let svc: typeof import('../../src/lib/server/mcp/service');
let nbmod: typeof import('../../src/lib/server/notebook');

const DBX = '# Databricks notebook source\nx = 1\n\n# COMMAND ----------\n\nprint(x)\n';
const PERCENT = '"""A module docstring."""\n\n# %%\nx = 1\n';
const PLAIN = 'def helper():\n    return 42\n';

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-mcp-py-'));
	process.env.CELLAR_WORKSPACE = WS;
	mkdirSync(join(WS, 'scripts'), { recursive: true });
	writeFileSync(join(WS, 'scripts', 'parity.py'), DBX);
	writeFileSync(join(WS, 'percent_nb.py'), PERCENT);
	writeFileSync(join(WS, 'helpers.py'), PLAIN);
	// A real, non-notebook file with an extension: `use_notebook` must not take it.
	writeFileSync(join(WS, 'package.json'), '{\n  "name": "not-a-notebook"\n}\n');
	svc = await import('../../src/lib/server/mcp/service');
	nbmod = await import('../../src/lib/server/notebook');
	// An ordinary notebook to switch the user's focus to.
	svc.useNotebook(undefined, 'other.ipynb');
});

describe('use_notebook resolves a .py notebook literally', () => {
	it('pins the .py itself, never a .py.ipynb', () => {
		const r = svc.useNotebook('sessPy', 'scripts/parity.py', false);
		expect(r.working_notebook).toBe('scripts/parity.py');
		expect(r.path.endsWith('.py.ipynb')).toBe(false);
		expect(r.pinned).toBe(true);
		expect(r.created).toBe(false);
		// It really opened as a notebook: the converter's cells are there.
		expect(r.cells).toBe(2);
		expect(svc.targetFor('sessPy')).toBe(nbmod.resolveNotebookPath('scripts/parity.py'));
	});

	it('a bare name still resolves to .ipynb (unchanged behavior)', () => {
		const r = svc.useNotebook('sessBare', 'analysis');
		expect(r.working_notebook).toBe('analysis.ipynb');
		expect(r.created).toBe(true);
	});

	it('a missing .py errors clearly and invents no .py.ipynb', () => {
		expect(() => svc.useNotebook('sessMissing', 'nope.py')).toThrow(/cannot create a \.py notebook/i);
		// Neither the .py nor a rewritten sibling was created, and nothing was pinned.
		expect(nbmod.notebookExists('nope.py')).toBe(false);
		expect(nbmod.notebookExists('nope.py.ipynb')).toBe(false);
		expect(svc.targetFor('sessMissing')).toBe(nbmod.getActiveNotebookPath());
	});

	it('a plain .py module is refused as a notebook', () => {
		expect(() => svc.useNotebook('sessPlain', 'helpers.py')).toThrow(/plain Python file/i);
	});

	it('an existing NON-notebook file is never opened as one, whatever its extension', () => {
		// Only a path naming a notebook FORMAT resolves literally. Resolving any existing
		// file would pin it, and the first add_cell/edit_cell would then persist nbformat
		// JSON straight over the user's file.
		const pkg = join(WS, 'package.json');
		const before = readFileSync(pkg);
		const r = svc.useNotebook('sessPkg', 'package.json');
		expect(r.working_notebook).toBe('package.json.ipynb');
		expect(svc.targetFor('sessPkg')).toBe(nbmod.resolveNotebookPath('package.json.ipynb'));
		expect(readFileSync(pkg)).toEqual(before);
	});
});

describe('list_notebooks discovers .py notebooks', () => {
	it('lists marker-carrying .py files and excludes a plain module', () => {
		const paths = svc.listNotebooks().notebooks.map((n) => n.path);
		expect(paths).toContain('scripts/parity.py'); // Databricks header
		expect(paths).toContain('percent_nb.py'); // `# %%` below a docstring
		expect(paths).not.toContain('helpers.py'); // no marker: a module, not a notebook
		expect(paths).toContain('other.ipynb'); // .ipynb listing unchanged
	});

	it('marks the session working notebook, so a listed .py can be pinned', () => {
		const r = svc.listNotebooks('sessPy');
		expect(r.notebooks_pinned).toBe(true);
		expect(r.working_notebook).toBe('scripts/parity.py');
		expect(r.notebooks.find((n) => n.path === 'scripts/parity.py')?.working).toBe(true);
	});
});

describe('the wrong-notebook bug this closes', () => {
	it('a pinned .py session survives the user switching tabs', () => {
		svc.useNotebook('sessDrift', 'scripts/parity.py', false);
		// The human focuses another notebook mid-task - the observed failure.
		nbmod.setActiveNotebook('other.ipynb');
		expect(nbmod.getActiveNotebookPath()).toBe(nbmod.resolveNotebookPath('other.ipynb'));
		// The agent's target does NOT follow: writes still land in the .py.
		expect(svc.targetFor('sessDrift')).toBe(nbmod.resolveNotebookPath('scripts/parity.py'));
	});
});
