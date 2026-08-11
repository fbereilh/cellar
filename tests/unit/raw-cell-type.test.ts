/**
 * `raw` as a first-class nbformat cell type - the MODEL and its PERSISTENCE, on
 * the REAL modules against a scratch workspace.
 *
 * An nbformat `raw` cell is verbatim text Cellar never executes and never
 * renders: Quarto/nbdev frontmatter, nbconvert directives. It is one of the three
 * types nbformat 4.5 defines, which is precisely why it is a real `cell_type`
 * here while `sql` is a metadata tag - see `$lib/cellLanguage`'s header for that
 * inversion.
 *
 * The load-bearing cases, in the order they bite:
 *
 *  - `nbCellType` is the ONE logical -> nbformat mapping. Four hand-written
 *    copies of the old `=== 'markdown' ? 'markdown' : 'code'` ternary are what
 *    let a raw cell be silently retyped to code by whichever copy was not
 *    updated, so the mapping is pinned rather than assumed.
 *  - `isLogicalCellType(rawCell, 'code')` must stay FALSE. If it flips, the bulk
 *    retype silently stops converting raw cells while the single-cell setter
 *    still does - the exact divergence its doc comment records.
 *  - Persistence needs no change at all, and this proves it: `serialize` and
 *    `cleanCell` already key on `cell_type === 'code'`, so a raw cell round-trips
 *    with no `outputs` and no `execution_count` and is byte-identical on a second
 *    pass.
 *  - A checkpoint RESTORE preserves the type. It did not before this work.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nbCellType, isRawCell, logicalCellType, isLogicalCellType, SQL_LANGUAGE } from '../../src/lib/cellLanguage';
import { deserialize, serialize, stringify } from '../../src/lib/server/ipynb';

let WS: string;
let nbmod: typeof import('../../src/lib/server/notebook');
let ckmod: typeof import('../../src/lib/server/checkpoints');

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-raw-cell-'));
	process.env.CELLAR_WORKSPACE = WS;
	nbmod = await import('../../src/lib/server/notebook');
	ckmod = await import('../../src/lib/server/checkpoints');
});

const FRONTMATTER = '---\ntitle: Post\n---';

/** A notebook on disk carrying a raw frontmatter cell above a code cell. */
function makeRawNotebook(name: string): string {
	const nb = join(WS, name);
	writeFileSync(
		nb,
		JSON.stringify({
			cells: [
				{ cell_type: 'raw', source: ['---\n', 'title: Post\n', '---\n'], metadata: {}, id: 'rawcell' },
				{ cell_type: 'code', source: ['a = 1'], metadata: {}, outputs: [], execution_count: null, id: 'codecell' }
			],
			metadata: {},
			nbformat: 4,
			nbformat_minor: 5
		})
	);
	return nb;
}

const rawCell = { cell_type: 'raw', metadata: {} };
const codeCell = { cell_type: 'code', metadata: {} };
const mdCell = { cell_type: 'markdown', metadata: {} };
const sqlCell = { cell_type: 'code', metadata: { cellar: { language: SQL_LANGUAGE } } };

describe('the logical <-> nbformat mapping', () => {
	it('maps every logical type onto its nbformat type', () => {
		expect(nbCellType('code')).toBe('code');
		expect(nbCellType('sql')).toBe('code'); // a tagged code cell, not a type of its own
		expect(nbCellType('markdown')).toBe('markdown');
		expect(nbCellType('raw')).toBe('raw');
	});

	it('reads a raw cell as the raw logical type', () => {
		expect(logicalCellType(rawCell)).toBe('raw');
		expect(logicalCellType(codeCell)).toBe('code');
		expect(logicalCellType(mdCell)).toBe('markdown');
		expect(logicalCellType(sqlCell)).toBe('sql');
	});

	it('lets raw win over a stray sql language tag', () => {
		// `isSqlCell` already requires cell_type === 'code', but a foreign notebook
		// can carry any metadata and the answer must not depend on that.
		expect(logicalCellType({ cell_type: 'raw', metadata: { cellar: { language: SQL_LANGUAGE } } })).toBe('raw');
	});

	it('identifies a raw cell', () => {
		expect(isRawCell(rawCell)).toBe(true);
		for (const c of [codeCell, mdCell, sqlCell, null, undefined]) expect(isRawCell(c)).toBe(false);
	});

	// The full truth table. The two entries that carry the weight are
	// (raw, 'code') === false - which is what keeps a bulk retype-to-code
	// CONVERTING a raw cell rather than skipping it - and (raw, 'raw') === true.
	it('answers the whole isLogicalCellType truth table', () => {
		const table: [string, typeof codeCell, Record<string, boolean>][] = [
			['code', codeCell, { code: true, markdown: false, sql: false, raw: false }],
			['sql', sqlCell, { code: false, markdown: false, sql: true, raw: false }],
			['markdown', mdCell, { code: false, markdown: true, sql: false, raw: false }],
			['raw', rawCell, { code: false, markdown: false, sql: false, raw: true }]
		];
		for (const [name, cell, want] of table) {
			for (const [type, expected] of Object.entries(want)) {
				expect(isLogicalCellType(cell, type as 'code'), `${name} is ${type}`).toBe(expected);
			}
		}
	});
});

