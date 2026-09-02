/**
 * Checkpoint OUTPUT storage: the half that decides whether "undo" after an agent
 * destroyed a notebook's results actually gives them back.
 *
 * Outputs used to be stored INLINE in the single `.cellar/checkpoints.json` index,
 * which is held in memory and re-serialized on every write - so a per-snapshot
 * `MAX_SNAPSHOT_BYTES` (2 MB) cap had to drop them, and it dropped them for exactly
 * the output-heavy notebook `clear_outputs` exists to shed weight from. They now
 * live one file per checkpoint at `.cellar/checkpoints/<id>.json`, with no size cap
 * at all; the bound is a store-wide budget whose eviction is NEWEST-WINS.
 *
 * What is pinned here is what a wrong guess would silently break: that a restore
 * really returns the bytes (not merely "some output"), that the index stays free of
 * them (the reason the cap could go), that the budget sheds the OLDEST and never the
 * snapshot just taken, that every path which drops a checkpoint drops its file with
 * it, that a store written by an older Cellar still restores, and that a sidecar
 * which cannot be READ degrades to sources without ever claiming otherwise.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Cp = typeof import('../../src/lib/server/checkpoints');
type Nb = typeof import('../../src/lib/server/notebook');

/**
 * A fresh workspace AND a fresh module graph. The store's cache is module-level and
 * loads once, so a test that hand-writes a `checkpoints.json` (the legacy-shape case)
 * or expects the one-shot orphan sweep to run must not share a module instance with
 * the tests around it.
 */
async function freshWorkspace(): Promise<{ ws: string; cp: Cp; nb: Nb }> {
	const ws = mkdtempSync(join(tmpdir(), 'cellar-cp-out-'));
	process.env.CELLAR_WORKSPACE = ws;
	vi.resetModules();
	const nb = await import('../../src/lib/server/notebook');
	const cp = await import('../../src/lib/server/checkpoints');
	return { ws, cp, nb };
}

const out = (text: string) => [{ output_type: 'stream' as const, name: 'stdout' as const, text }];
const sidecarDir = (ws: string) => join(ws, '.cellar', 'checkpoints');
const sidecars = (ws: string) => (existsSync(sidecarDir(ws)) ? readdirSync(sidecarDir(ws)).filter((f) => f.endsWith('.json')) : []);
const outputText = (c: { outputs?: unknown[] }) => (c.outputs?.[0] as { text?: string } | undefined)?.text;

/**
 * The index write is debounced (`WRITE_DEBOUNCE_MS`, 250ms) on an unref'd timer, so a
 * test that reads `checkpoints.json` off disk - or re-imports the module to make it
 * load from disk - has to let that land. Waiting beats exporting a test-only flush
 * from the module under test.
 */
const waitForFlush = () => new Promise((r) => setTimeout(r, 400));

/** A notebook whose single cell carries `text` as its saved output. */
function notebookWithOutput(nb: Nb, name: string, text: string): { target: string; cellId: string } {
	const target = nb.resolveNotebookPath(name);
	nb.createNotebook(name);
	const cell = nb.addCell(null, 'code', target, null, 'plot()');
	nb.setOutputs(cell.id, out(text), target);
	return { target, cellId: cell.id };
}

describe('outputs survive a checkpoint whatever their size', () => {
	it('restores them BYTE-FOR-BYTE from a snapshot far past the old 2 MB cap', async () => {
		const { ws, cp, nb } = await freshWorkspace();
		const big = 'y'.repeat(3_000_000); // 1.5x the old cap on its own
		const { target, cellId } = notebookWithOutput(nb, 'big.ipynb', big);

		const snap = cp.createCheckpoint(target, { trigger: 'agent' });
		// The whole point of the fix: no truncation flag, because nothing was dropped.
		expect(snap.outputsTruncated).toBe(false);

		nb.clearOutputs(cellId, target);
		expect(outputText(nb.listCells(target)[1]!)).toBeUndefined();

		expect(cp.restoreCheckpoint(target, snap.id).ok).toBe(true);
		// The exact bytes, not merely "an output came back".
		expect(outputText(nb.listCells(target).find((c) => c.id === cellId)!)).toBe(big);
		expect(sidecars(ws).length).toBeGreaterThan(0);
	});

	it('keeps the outputs OUT of the index file - the reason the size cap could go', async () => {
		const { ws, cp, nb } = await freshWorkspace();
		const marker = 'UNIQUE_OUTPUT_MARKER_'.repeat(1000);
		const { target } = notebookWithOutput(nb, 'index.ipynb', marker);
		cp.createCheckpoint(target, { trigger: 'agent' });
		await waitForFlush();

		const index = readFileSync(join(ws, '.cellar', 'checkpoints.json'), 'utf8');
		// The index is what is held in memory and rewritten on EVERY change, so a
		// snapshot's outputs sitting in it is what forced the cap in the first place.
		expect(index).not.toContain('UNIQUE_OUTPUT_MARKER_');
		expect(index).toContain('"outputsStored": true');
		// ...and they are in the sidecar instead.
		const files = sidecars(ws);
		expect(files).toHaveLength(1);
		expect(readFileSync(join(sidecarDir(ws), files[0]), 'utf8')).toContain('UNIQUE_OUTPUT_MARKER_');
	});
});

