/**
 * Chat cells are creatable from the ADD affordances - the bottom add row and the
 * hover-between gap strip - not only through the per-cell type menu, and both
 * controls are WITHHELD on a `.py` text notebook, which cannot hold one.
 *
 * The gate those controls are drawn under is `offersCellType` in
 * `$lib/cellLanguage` - a pure exported rule, so it is tested by EXECUTING it:
 * a truth table over every logical type, plus the invariant that actually
 * matters, driven against real documents - a type is offered exactly when the
 * real doc-layer writer accepts it. That correspondence is the whole point of
 * the gate: a control that offers a type `assertCanHoldType` is about to refuse
 * is the drift the cell-type menu's `typeOptions` filter already exists to
 * prevent, and it now cannot happen for one surface and not another, because
 * all three ask the same function.
 *
 * A few narrow SOURCE guards survive at the bottom. Each carries its own reason;
 * the shared half is that vitest here runs WITHOUT the SvelteKit plugin (see
 * `vite.config.js`), so no component in this repo can be mounted, and the e2e
 * that does drive the rendered controls (`tests/e2e/insert-cell.spec.ts`) is
 * deliberately absent from CI and the no-mistakes gate. They assert WIRING only
 * - which rule a template asks, which gate a control sits under - never what the
 * rule MEANS, which is executed above.
 *
 * The server's own refusal is unit-covered in `chat-cell-py-notebook.test.ts`.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	LOGICAL_CELL_TYPES,
	PY_UNSUPPORTED_TYPES,
	TextNotebookCellTypeError,
	offersCellType
} from '../../src/lib/cellLanguage';
import type { LogicalCellType } from '../../src/lib/server/types';

const PY_BYTES = '# Databricks notebook source\nprint(1)\n\n# COMMAND ----------\n\nprint(2)\n';

// Reading a real `.py` notebook shells out to the project venv's python; what is
// under test is the notebook layer's rule, not the converter (the
// `chat-cell-py-notebook.test.ts` / `raw-cell-py-notebook.test.ts` harness).
vi.mock('../../src/lib/server/jupytext', async () => {
	const actual = await vi.importActual<typeof import('../../src/lib/server/jupytext')>(
		'../../src/lib/server/jupytext'
	);
	return {
		...actual,
		readPyNotebook: () => ({
			format: 'databricks',
			cells: [
				{ id: null, cell_type: 'code', source: 'print(1)', outputs: [], metadata: {} },
				{ id: null, cell_type: 'code', source: 'print(2)', outputs: [], metadata: {} }
			]
		}),
		// The REAL writer's coercion, reproduced: no metadata, no outputs.
		writePyNotebook: (path: string, cells: { cell_type: string; source: string }[]) => {
			writeFileSync(path, cells.map((c) => c.source).join('\n\n# COMMAND ----------\n\n') + '\n');
		}
	};
});

let nbmod: typeof import('../../src/lib/server/notebook');
let PY: string;
let IPYNB: string;

beforeAll(async () => {
	const ws = mkdtempSync(join(tmpdir(), 'cellar-add-chat-'));
	process.env.CELLAR_WORKSPACE = ws;
	PY = join(ws, 'dbx.py');
	writeFileSync(PY, PY_BYTES);
	nbmod = await import('../../src/lib/server/notebook');
	IPYNB = nbmod.createNotebook('normal.ipynb').path;
});

/** Does the REAL doc-layer creator accept this logical type for this notebook? */
function writerAccepts(nb: string, cellType: LogicalCellType): boolean {
	try {
		nbmod.addCell(null, cellType, nb);
		return true;
	} catch (err) {
		if (err instanceof TextNotebookCellTypeError) return false;
		throw err;
	}
}

describe('offersCellType - the one rule every create control asks', () => {
	it('offers every logical type on an .ipynb notebook', () => {
		for (const type of LOGICAL_CELL_TYPES) {
			expect(offersCellType(type, false), `offersCellType('${type}', isPy=false)`).toBe(true);
		}
	});

	it('withholds chat (and raw) on a .py notebook, and offers the rest', () => {
		expect(offersCellType('chat', true)).toBe(false);
		expect(offersCellType('raw', true)).toBe(false);
		for (const type of ['code', 'sql', 'markdown'] as const) {
			expect(offersCellType(type, true), `offersCellType('${type}', isPy=true)`).toBe(true);
		}
	});

	it('withholds EXACTLY the types the shared list names, so a sixth type is added once', () => {
		const withheld = LOGICAL_CELL_TYPES.filter((type) => !offersCellType(type, true));
		expect([...withheld].sort()).toEqual([...PY_UNSUPPORTED_TYPES].sort());
	});
});