describe('persistence', () => {
	it('round-trips a raw cell with no outputs, no execution_count, and idempotently', () => {
		const onDisk = {
			cells: [
				{ cell_type: 'raw', id: 'r1', metadata: {}, source: ['---\n', 'title: Post\n', '---\n'] },
				{ cell_type: 'code', id: 'c1', metadata: {}, source: ['a = 1'], outputs: [], execution_count: null }
			],
			metadata: {},
			nbformat: 4,
			nbformat_minor: 5
		};
		const once = serialize(deserialize(onDisk));
		const raw = once.cells[0] as unknown as Record<string, unknown>;
		expect(raw.cell_type).toBe('raw');
		expect(raw.source).toEqual(['---\n', 'title: Post\n', '---\n']);
		expect('outputs' in raw).toBe(false);
		expect('execution_count' in raw).toBe(false);
		// A code cell still carries both, so the omission is the raw arm and not a
		// blanket drop.
		expect('outputs' in (once.cells[1] as object)).toBe(true);
		expect('execution_count' in (once.cells[1] as object)).toBe(true);
		// Second pass byte-identical: clean-on-save stays idempotent for raw.
		expect(stringify(serialize(deserialize(once)))).toBe(stringify(once));
	});

	// nbformat defines `format` on a raw cell and Jupyter's "Raw NBConvert Format"
	// toolbar writes `raw_mimetype`; both tell nbconvert which output formats the
	// cell belongs to, so dropping them silently repurposes the cell. They are the
	// cell's own content, not runtime state, so a raw-cell-ONLY widening keeps
	// them. Every other cell's foreign metadata is still dropped - the
	// deny-by-default policy the zero-git-diff clean rests on is untouched.
	it('keeps raw_mimetype/format on a RAW cell, and still drops foreign metadata elsewhere', () => {
		const onDisk = {
			cells: [
				{
					cell_type: 'raw',
					id: 'r1',
					metadata: { raw_mimetype: 'text/restructuredtext', format: 'text/markdown', bogus: 1 },
					source: ['.. note::\n']
				},
				{
					cell_type: 'code',
					id: 'c1',
					metadata: { raw_mimetype: 'text/x-python', format: 'text/plain', collapsed: true },
					source: ['a = 1'],
					outputs: [],
					execution_count: null
				},
				{ cell_type: 'markdown', id: 'm1', metadata: { format: 'text/markdown' }, source: ['# hi'] }
			],
			metadata: {},
			nbformat: 4,
			nbformat_minor: 5
		};
		const once = serialize(deserialize(onDisk));
		expect(once.cells[0].metadata).toEqual({ raw_mimetype: 'text/restructuredtext', format: 'text/markdown' });
		// A key nbformat does NOT define on a raw cell is still dropped - the raw
		// allowlist is two keys wide, not "anything goes on a raw cell".
		expect((once.cells[0].metadata as Record<string, unknown>).bogus).toBeUndefined();
		// The very same keys on a code / markdown cell are dropped as before.
		expect(once.cells[1].metadata).toEqual({});
		expect(once.cells[2].metadata).toEqual({});
		// And the round trip stays idempotent with them present.
		expect(stringify(serialize(deserialize(once)))).toBe(stringify(once));
	});

	it("never writes a run's outputs onto a raw cell's disk form", () => {
		// The in-memory doc keeps `outputs: []` for shape uniformity and `setOutputs`
		// will write into it, but `serialize`'s `=== 'code'` gate is what protects
		// the file. Pin that gate.
		const nb = makeRawNotebook('raw-outputs.ipynb');
		const [rawId] = nbmod.listCells(nb).map((c) => c.id);
		nbmod.setOutputs(rawId, [{ output_type: 'stream', name: 'stdout', text: ['boom\n'] }], nb);
		const written = JSON.parse(readFileSync(nb, 'utf8'));
		expect(written.cells[0].cell_type).toBe('raw');
		expect('outputs' in written.cells[0]).toBe(false);
		expect('execution_count' in written.cells[0]).toBe(false);
	});
});

