/**
 * Staleness reflection of a "wipe variables" (see kernel.ts `wipeKernelVariables`
 * + the /api/kernel/wipe route). A wipe keeps the kernel session alive (no epoch
 * bump), so the ONLY way cells reflect that their values are gone is by clearing
 * the runtime-only `lastRun` stamp of the cells that defined a wiped name. This
 * proves that mechanism end to end:
 *   - `clearLastRunStamps` drops the stamp of the named cells only, emits one
 *     `kernel:variables-wiped` event, and never writes the `.ipynb` (the stamp is
 *     runtime-only, so a wipe produces zero git diff);
 *   - the existing pure staleness rule then reports a data-defining cell `not_run`
 *     and its dependent `stale`, while an imports cell (whose name was preserved)
 *     stays `fresh`.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeStaleness, STALE_STATE, type Dataflow } from '../../src/lib/staleness';
import type { LastRun } from '../../src/lib/server/types';

const published = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../../src/lib/server/events', () => ({
	publish: (e: Record<string, unknown>) => {
		published.push(e);
		return { ...e, seq: published.length };
	},
	publishGlobal: (e: Record<string, unknown>) => e
}));
vi.mock('../../src/lib/server/logs', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));

let WS: string;
let nbmod: typeof import('../../src/lib/server/notebook');

const NB = 'stale.ipynb';
const abs = () => nbmod.resolveNotebookPath(NB);
const SID = 5;
const stamp = (): LastRun => ({ at: 1000, durationMs: 1, actor: 'user', status: 'ok', session: SID });

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-wipe-stale-'));
	process.env.CELLAR_WORKSPACE = WS;
	nbmod = await import('../../src/lib/server/notebook');
	nbmod.createNotebook(NB, null, { focus: false });
});

describe('wipe staleness reflection', () => {
	it('clears only the named cells, emits one event, and leaves the .ipynb byte-identical', async () => {
		const imp = nbmod.addCell(null, 'code', abs(), null, 'import os');
		const a = nbmod.addCell(imp.id, 'code', abs(), null, 'df = 1');
		const b = nbmod.addCell(a.id, 'code', abs(), null, 'print(df)');
		// All three ran this session.
		for (const id of [imp.id, a.id, b.id]) nbmod.setLastRun(id, stamp(), abs());

		const before = readFileSync(abs());
		published.length = 0;

		// The wipe dropped `df` (a data variable); the caller resolves that `a` defined it.
		const cleared = nbmod.clearLastRunStamps([a.id], abs());
		expect(cleared).toBe(1);

		// Only `a` lost its stamp; the imports cell and `b` keep theirs.
		const cells = nbmod.listCells(abs());
		const byId = Object.fromEntries(cells.map((c) => [c.id, c]));
		expect(byId[a.id].metadata?.cellar?.lastRun).toBeUndefined();
		expect(byId[imp.id].metadata?.cellar?.lastRun).toBeTruthy();
		expect(byId[b.id].metadata?.cellar?.lastRun).toBeTruthy();

		// Exactly one refetch event, tagged with this notebook.
		const ev = published.filter((e) => e.type === 'kernel:variables-wiped');
		expect(ev.length).toBe(1);
		expect(ev[0]).toMatchObject({ type: 'kernel:variables-wiped', nb: abs(), cleared: 1 });

		// The stored notebook is untouched (lastRun is runtime-only — zero git diff).
		expect(readFileSync(abs()).equals(before)).toBe(true);

		// Staleness now reflects the wipe: `a` reads not_run, `b` (uses df) is stale,
		// the imports cell (name preserved, stamp intact) stays fresh.
		const dataflow: Dataflow = {
			[imp.id]: { defines: ['os'], uses: [] },
			[a.id]: { defines: ['df'], uses: [] },
			[b.id]: { defines: [], uses: ['df'] }
		};
		const st = computeStaleness(cells, dataflow, SID);
		expect(st[a.id].state).toBe(STALE_STATE.NOT_RUN);
		expect(st[b.id].state).toBe(STALE_STATE.STALE);
		expect(st[b.id].upstream).toContain(a.id);
		expect(st[imp.id].state).toBe(STALE_STATE.FRESH);
	});

	it('clearing an empty id list still emits a (refetch) event and clears nothing', () => {
		published.length = 0;
		const cleared = nbmod.clearLastRunStamps([], abs());
		expect(cleared).toBe(0);
		expect(published.filter((e) => e.type === 'kernel:variables-wiped').length).toBe(1);
	});
});
