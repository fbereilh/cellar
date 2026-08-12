/**
 * CODE ROOTS on a `.py` (jupytext / Databricks source) notebook: REFUSED, never
 * silently accepted.
 *
 * A `.py` notebook is written back from its CELLS alone, so it carries no
 * notebook-level metadata on disk. A root declared on one would live only in
 * memory and be gone on the next reload, after which the notebook would run at
 * the workspace root while still looking like the tree under review — the exact
 * silent degrade `resolveRootDir` refuses everywhere else. So the declaration is
 * refused by name, and the UI offers no picker (`NotebookView.isPy`).
 *
 * CLEARING stays allowed in every case: it can only remove state, never strand it.
 *
 * The jupytext bridge is stubbed because reading a real `.py` notebook shells out
 * to the project venv's python; what is under test is the notebook layer's rule,
 * not the converter.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const written: { path: string; format: string }[] = [];

vi.mock('../../src/lib/server/jupytext', async () => {
	const actual = await vi.importActual<typeof import('../../src/lib/server/jupytext')>(
		'../../src/lib/server/jupytext'
	);
	return {
		...actual,
		// A one-cell Databricks notebook, without python: `jpFormat` is what the
		// notebook layer keys the refusal off, and it is set from this.
		readPyNotebook: () => ({
			format: 'databricks',
			cells: [{ id: null, cell_type: 'code', source: 'print(1)', outputs: [], metadata: {} }]
		}),
		writePyNotebook: (path: string, _cells: unknown, format: string) => {
			// The real writer rebuilds the file from cells alone — no metadata anywhere,
			// which is precisely why a root cannot survive here.
			written.push({ path, format });
			writeFileSync(path, '# Databricks notebook source\nprint(1)\n');
		}
	};
});

let WS: string;
let nbmod: typeof import('../../src/lib/server/notebook');
let actions: typeof import('../../src/lib/server/notebook-root-actions');
let PY: string;
let IPYNB: string;

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-root-py-'));
	process.env.CELLAR_WORKSPACE = WS;
	mkdirSync(join(WS, 'roots', 'pr-482'), { recursive: true });
	PY = join(WS, 'dbx.py');
	writeFileSync(PY, '# Databricks notebook source\nprint(1)\n');
	nbmod = await import('../../src/lib/server/notebook');
	actions = await import('../../src/lib/server/notebook-root-actions');
	IPYNB = nbmod.createNotebook('normal.ipynb').path;
});

describe('a .py notebook cannot hold a code root', () => {
	it('REFUSES a declaration, naming .py and the fix — and writes nothing', async () => {
		expect(() => nbmod.setNotebookRoot('roots/pr-482', PY)).toThrow(/\.py notebook/i);
		expect(() => nbmod.setNotebookRoot('roots/pr-482', PY)).toThrow(/convert it to \.ipynb/i);
		await expect(actions.setNotebookRootAndRestart('roots/pr-482', PY)).rejects.toThrow(/\.py notebook/i);
		expect(nbmod.getNotebookRoot(PY)).toBeNull();
		// The refusal happens BEFORE any write: the file is untouched and still the
		// text notebook it was.
		expect(readFileSync(PY, 'utf8')).toBe('# Databricks notebook source\nprint(1)\n');
	});

	it('names the .py reason even when the DIRECTORY is also unusable', async () => {
		// Reporting "roots/gone does not exist" would send the user to create a
		// directory that still could not be declared here.
		await expect(actions.setNotebookRootAndRestart('roots/gone', PY)).rejects.toThrow(/\.py notebook/i);
	});

	it('refuses an OUT-OF-WORKSPACE path with the .py reason, spawning NO git', async () => {
		// The ordering became more valuable once a path outside the workspace can be
		// admitted: without it, a `.py` notebook given a worktree path would spawn a
		// `git worktree list`, quite possibly answer "not a registered worktree", and
		// send the user off to fix git when the real problem is the notebook format.
		const gitmod = await import('../../src/lib/server/git');
		gitmod.invalidateGitCaches();
		gitmod.resetGitSpawnCount();

		await expect(actions.setNotebookRootAndRestart('../elsewhere', PY)).rejects.toThrow(/\.py notebook/i);
		await expect(actions.setNotebookRootAndRestart('/tmp/elsewhere', PY)).rejects.toThrow(/\.py notebook/i);

		// The count IS the assertion: the refusal must not have consulted git at all.
		expect(gitmod.gitSpawnCount()).toBe(0);
	});

	it('CLEARING is still allowed — it can only remove state', async () => {
		expect(nbmod.setNotebookRoot('', PY)).toBeNull();
		expect(nbmod.setNotebookRoot(null, PY)).toBeNull();
		const cleared = await actions.setNotebookRootAndRestart(null, PY);
		expect(cleared).toMatchObject({ root: null, changed: false });
	});

	it('reports isPy so the browser renders no root control at all', () => {
		expect(nbmod.getNotebook(PY).isPy).toBe(true);
		expect(nbmod.getNotebook(PY).root).toBeNull();
		// An ordinary notebook is untouched in both directions.
		expect(nbmod.getNotebook(IPYNB).isPy).toBe(false);
		expect(nbmod.setNotebookRoot('roots/pr-482', IPYNB)).toBe('roots/pr-482');
		expect(nbmod.getNotebook(IPYNB).root).toBe('roots/pr-482');
		nbmod.setNotebookRoot(null, IPYNB);
	});
});
