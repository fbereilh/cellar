/**
 * An unreadable canonical `notebook.ipynb` costs ONE TAB, never the whole shell.
 *
 * The reader is strict (see `ipynb.ts`'s `readNotebook`), and its refusal names a
 * remedy — delete the file and create it again from the file explorer. That remedy
 * is only reachable if the shell renders, and the shell's SSR `load()` seeds itself
 * from the canonical notebook: an unguarded read there took the entire page down,
 * so the user never reached the explorer and, in a production build, was not even
 * shown the reason (SvelteKit sanitises a load error into a generic page).
 *
 * These drive the REAL `load()` from `src/routes/+page.server.js` against real
 * scratch workspaces. The last block is the one that matters most: the stand-in
 * `load()` returns is display-only, so no later write can land on top of bytes
 * Cellar could not read — which for a CORRUPT notebook would be real data loss.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let load: () => any;
let nbmod: typeof import('../../src/lib/server/notebook');

/** A real, healthy nbformat 4.5 notebook. */
const HEALTHY = JSON.stringify(
	{
		cells: [
			{
				cell_type: 'code',
				execution_count: null,
				id: 'healthy-cell',
				metadata: {},
				outputs: [],
				source: ['kept = 1']
			}
		],
		metadata: {},
		nbformat: 4,
		nbformat_minor: 5
	},
	null,
	1
);

/** A fresh workspace for one case, wired up exactly as SSR sees it. */
function workspace(canonical?: string): string {
	const ws = mkdtempSync(join(tmpdir(), 'cellar-canonical-'));
	process.env.CELLAR_WORKSPACE = ws;
	// Never read (or write) the developer's own cross-project settings file.
	mkdirSync(join(ws, '.cellar'), { recursive: true });
	process.env.CELLAR_USER_SETTINGS = join(ws, '.cellar', 'user-settings.json');
	if (canonical !== undefined) writeFileSync(join(ws, 'notebook.ipynb'), canonical);
	return ws;
}

beforeAll(async () => {
	// Set a workspace before the modules load so nothing resolves against the repo.
	workspace();
	load = (await import('../../src/routes/+page.server.js')).load as unknown as typeof load;
	nbmod = await import('../../src/lib/server/notebook');
});

describe('SSR renders the shell even when the canonical notebook cannot be read', () => {
	it('a BLANK notebook.ipynb resolves, and reports the empty-file reason', () => {
		const ws = workspace('');
		const data = load();
		expect(data.notebookError).toMatch(/file is empty/i);
		expect(data.notebookError).toMatch(/create it again from the file explorer/i);
		// The fields `+page.svelte` reads unconditionally must still be valid.
		expect(data.notebook.workspace).toBe(ws);
		expect(data.notebook.path).toBe(join(ws, 'notebook.ipynb'));
		expect(Array.isArray(data.notebook.cells)).toBe(true);
	});

	it('a CORRUPT notebook.ipynb resolves, and reports the parse reason instead', () => {
		workspace('{"cells": [oops');
		const data = load();
		expect(data.notebookError).toMatch(/^not valid JSON \(.+\)$/s);
		// The two refusals stay distinguishable: this one is not the empty-file case.
		expect(data.notebookError).not.toMatch(/file is empty/i);
		expect(Array.isArray(data.notebook.cells)).toBe(true);
	});

	it('the rest of the payload is unaffected by the failure', () => {
		workspace('');
		const data = load();
		expect(typeof data.maxKernels).toBe('number');
		expect(data.uiState).toBeTruthy();
		expect(data.userSettings).toBeTruthy();
		expect(data.mcp.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
	});
});

const ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

describe(
	ROOT ? 'the reason never leaks a server path (skipped: running as root ignores file modes)' : 'the reason never leaks a server path',
	() => {
		it.skipIf(ROOT)('an fs-level failure reports the cause without the absolute path', () => {
			const ws = workspace('');
			const abs = join(ws, 'notebook.ipynb');
			// `readNotebook` reads the file OUTSIDE its parse try, so this throws Node's
			// own `EACCES: permission denied, open '<abs>'` - the shape that used to be
			// printed verbatim on the page.
			chmodSync(abs, 0o000);
			try {
				const data = load();
				expect(data.notebookError).toBeTruthy();
				expect(data.notebookError).not.toContain(ws);
				expect(data.notebookError).not.toMatch(/(^|\s)\//);
				// Stripped, not silenced: the cause still reads as something.
				expect(data.notebookError).toMatch(/EACCES|permission/i);
			} finally {
				chmodSync(abs, 0o644);
			}
		});

		it('the two refusals it is written for pass through completely unchanged', () => {
			workspace('');
			expect(load().notebookError).toBe(
				'the file is empty, so there is no notebook to open - delete it and create it again from the file explorer'
			);

			workspace('{"cells": [oops');
			const corrupt = load().notebookError;
			expect(corrupt).toMatch(/^not valid JSON \(.+\)$/s);
		});
	}
);

describe('the ordinary cases are unchanged', () => {
	it('a healthy notebook.ipynb loads its cells and reports no error', () => {
		workspace(HEALTHY);
		const data = load();
		expect(data.notebookError).toBeNull();
		expect(data.notebook.cells).toHaveLength(1);
		expect(data.notebook.cells[0].source).toBe('kept = 1');
	});

	it('NO notebook.ipynb at all still materialises the starter document in memory', () => {
		const ws = workspace();
		const data = load();
		expect(data.notebookError).toBeNull();
		expect(data.notebook.cells).toHaveLength(1);
		expect(data.notebook.path).toBe(join(ws, 'notebook.ipynb'));
		// Loading still writes nothing: Cellar drops no uninvited file.
		expect(() => readFileSync(join(ws, 'notebook.ipynb'))).toThrow();
	});
});

describe('the stand-in is display-only and can never be written over the file', () => {
	let ws: string;

	beforeEach(() => {
		ws = workspace('{"cells": [oops');
		load();
	});

	it('reading the notebook through the ordinary route still refuses', () => {
		// `GET /api/notebooks?path=` goes through this, so the tab reports the reason
		// rather than being handed the SSR stand-in.
		expect(() => nbmod.getNotebook('notebook.ipynb')).toThrow(/not valid JSON/i);
	});

	it('every mutation path still refuses, and the bytes are untouched', () => {
		const abs = join(ws, 'notebook.ipynb');
		const before = readFileSync(abs, 'utf8');

		// `createNotebook` is what the empty state's "New notebook" button posts to.
		expect(() => nbmod.createNotebook('notebook.ipynb')).toThrow(/not valid JSON/i);
		// A cell write addressed at the canonical notebook cannot resolve a document.
		expect(() => nbmod.addCell(null, 'code', 'notebook.ipynb')).toThrow(/not valid JSON/i);
		expect(() => nbmod.setActiveNotebook('notebook.ipynb')).toThrow(/not valid JSON/i);

		expect(readFileSync(abs, 'utf8')).toBe(before);
	});
});
