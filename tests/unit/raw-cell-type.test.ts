/**
 * `raw` as a first-class nbformat cell type - the MODEL and its PERSISTENCE, on
 * the REAL modules against a scratch workspace.
 *
 * An nbformat `raw` cell is verbatim text Cellar never executes and never
 * renders: Quarto/nbdev frontmatter, nbconvert directives.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
