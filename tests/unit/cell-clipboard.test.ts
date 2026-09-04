/**
 * What cut / copy / paste / undo carry, as the pure rule and through the REAL
 * document write a paste and an undo perform.
 *
 * The bug: the clipboard entry named three fields (`cell_type`, `source`,
 * `output_scrolled`), so an ordinary copy/paste silently DOWNGRADED a cell - a
 * SQL cell came back as plain Python (wrong grammar, wrong run path, its `-- >>`
 * result binding gone), and the nbdev `export` mark, the report-view `hide_input`
 * choice, the imports `role` and `hidden_from_agent` were dropped. The UNDO
 * record already carried the namespace whole, so the two paths disagreed about
 * what a cell IS - cutting a SQL cell and pressing `z` restored SQL, while
 * pasting the same cell produced Python. Bulk cut/copy amplified it to N cells at
 * once.
 *
 * The shape that fixes it is one snapshot for both paths carrying the namespace
 * WHOLE - an allowlist here is what has to be kept in step with `CellarNamespace`
 * by hand, and not keeping it in step is exactly how this shipped. The allowlist
 * that remains is `seedCellar`'s, on the server, where it also defends the
 * document; these tests drive the two together.
 *
 * The e2e (`tests/e2e/clipboard-cell-metadata.spec.ts`) covers the KEYSTROKES.
 * This file is what CI and the no-mistakes gate actually run, so the rule and its
 * wiring are pinned here too - `LiveNotebook.svelte` cannot be mounted under
 * vitest (no SvelteKit plugin), hence the source guards at the end.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cellClipboard, clipboardCellFrom, clipboardCellType, type ClipboardCell } from '../../src/lib/cellClipboard';
import type { CellarNamespace } from '../../src/lib/server/types';

let WS: string;
let nbmod: typeof import('../../src/lib/server/notebook');

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-clipboard-'));
	process.env.CELLAR_WORKSPACE = WS;
	nbmod = await import('../../src/lib/server/notebook');
});

const SOURCE = '-- >> sales_df\nselect 1';

describe('clipboardCellFrom - the ONE snapshot both paths take', () => {
	it('carries the whole cellar namespace, not a named subset', () => {
		const cellar: CellarNamespace = {
			language: 'sql',
			role: 'imports',
			export: true,
			hide_input: true,
			output_scrolled: false,
			hidden_from_agent: true
		};
		const entry = clipboardCellFrom({ cell_type: 'code', metadata: { cellar } }, SOURCE);
		expect(entry).toEqual({ cell_type: 'code', source: SOURCE, cellar });
	});

	it('carries a key nobody has taught it about, which is the point of the shape', () => {
		// The allowlist is `seedCellar`'s, on the server. If this file grew one of its
		// own, the NEXT `cellar` key added would be dropped here in silence - which is
		// precisely how `language`, `role`, `export`, `hide_input` and
		// `hidden_from_agent` came to be dropped by a copy.
		const entry = clipboardCellFrom(
			{ cell_type: 'code', metadata: { cellar: { some_future_key: 7 } as CellarNamespace } },
			'x'
		);
		expect(entry.cellar).toEqual({ some_future_key: 7 });
	});

	it('takes the LIVE source it is handed, never the model source the autosave lags', () => {
		const entry = clipboardCellFrom({ cell_type: 'code', metadata: {} }, 'typed a moment ago');
		expect(entry.source).toBe('typed a moment ago');
		expect(entry.cellar).toBeUndefined();
	});

	it('copies the namespace, so a later edit to the cell cannot reach the entry', () => {
		const cellar: CellarNamespace = { language: 'sql' };
		const entry = clipboardCellFrom({ cell_type: 'code', metadata: { cellar } }, SOURCE);
		cellar.language = 'mojo';
		expect(entry.cellar?.language).toBe('sql');
	});
});

describe('clipboardCellType - the LOGICAL type an entry describes', () => {
	const of = (cell_type: ClipboardCell['cell_type'], cellar?: CellarNamespace) =>
		clipboardCellType({ cell_type, source: '', cellar });

	it('reads a tagged code cell as its language, and an untagged one as code', () => {
		expect(of('code', { language: 'sql' })).toBe('sql');
		expect(of('code', { language: 'chat' })).toBe('chat');
		expect(of('code', { language: 'mojo' })).toBe('mojo');
		expect(of('code')).toBe('code');
	});

	it('reads the nbformat types straight through', () => {
		expect(of('markdown')).toBe('markdown');
		expect(of('raw')).toBe('raw');
	});
});

describe('the clipboard store', () => {
	it('hands back a copy deep enough that a paste cannot mutate it', () => {
		cellClipboard.copy([clipboardCellFrom({ cell_type: 'code', metadata: { cellar: { language: 'sql' } } }, SOURCE)]);
		const first = cellClipboard.read();
		first[0].cellar!.language = 'mojo';
		first[0].source = 'clobbered';
		const second = cellClipboard.read();
		expect(second[0].cellar?.language).toBe('sql');
		expect(second[0].source).toBe(SOURCE);
	});

	it('holds one entry per selected cell, in the order it was given them', () => {
		cellClipboard.copy([
			clipboardCellFrom({ cell_type: 'code', metadata: { cellar: { language: 'sql' } } }, 'a'),
			clipboardCellFrom({ cell_type: 'markdown', metadata: {} }, 'b')
		]);
		expect(cellClipboard.read().map((c) => [c.cell_type, c.source, c.cellar?.language])).toEqual([
			['code', 'a', 'sql'],
			['markdown', 'b', undefined]
		]);
	});
});

describe('the paste/undo write - what the DOCUMENT ends up holding', () => {
	/** Exactly what a paste (and an undo) does: add a cell seeded from the entry. */
	function paste(nb: string, afterId: string | null, entry: ClipboardCell) {
		return nbmod.addCell(afterId, entry.cell_type, nb, null, entry.source, entry.cellar);
	}

	function fixture(name: string, cells: unknown[]): string {
		const nb = join(WS, name);
		writeFileSync(nb, JSON.stringify({ cells, metadata: {}, nbformat: 4, nbformat_minor: 5 }));
		return nb;
	}

	const code = (id: string, source: string, cellar?: CellarNamespace) => ({
		id,
		cell_type: 'code',
		source: [source],
		metadata: cellar ? { cellar } : {},
		outputs: [],
		execution_count: null
	});

	it('pastes a SQL cell as a SQL cell, with its export mark and view choices', () => {
		const nb = fixture('paste-sql.ipynb', [
			code('sqlcell', SOURCE, { language: 'sql', export: true, hide_input: true, output_scrolled: false, hidden_from_agent: true })
		]);
		const original = nbmod.listCells(nb)[0];
		const created = paste(nb, 'sqlcell', clipboardCellFrom(original, original.source));

		const pasted = nbmod.listCells(nb).find((c) => c.id === created.id)!;
		expect(pasted.source).toBe(SOURCE);
		// `toMatchObject`, not `toEqual`: `newCell` seeds its own defaults
		// (`extract`/`visible`) beside whatever the paste carried.
		expect(pasted.metadata?.cellar).toMatchObject({
			language: 'sql',
			export: true,
			hide_input: true,
			output_scrolled: false,
			hidden_from_agent: true
		});
		// …and it is a real SQL cell on DISK, so a reload keeps it one.
		const onDisk = JSON.parse(readFileSync(nb, 'utf8'));
		expect(onDisk.cells[1].metadata.cellar.language).toBe('sql');
	});

	it('lets the SERVER decide the imports role: a copy beside the original does not claim it, a cut one does', () => {
		const nb = fixture('paste-role.ipynb', [code('imports', 'import os', { role: 'imports' }), code('other', 'x = 1')]);
		const entry = clipboardCellFrom(nbmod.listCells(nb)[0], 'import os');

		// COPY: the original still holds the role, and it is one per notebook.
		const twin = paste(nb, 'other', entry);
		expect(nbmod.listCells(nb).find((c) => c.id === twin.id)?.metadata?.cellar?.role).toBeUndefined();
		expect(nbmod.listCells(nb).filter((c) => c.metadata?.cellar?.role === 'imports')).toHaveLength(1);

		// CUT (or undo of one): the original is gone, so the pasted cell IS the imports cell.
		nbmod.deleteCells(['imports'], nb);
		const restored = paste(nb, 'other', entry);
		expect(nbmod.listCells(nb).find((c) => c.id === restored.id)?.metadata?.cellar?.role).toBe('imports');
	});

	it('cannot forge a run stamp: the runtime-only records are stripped server-side', () => {
		const nb = fixture('paste-runtime.ipynb', [code('src', 'x = 1')]);
		const created = paste(nb, 'src', {
			cell_type: 'code',
			source: 'x = 1',
			cellar: {
				language: 'sql',
				lastRun: { at: 1, session: 99, status: 'ok', actor: 'user', durationMs: 3 },
				editedAt: 5,
				importBindings: { os: { spec: 'import os', at: 1, sinceAt: 1 } }
			} as CellarNamespace
		});
		const cellar = nbmod.listCells(nb).find((c) => c.id === created.id)?.metadata?.cellar ?? {};
		expect(cellar.language).toBe('sql');
		expect(cellar.lastRun).toBeUndefined();
		expect(cellar.editedAt).toBeUndefined();
		expect(cellar.importBindings).toBeUndefined();
	});

	it('does not write an undeclared key into the user notebook', () => {
		// The namespace survives clean-on-save WHOLE, so the entry may carry anything
		// but only `seedCellar`'s enumerated durable keys may land.
		const nb = fixture('paste-unknown.ipynb', [code('src', 'x = 1')]);
		const created = paste(nb, 'src', {
			cell_type: 'code',
			source: 'x = 1',
			cellar: { language: 'sql', not_a_cellar_key: 'nope' } as CellarNamespace
		});
		const cellar = nbmod.listCells(nb).find((c) => c.id === created.id)?.metadata?.cellar ?? {};
		expect(cellar.language).toBe('sql');
		expect(cellar.not_a_cellar_key).toBeUndefined();
	});
});

