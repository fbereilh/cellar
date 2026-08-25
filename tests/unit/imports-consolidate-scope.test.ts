/**
 * Consolidate imports sweeps PYTHON cells only.
 *
 * The sweep hands each candidate's source to the Python import tokenizer and
 * REWRITES it, so which cells it picks is a correctness rule, not a filter: a
 * SQL cell and a CHAT cell are nbformat `code` cells too, and a chat cell's
 * source is English prose that routinely quotes code. Selecting on
 * `cell_type === 'code'` therefore lifted a parseable `import ...` line out of a
 * user's QUESTION into the imports cell and ran it, and let an imports-only
 * first cell of either kind be ADOPTED as the imports cell.
 *
 * `dataflow.ts` and `staleness.ts` already exclude those cells from the Python
 * probe for the same reason; this is the third Python-machinery entry point.
 *
 * The kernel is out of scope here (the imports cell RUNS when something moved),
 * so `executeCellRun` is stubbed - what is under test is which cells the sweep
 * rewrites.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../src/lib/server/run', () => ({
	executeCellRun: vi.fn(async () => ({
		outputs: [],
		status: 'ok',
		session: 1,
		kernelDown: false,
		lastRun: { at: 0, durationMs: 0, actor: 'user', status: 'ok', session: 1 }
	})),
	clearOutputsForQueue: () => {}
}));

let WS: string;
let nbmod: typeof import('../../src/lib/server/notebook');
let imports: typeof import('../../src/lib/server/imports-cell');

const CHAT_QUESTION = 'Why does this fail?\n\nimport pandas as pd\ndf = pd.read_csv("x.csv")\n\nIs the path wrong?';
const SQL_SOURCE = '-- >> rows\nselect * from import_log';

/** A notebook: python cell / sql cell / chat cell, in that order. */
function makeNotebook(name: string, cells: Array<{ source: string; cellar?: Record<string, unknown> }>): string {
	const nb = join(WS, name);
	writeFileSync(
		nb,
		JSON.stringify({
			cells: cells.map((c, i) => ({
				cell_type: 'code',
				source: [c.source],
				metadata: { cellar: c.cellar ?? {} },
				outputs: [],
				execution_count: null,
				id: `cell${i}`
			})),
			metadata: {},
			nbformat: 4,
			nbformat_minor: 5
		})
	);
	return nb;
}

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-consolidate-'));
	process.env.CELLAR_WORKSPACE = WS;
	nbmod = await import('../../src/lib/server/notebook');
	imports = await import('../../src/lib/server/imports-cell');
});

describe('the sweep rewrites python cells and nothing else', () => {
	it("leaves a chat question's prose and a SQL query byte-identical while lifting the python import", async () => {
		const nb = makeNotebook('mixed.ipynb', [
			{ source: 'import os\nprint(os.getcwd())' },
			{ source: SQL_SOURCE, cellar: { language: 'sql' } },
			{ source: CHAT_QUESTION, cellar: { language: 'chat' } }
		]);
		const res = await imports.consolidateImports(nb);
		expect(res.changed).toBe(true);
		const by = Object.fromEntries(nbmod.listCells(nb).map((c) => [c.id, c]));
		// The python cell was swept: its import moved into the imports cell.
		expect(by.cell0.source).toBe('print(os.getcwd())');
		expect(nbmod.listCells(nb).find((c) => c.metadata?.cellar?.role === 'imports')?.source).toContain('import os');
		// The prose and the query are untouched - not one character lifted.
		expect(by.cell2.source).toBe(CHAT_QUESTION);
		expect(by.cell1.source).toBe(SQL_SOURCE);
		// And the question's import never reached the imports cell.
		expect(res.added).toEqual(['import os']);
	});

	it('never alters a STRING RIDER while lifting the import off its line', async () => {
		// A regression, and a corruption one: the sweep rebuilds the residual with
		// `kept.join('; ')`, so while the top-level `;` splitter was not string-aware
		// `import os; sep = "a;b"` came apart into `sep = "a` and `b"` and the cell was
		// written back as `sep = "a; b"` - a structural edit that was only supposed to
		// lift the import out, silently changing the user's DATA. The import must still
		// be lifted; only the rider must survive byte-for-byte.
		const nb = makeNotebook('rider.ipynb', [{ source: 'import os; sep = "a;b"\nprint(sep)' }]);
		const res = await imports.consolidateImports(nb);
		expect(res.changed).toBe(true);
		const by = Object.fromEntries(nbmod.listCells(nb).map((c) => [c.id, c]));
		expect(by.cell0.source).toBe('sep = "a;b"\nprint(sep)');
		expect(res.added).toEqual(['import os']);
	});

	it('a chat cell that is nothing but an import line is never ADOPTED as the imports cell', async () => {
		const nb = makeNotebook('adopt.ipynb', [
			{ source: 'import pandas as pd', cellar: { language: 'chat' } },
			{ source: 'import numpy as np\nnp.zeros(1)' }
		]);
		await imports.consolidateImports(nb);
		const cells = nbmod.listCells(nb);
		const importsCell = cells.find((c) => c.metadata?.cellar?.role === 'imports');
		expect(importsCell).toBeDefined();
		expect(importsCell?.id).not.toBe('cell0');
		expect(importsCell?.metadata?.cellar?.language).toBeUndefined();
		// The chat cell keeps its source AND its type.
		const chat = cells.find((c) => c.id === 'cell0');
		expect(chat?.source).toBe('import pandas as pd');
		expect(chat?.metadata?.cellar?.language).toBe('chat');
	});

	it('a notebook whose only import-looking lines are prose is a genuine no-op', async () => {
		const nb = makeNotebook('prose-only.ipynb', [
			{ source: CHAT_QUESTION, cellar: { language: 'chat' } },
			{ source: 'x = 1' }
		]);
		const before = nbmod.listCells(nb).map((c) => c.source);
		const res = await imports.consolidateImports(nb);
		expect(res.changed).toBe(false);
		expect(res.imports_cell_id).toBeNull();
		expect(nbmod.listCells(nb).map((c) => c.source)).toEqual(before);
	});
});
