/**
 * The SINGLE-CELL routes validate `cell_type` against the shared vocabulary
 * rather than coercing it - over the REAL route handlers against a scratch
 * workspace.
 *
 * `nbCellType` maps anything it does not recognize onto `code`, so an
 * out-of-vocabulary value ('RAW', a trailing space, a typo) did not fail: it
 * silently converted the target into a RUNNABLE Python cell. That was harmless
 * while every non-markdown type was code; with `raw` a real type it can downgrade
 * a cell holding Quarto frontmatter into one with a Run button.
 *
 * The vocabulary is `$lib/cellLanguage`'s `isLogicalCellTypeName`, shared with the
 * bulk route (whose own validation these mirror) so one entry point cannot start
 * accepting a type the others refuse - the list grew by one when `raw` landed,
 * and three hand-maintained copies is how it grows by a fifth in only one of them.
 *
 * The `.py` raw refusal is surfaced here too, in the `{ok:false, reason}` shape
 * the bulk route already speaks, so the browser can resync and SAY why instead of
 * rendering a conversion the document never took.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOGICAL_CELL_TYPES, isLogicalCellTypeName } from '../../src/lib/cellLanguage';

let WS: string;
let nbmod: typeof import('../../src/lib/server/notebook');
let PATCH: (evt: { params: { id: string }; request: Request }) => Promise<Response>;
let ADD: (evt: { request: Request }) => Promise<Response>;

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-celltype-route-'));
	process.env.CELLAR_WORKSPACE = WS;
	nbmod = await import('../../src/lib/server/notebook');
	PATCH = (await import('../../src/routes/api/cells/[id]/+server.js')).PATCH as unknown as typeof PATCH;
	ADD = (await import('../../src/routes/api/cells/+server.js')).POST as unknown as typeof ADD;
});

function makeNotebook(name: string): { nb: string; ids: string[] } {
	const nb = join(WS, name);
	writeFileSync(
		nb,
		JSON.stringify({
			cells: [
				{ cell_type: 'raw', source: ['---\n', 'title: Post\n', '---'], metadata: {}, id: 'rawcell' },
				{ cell_type: 'code', source: ['a = 1'], metadata: {}, outputs: [], execution_count: null, id: 'codecell' }
			],
			metadata: {},
			nbformat: 4,
			nbformat_minor: 5
		})
	);
	return { nb, ids: nbmod.listCells(nb).map((c) => c.id) };
}

const patch = (id: string, body: unknown) =>
	PATCH({ params: { id }, request: new Request(`http://x/api/cells/${id}`, { method: 'PATCH', body: JSON.stringify(body) }) });

const add = (body: unknown) => ADD({ request: new Request('http://x/api/cells', { method: 'POST', body: JSON.stringify(body) }) });

const typesOf = (nb: string) => nbmod.listCells(nb).map((c) => c.cell_type);

/** Values no route may accept - each of which `nbCellType` would read as `code`. */
const BAD_TYPES = ['RAW', 'raw ', 'text', 'Code', 'python', '', 0, true, {}];

describe('PATCH /api/cells/[id] - cell_type vocabulary', () => {
	it('refuses an out-of-vocabulary value with 400 and converts NOTHING', async () => {
		const { nb, ids } = makeNotebook('patch-bad.ipynb');
		for (const cell_type of BAD_TYPES) {
			const res = await patch(ids[0], { cell_type, nb });
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ ok: false, reason: 'bad-cell-type' });
		}
		// The raw cell holding frontmatter is still raw, not a runnable code cell.
		expect(typesOf(nb)).toEqual(['raw', 'code']);
	});

	it('accepts every value in the vocabulary', async () => {
		const { nb, ids } = makeNotebook('patch-good.ipynb');
		for (const cell_type of LOGICAL_CELL_TYPES) {
			const res = await patch(ids[1], { cell_type, nb });
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true });
		}
		expect(typesOf(nb)).toEqual(['raw', 'raw']);
	});

	it('still applies the other fields when cell_type is absent', async () => {
		const { nb, ids } = makeNotebook('patch-source.ipynb');
		const res = await patch(ids[1], { source: 'b = 2', nb });
		expect(res.status).toBe(200);
		expect(nbmod.listCells(nb)[1].source).toBe('b = 2');
		expect(typesOf(nb)).toEqual(['raw', 'code']);
	});

	// A refused PATCH is ALL-OR-NOTHING: the vocabulary check settles before any
	// other field is written, so a body carrying `source` alongside a rejected
	// `cell_type` persists neither. Every caller sends one field today; validating
	// after the first write is how a future batched body silently half-applies.
	it('applies NOTHING else when the cell_type is refused', async () => {
		const { nb, ids } = makeNotebook('patch-atomic.ipynb');
		const res = await patch(ids[1], { source: 'clobbered = 1', cell_type: 'RAW', scrolled: true, nb });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ ok: false, reason: 'bad-cell-type' });
		const cell = nbmod.listCells(nb)[1];
		expect(cell.source).toBe('a = 1');
		expect(cell.metadata?.cellar?.output_scrolled).toBeUndefined();
		expect(typesOf(nb)).toEqual(['raw', 'code']);
	});
});

describe('POST /api/cells - cellType vocabulary', () => {
	it('refuses an out-of-vocabulary value with 400 and creates NO cell', async () => {
		const { nb, ids } = makeNotebook('add-bad.ipynb');
		for (const cellType of BAD_TYPES) {
			const res = await add({ afterId: ids[0], cellType, nb });
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ ok: false, reason: 'bad-cell-type' });
		}
		expect(typesOf(nb)).toEqual(['raw', 'code']);
	});

	it('accepts every value in the vocabulary, and an ABSENT one still means code', async () => {
		const { nb, ids } = makeNotebook('add-good.ipynb');
		for (const cellType of LOGICAL_CELL_TYPES) {
			const res = await add({ afterId: ids[0], cellType, nb });
			expect(res.status).toBe(200);
			expect((await res.json()).cell).toBeTruthy();
		}
		const res = await add({ afterId: ids[0], nb });
		expect((await res.json()).cell.cell_type).toBe('code');
		expect(nbmod.listCells(nb).length).toBe(2 + LOGICAL_CELL_TYPES.length + 1);
	});
});

describe('the vocabulary itself', () => {
	it('is exactly the four logical types, and rejects everything else', () => {
		expect([...LOGICAL_CELL_TYPES].sort()).toEqual(['code', 'markdown', 'raw', 'sql']);
		for (const t of LOGICAL_CELL_TYPES) expect(isLogicalCellTypeName(t)).toBe(true);
		for (const bad of [...BAD_TYPES, null, undefined]) expect(isLogicalCellTypeName(bad)).toBe(false);
	});

	it('is the SAME predicate the bulk route uses', async () => {
		const src = await import('node:fs').then((fs) =>
			fs.readFileSync(new URL('../../src/routes/api/cells/bulk/+server.js', import.meta.url), 'utf8')
		);
		expect(src).toMatch(/isLogicalCellTypeName/);
		// No route may keep a private copy of the list.
		expect(src).not.toMatch(/new Set\(\[['"]code['"]/);
	});
});