/**
 * The wiring, source-guarded: vitest runs without the SvelteKit plugin so
 * `LiveNotebook.svelte` cannot be mounted, and the e2e that drives the keystrokes
 * runs in neither CI nor the no-mistakes gate. Each of these is one expression
 * wide, which is how the clipboard and the undo stack drifted apart in the first
 * place.
 */
describe('LiveNotebook wiring', () => {
	const src = readFileSync(new URL('../../src/lib/LiveNotebook.svelte', import.meta.url), 'utf8');

	it('takes BOTH snapshots through the one shared rule', () => {
		expect(src).toMatch(/function snapshotCell\([^)]*\): ClipboardCell \{\s*return clipboardCellFrom\(/);
		// The undo record is the clipboard entry plus an index - never a second shape.
		expect(src).toMatch(/interface DeletedCell extends ClipboardCell \{/);
		expect(src).toMatch(/return \{ index, \.\.\.snapshotCell\(cell\) \};/);
	});

	it('pastes the entry itself, with no re-projection that could drop a field', () => {
		expect(src).not.toContain('pasteSpec');
		expect(src).toContain('await insertCellAt(index, entry)');
	});

	it('refuses a `.py` paste on the LOGICAL type, through the shared rule', () => {
		// `cell_type === 'raw'` reads a tagged chat/mojo cell as plain `code`, so the
		// server would throw where every other surface gives a named notice.
		expect(src).toContain('entries.map(clipboardCellType).find((t) => !offersCellType(t, isPy))');
		expect(src).not.toMatch(/entries\.some\(\(e\) => e\.cell_type === 'raw'\)/);
	});
});