describe('the store-wide budget sheds the OLDEST sidecars, never the newest', () => {
	it('protects the snapshot just taken and flags the ones it shed', async () => {
		const { ws, cp, nb } = await freshWorkspace();
		// Small enough that the second snapshot's outputs alone blow it.
		process.env.CELLAR_CHECKPOINT_OUTPUT_BUDGET_BYTES = '50000';
		try {
			const { target, cellId } = notebookWithOutput(nb, 'budget.ipynb', 'a'.repeat(40_000));
			const first = cp.createCheckpoint(target, { trigger: 'agent' });
			expect(first.outputsTruncated).toBe(false);

			// A second snapshot of the same weight cannot coexist with the first.
			nb.setOutputs(cellId, out('b'.repeat(40_000)), target);
			const second = cp.createCheckpoint(target, { trigger: 'agent' });

			// NEWEST-WINS: the snapshot just taken keeps its outputs...
			expect(second.outputsTruncated).toBe(false);
			// ...and the older one was shed, flagged, and had its file deleted.
			const olderNow = cp.listCheckpoints(target).find((c) => c.id === first.id)!;
			expect(olderNow.outputsTruncated).toBe(true);
			expect(olderNow.outputsError).toMatch(/budget/);
			expect(sidecars(ws)).toHaveLength(1);

			// A shed checkpoint still restores its SOURCES - it is degraded history, not
			// a broken snapshot.
			const r = cp.restoreCheckpoint(target, first.id);
			expect(r.ok).toBe(true);
			expect(r.restored?.outputsTruncated).toBe(true);
			expect(nb.listCells(target).some((c) => c.source === 'plot()')).toBe(true);
		} finally {
			delete process.env.CELLAR_CHECKPOINT_OUTPUT_BUDGET_BYTES;
		}
	});

	it('keeps the newest even when it ALONE exceeds the whole budget', async () => {
		// The discriminating case for the newest-wins guard. While older sidecars can be
		// shed to get under budget the loop stops as soon as it is, so it never reaches
		// the newest and a missing guard would go unnoticed. Make ONE snapshot bigger
		// than the entire budget and the guard is the only thing standing between the
		// destructive action the user just took and an undo that gives back nothing.
		const { ws, cp, nb } = await freshWorkspace();
		process.env.CELLAR_CHECKPOINT_OUTPUT_BUDGET_BYTES = '1000';
		try {
			const big = 'q'.repeat(50_000); // 50x the budget
			const { target, cellId } = notebookWithOutput(nb, 'over-budget.ipynb', big);
			const snap = cp.createCheckpoint(target, { trigger: 'agent' });

			expect(snap.outputsTruncated).toBe(false);
			expect(sidecars(ws)).toHaveLength(1);

			nb.clearOutputs(cellId, target);
			expect(cp.restoreCheckpoint(target, snap.id).ok).toBe(true);
			expect(outputText(nb.listCells(target).find((c) => c.id === cellId)!)).toBe(big);
		} finally {
			delete process.env.CELLAR_CHECKPOINT_OUTPUT_BUDGET_BYTES;
		}
	});
});