describe('a type is offered exactly when the document can really hold it', () => {
	it('the .py verdicts match the doc-layer writer, type for type', () => {
		for (const type of LOGICAL_CELL_TYPES) {
			expect(writerAccepts(PY, type), `addCell('${type}') on a .py notebook`).toBe(
				offersCellType(type, true)
			);
		}
		// Nothing the rule withholds got into the document - which is the degrade
		// itself: on a `.py` these would come back as plain runnable code cells.
		const py = nbmod.listCells(PY);
		expect(py.every((c) => c.metadata?.cellar?.language !== 'chat')).toBe(true);
		expect(py.every((c) => c.cell_type !== 'raw')).toBe(true);
	});

	it('the .ipynb verdicts match the doc-layer writer, type for type', () => {
		for (const type of LOGICAL_CELL_TYPES) {
			expect(writerAccepts(IPYNB, type), `addCell('${type}') on an .ipynb notebook`).toBe(
				offersCellType(type, false)
			);
		}
		// And the offered chat cell really is a chat cell - a `code` cell tagged
		// `cellar.language`, surviving clean-on-save to disk.
		const onDisk = JSON.parse(readFileSync(IPYNB, 'utf8')) as {
			cells: Array<{ cell_type: string; metadata?: { cellar?: { language?: string } } }>;
		};
		const chat = onDisk.cells.find((c) => c.metadata?.cellar?.language === 'chat');
		expect(chat?.cell_type).toBe('code');
	});
});

const read = (rel: string) => readFileSync(new URL(`../../src/lib/${rel}`, import.meta.url), 'utf8');

/**
 * The `{#if ...}` a control sits directly under, plus the template text between
 * that gate and the control - so a control's gate and its handler are read
 * together rather than merely co-occurring in the file.
 */
function gatedControl(src: string, marker: string): { gate: string; head: string } {
	const at = src.indexOf(marker);
	expect(at, `expected to find ${marker}`).toBeGreaterThanOrEqual(0);
	const open = src.lastIndexOf('{#if ', at);
	expect(open, `expected an {#if} gate before ${marker}`).toBeGreaterThanOrEqual(0);
	return { gate: src.slice(open, src.indexOf('}', open) + 1), head: src.slice(open, at) };
}

describe('the wiring the browser ships (source guards - see the file header)', () => {
	const notebookSrc = read('Notebook.svelte');

	// WHY SOURCE: which rule a Svelte template ASKS is observable only by mounting
	// the component, which vitest cannot do here. What the rule MEANS is executed
	// above; this pins only that the template goes through it rather than
	// restating the refused-types list, which is how the three surfaces would
	// drift apart again.
	it('the chat gate is computed by calling the shared rule, not by restating it', () => {
		expect(notebookSrc).toMatch(/const offerChatCell = \$derived\(offersCellType\('chat', isPy\)\)/);
		expect(notebookSrc).not.toMatch(/PY_UNSUPPORTED_TYPES|isPyUnsupportedType/);
	});

	// WHY SOURCE: the rendered outcome - both controls absent on a `.py` notebook,
	// present and creating a tagged chat cell otherwise - IS asserted for real in
	// tests/e2e/insert-cell.spec.ts, but e2e is deliberately absent from CI and
	// the no-mistakes gate, so the gate a control sits under needs a CI-visible
	// check and source is the only one available here.
	it('both chat controls sit under that gate and name the chat type', () => {
		const add = gatedControl(notebookSrc, 'data-testid="add-chat"');
		expect(add.gate).toBe('{#if offerChatCell}');
		expect(add.head).toMatch(/onAddCell\(cells\.at\(-1\)\?\.id, 'chat'\)/);

		const insert = gatedControl(notebookSrc, 'data-testid="insert-chat"');
		expect(insert.gate).toBe('{#if offerChatCell}');
		expect(insert.head).toMatch(/onInsertCell\(where, targetId, 'chat'\)/);
	});

	// WHY SOURCE: same reason - and this one is a design constraint with no
	// runtime signal at all (the common case must stay one click), so there is
	// nothing to execute even with a mounted component.
	it('the gap strip keeps Code FIRST and ungated - the common case pays nothing', () => {
		const strip = notebookSrc.slice(
			notebookSrc.indexOf('{#snippet insertControls('),
			notebookSrc.indexOf('{/snippet}')
		);
		const code = strip.indexOf('data-testid="insert-code"');
		expect(code).toBeGreaterThanOrEqual(0);
		expect(strip.indexOf('data-testid="insert-chat"')).toBeGreaterThan(code);
		// Only the strip's own `{#if targetId}` stands over the code button, so it
		// renders in every gap on every notebook, `.py` included.
		expect(gatedControl(strip, 'data-testid="insert-code"').gate).toBe('{#if targetId}');
	});

	// WHY SOURCE: as above - "this button inserts code and offers no picker" is a
	// property of the markup, and the click itself is e2e-covered.
	it('the per-cell insert icons stay hardwired to code - the one-click fast path', () => {
		const cellSrc = read('Cell.svelte');
		expect(cellSrc).toMatch(/onInsertCell\('above', cell\.id, 'code'\)/);
		expect(cellSrc).toMatch(/onInsertCell\('below', cell\.id, 'code'\)/);
	});
});
