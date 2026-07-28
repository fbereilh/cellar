/**
 * What a SPLIT cell's lower half inherits, both as the pure rule and through the
 * REAL notebook write the split performs.
 *
 * The bug: `splitActiveCell` created the lower half from the source alone, so
 * splitting a SQL cell (`metadata.cellar.language = 'sql'`) left the upper half
 * SQL and minted the lower half as a plain PYTHON cell - which then compiles
 * through the Python path instead of `sqlToPython`, silently. `hide_input` and
 * `output_scrolled` went the same way.
 *
 * The other half of the rule matters just as much: a `cellar` key is not
 * inheritable merely because it is durable, so the imports role and the nbdev
 * export flag are deliberately NOT carried over.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitInheritedCellar } from '../../src/lib/splitCell';

let WS: string;
let nbmod: typeof import('../../src/lib/server/notebook');

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-split-cell-'));
	process.env.CELLAR_WORKSPACE = WS;
	nbmod = await import('../../src/lib/server/notebook');
});

describe('splitInheritedCellar - the pure rule', () => {
	it('carries the keys that say how the cell is READ and DISPLAYED', () => {
		expect(
			splitInheritedCellar({ language: 'sql', hide_input: true, output_scrolled: false, hidden_from_agent: true })
		).toEqual({ language: 'sql', hide_input: true, output_scrolled: false, hidden_from_agent: true });
	});

	it('does NOT carry the imports role or the export flag', () => {
		// One imports cell per notebook, and the upper half keeps it. The export flag is
		// a designation the user made about the ORIGINAL cell - inheriting it would
		// silently double what the `.py` module exports.
		expect(splitInheritedCellar({ language: 'sql', role: 'imports', export: true })).toEqual({ language: 'sql' });
	});

	it('carries no runtime stamp, so the new half never claims to have run', () => {
		const seed = splitInheritedCellar({
			lastRun: { at: 1, session: 1, status: 'ok', actor: 'user', durationMs: 3 },
			editedAt: 5,
			importBindings: { os: { spec: 'import os', at: 1, sinceAt: 1 } }
		});
		expect(seed).toBeUndefined();
	});

	it('is undefined when nothing carries over, so a plain Python split sends no metadata', () => {
		expect(splitInheritedCellar({ role: 'imports' })).toBeUndefined();
		expect(splitInheritedCellar(undefined)).toBeUndefined();
	});
});

describe('the split write - the lower half as the DOCUMENT ends up holding it', () => {
	/** Exactly what `splitActiveCell` does to the document: edit the upper half, add the lower. */
	function split(nb: string, id: string, at: number) {
		const cell = nbmod.listCells(nb).find((c) => c.id === id)!;
		nbmod.setSource(id, cell.source.slice(0, at), nb);
		return nbmod.addCell(id, cell.cell_type, nb, null, cell.source.slice(at), splitInheritedCellar(cell.metadata?.cellar));
	}

	it('keeps a split SQL cell SQL, and leaves the role and the export flag with the original', () => {
		const nb = join(WS, 'split-sql.ipynb');
		writeFileSync(
			nb,
			JSON.stringify({
				cells: [
					{
						cell_type: 'code',
						source: ['select 1\n', 'select 2'],
						metadata: { cellar: { language: 'sql', hide_input: true, output_scrolled: false, role: 'imports', export: true } },
						outputs: [],
						execution_count: null,
						id: 'sqlcell'
					}
				],
				metadata: {},
				nbformat: 4,
				nbformat_minor: 5
			})
		);
		const lower = split(nb, 'sqlcell', 'select 1\n'.length);
		const cells = nbmod.listCells(nb);
		expect(cells.map((c) => c.source)).toEqual(['select 1\n', 'select 2']);

		const lowerCellar = cells.find((c) => c.id === lower.id)?.metadata?.cellar ?? {};
		expect(lowerCellar.language).toBe('sql');
		expect(lowerCellar.hide_input).toBe(true);
		expect(lowerCellar.output_scrolled).toBe(false);
		expect(lowerCellar.role).toBeUndefined();
		expect(lowerCellar.export).toBeUndefined();

		// …and the original keeps everything it had.
		const upperCellar = cells.find((c) => c.id === 'sqlcell')?.metadata?.cellar ?? {};
		expect(upperCellar.language).toBe('sql');
		expect(upperCellar.role).toBe('imports');
		expect(upperCellar.export).toBe(true);
	});

	it('keeps a cell HIDDEN FROM THE AGENT hidden on both sides of the split', () => {
		// Failing toward the user's choice: the lower half holds the second half of the
		// code they hid, so not inheriting the flag would DISCLOSE it.
		const nb = join(WS, 'split-hidden.ipynb');
		writeFileSync(
			nb,
			JSON.stringify({
				cells: [
					{
						cell_type: 'code',
						source: ['a = 1\n', 'b = 2'],
						metadata: { cellar: { hidden_from_agent: true } },
						outputs: [],
						execution_count: null,
						id: 'hiddencell'
					}
				],
				metadata: {},
				nbformat: 4,
				nbformat_minor: 5
			})
		);
		const lower = split(nb, 'hiddencell', 'a = 1\n'.length);
		expect(nbmod.listCells(nb).find((c) => c.id === lower.id)?.metadata?.cellar?.hidden_from_agent).toBe(true);
	});
});