describe('authoring', () => {
	it('creates a raw cell that carries no import-binding stamp', () => {
		const nb = makeRawNotebook('raw-new.ipynb');
		const created = nbmod.addCell(null, 'raw', nb, null, 'import os\n');
		const cell = nbmod.listCells(nb).find((c) => c.id === created.id)!;
		expect(cell.cell_type).toBe('raw');
		expect(cell.source).toBe('import os\n');
		expect(cell.metadata?.cellar).toBeTruthy();
		// A raw cell's source is not Python, so it binds nothing - stamping it as if
		// it might would be a claim nothing verified.
		expect(cell.metadata?.cellar?.importBindings).toBeUndefined();
	});

	it('drops the imports role, the export flag and hide_input on conversion to raw', () => {
		const nb = makeRawNotebook('raw-convert.ipynb');
		const codeId = nbmod.listCells(nb)[1].id;
		nbmod.setCellRole(codeId, 'imports', nb);
		nbmod.setCellExport(codeId, true, nb);
		nbmod.setHideInput(codeId, true, nb);
		nbmod.setOutputs(codeId, [{ output_type: 'stream', name: 'stdout', text: ['x\n'] }], nb);

		nbmod.setCellType(codeId, 'raw', nb);
		const asRaw = nbmod.listCells(nb).find((c) => c.id === codeId)!;
		expect(asRaw.cell_type).toBe('raw');
		expect(asRaw.metadata?.cellar?.role).toBeUndefined();
		expect(asRaw.metadata?.cellar?.export).toBeUndefined();
		expect(asRaw.metadata?.cellar?.hide_input).toBeUndefined();
		expect(asRaw.outputs).toEqual([]);

		// Converting back yields a plain Python cell - no leftover language tag.
		nbmod.setCellType(codeId, 'code', nb);
		const back = nbmod.listCells(nb).find((c) => c.id === codeId)!;
		expect(back.cell_type).toBe('code');
		expect(back.metadata?.cellar?.language).toBeUndefined();
	});
});

describe('checkpoints', () => {
	// The pre-existing defect this fixes: `checkpoints.ts` snapshots through
	// `structuredClone(listCells(nb))`, which PRESERVES `cell_type: 'raw'` - only
	// the RESTORE coerced it, reading every non-markdown type as code. So a user
	// who restored a checkpoint of a Quarto notebook lost the frontmatter cell's
	// type and the notebook stopped working for the tool that reads it.
	it('preserves a raw cell through a restore', () => {
		const nb = makeRawNotebook('raw-checkpoint.ipynb');
		const before = nbmod.listCells(nb);
		expect(before[0].cell_type).toBe('raw');

		const snap = ckmod.createCheckpoint(nb, { trigger: 'manual' });
		expect(snap).toBeTruthy();

		// Mutate the notebook so the restore has real work to do.
		nbmod.setCellType(before[0].id, 'code', nb);
		expect(nbmod.listCells(nb)[0].cell_type).toBe('code');

		ckmod.restoreCheckpoint(nb, snap!.id);
		const after = nbmod.listCells(nb);
		expect(after[0].cell_type).toBe('raw');
		expect(after[0].source).toBe(FRONTMATTER + '\n');
		// And it survives to disk as raw, with no outputs key.
		const written = JSON.parse(readFileSync(nb, 'utf8'));
		expect(written.cells[0].cell_type).toBe('raw');
		expect('outputs' in written.cells[0]).toBe(false);
	});
});