describe('a dropped checkpoint takes its sidecar with it', () => {
	it('deletes the file when FIFO eviction drops the oldest snapshot', async () => {
		const { ws, cp, nb } = await freshWorkspace();
		const { target, cellId } = notebookWithOutput(nb, 'fifo.ipynb', 'o');
		// MAX_PER_NOTEBOOK is 25; go past it so the earliest entries are evicted.
		for (let i = 0; i < 30; i++) {
			nb.setOutputs(cellId, out(`o${i}`), target);
			cp.createCheckpoint(target, { trigger: 'agent' });
		}
		expect(cp.listCheckpoints(target)).toHaveLength(25);
		// One file per surviving checkpoint - never one per checkpoint ever taken.
		expect(sidecars(ws)).toHaveLength(25);
	});

	it('deletes the file when a refused destructive action discards its checkpoint', async () => {
		const { ws, cp, nb } = await freshWorkspace();
		const { target } = notebookWithOutput(nb, 'discard.ipynb', 'o');
		const snap = cp.createCheckpoint(target, { trigger: 'agent' });
		expect(sidecars(ws)).toHaveLength(1);

		cp.discardCheckpoint(target, snap.id);
		expect(cp.listCheckpoints(target)).toHaveLength(0);
		expect(sidecars(ws)).toHaveLength(0);
	});

	it('sweeps sidecars the index no longer knows about (a crash between the two writes)', async () => {
		const { ws, cp, nb } = await freshWorkspace();
		const { target } = notebookWithOutput(nb, 'orphan.ipynb', 'o');
		cp.createCheckpoint(target, { trigger: 'agent' });
		await waitForFlush();

		// A sidecar whose checkpoint never made it into the index.
		mkdirSync(sidecarDir(ws), { recursive: true });
		writeFileSync(join(sidecarDir(ws), 'deadbeef-orphan.json'), '[[]]');
		expect(sidecars(ws)).toHaveLength(2);

		// The sweep runs once, on the first store load of a process.
		vi.resetModules();
		const cp2 = await import('../../src/lib/server/checkpoints');
		cp2.listCheckpoints(target);
		expect(sidecars(ws)).toHaveLength(1);
	});
});

describe('shapes this module did not write', () => {
	it('restores a store written by an older Cellar, whose outputs are inline', async () => {
		const { ws, cp, nb } = await freshWorkspace();
		const { target, cellId } = notebookWithOutput(nb, 'legacy.ipynb', 'legacy output');
		const cells = nb.listCells(target);
		// Exactly the shape the pre-sidecar writer produced: outputs inline, no flags.
		mkdirSync(join(ws, '.cellar'), { recursive: true });
		writeFileSync(
			join(ws, '.cellar', 'checkpoints.json'),
			JSON.stringify({
				'legacy.ipynb': [
					{ id: 'legacy-id', at: 1, trigger: 'agent', label: 'Before agent action', cellCount: cells.length, cells }
				]
			})
		);

		vi.resetModules();
		const cp2 = await import('../../src/lib/server/checkpoints');
		const nb2 = await import('../../src/lib/server/notebook');
		nb2.clearOutputs(cellId, target);

		expect(cp2.restoreCheckpoint(target, 'legacy-id').ok).toBe(true);
		expect(outputText(nb2.listCells(target).find((c) => c.id === cellId)!)).toBe('legacy output');
		void cp;
	});

	it('degrades to sources - and SAYS so - when a sidecar cannot be read', async () => {
		const { ws, cp, nb } = await freshWorkspace();
		const { target, cellId } = notebookWithOutput(nb, 'unreadable.ipynb', 'gone');
		const snap = cp.createCheckpoint(target, { trigger: 'agent' });
		// The file is deleted out from under the index (a hand-cleaned `.cellar/`).
		rmSync(join(sidecarDir(ws), `${snap.id}.json`));
		nb.setSource(cellId, 'changed()', target);

		const r = cp.restoreCheckpoint(target, snap.id);
		// The restore still happens - sources back beats refusing outright...
		expect(r.ok).toBe(true);
		expect(nb.listCells(target).some((c) => c.source === 'plot()')).toBe(true);
		// ...but it never claims outputs it did not restore, here or on any later read.
		expect(r.restored?.outputsTruncated).toBe(true);
		expect(r.restored?.outputsError).toMatch(/could not be read/);
		expect(cp.listCheckpoints(target).find((c) => c.id === snap.id)?.outputsTruncated).toBe(true);
		void ws;
	});
});
