import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Auto-checkpoint throttle (count-based). `autoCheckpointBeforeAgentAction` must
 * snapshot on the FIRST agent action for a notebook and then once every
 * CHECKPOINT_EVERY_N_ACTIONS actions, skipping the ones in between — not once per
 * action as the old time-coalesce effectively did for a steadily-working agent.
 *
 * Both modules read their workspace from `CELLAR_WORKSPACE` at call time, so we
 * point them at a scratch dir and address ops by explicit notebook paths (the
 * checkpoint store keys by workspace-relative path, keeping notebooks isolated).
 * Manual "Checkpoint now" must be untouched: it always snapshots.
 */

let WS: string;
let cp: typeof import('../../src/lib/server/checkpoints');
let nb: typeof import('../../src/lib/server/notebook');

// Mirrors the module constant; kept local so a retune there fails this test loudly.
const N = 5;

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-cp-'));
	process.env.CELLAR_WORKSPACE = WS;
	nb = await import('../../src/lib/server/notebook');
	cp = await import('../../src/lib/server/checkpoints');
});

describe('auto-checkpoint throttles by agent-action count', () => {
	it('snapshots on the 1st action then once per N actions', () => {
		const path = 'throttle.ipynb';
		nb.createNotebook(path);
		nb.addCell(null, 'code', path, null, 'x = 1');

		const taken: number[] = []; // action indices (1-based) that actually snapshotted
		const ACTIONS = 12;
		for (let i = 1; i <= ACTIONS; i++) {
			const meta = cp.autoCheckpointBeforeAgentAction(path);
			if (meta) taken.push(i);
		}

		// First action, then every N: 1, 1+N, 1+2N, … within the range.
		expect(taken).toEqual([1, 1 + N, 1 + 2 * N]);
		// ~1 checkpoint per N actions, not ~1 per action.
		expect(taken.length).toBeLessThan(ACTIONS);

		const agentCheckpoints = cp
			.listCheckpoints(path)
			.filter((c) => c.trigger === 'agent');
		expect(agentCheckpoints.length).toBe(taken.length);
	});

	it('keeps notebooks independent (separate counters)', () => {
		const a = 'nb-a.ipynb';
		const b = 'nb-b.ipynb';
		nb.createNotebook(a);
		nb.createNotebook(b);

		// First action on each notebook snapshots regardless of the other's counter.
		expect(cp.autoCheckpointBeforeAgentAction(a)).not.toBeNull();
		expect(cp.autoCheckpointBeforeAgentAction(b)).not.toBeNull();
		// Second action on A is skipped (still inside A's batch of N).
		expect(cp.autoCheckpointBeforeAgentAction(a)).toBeNull();
	});

	it('manual "Checkpoint now" always snapshots', () => {
		const path = 'manual.ipynb';
		nb.createNotebook(path);
		// Two manual checkpoints back to back — never throttled.
		expect(cp.createCheckpoint(path, { trigger: 'manual' })).toBeTruthy();
		expect(cp.createCheckpoint(path, { trigger: 'manual' })).toBeTruthy();
		const manuals = cp.listCheckpoints(path).filter((c) => c.trigger === 'manual');
		expect(manuals.length).toBe(2);
	});

	it('restore returns the notebook to the snapshotted cells', () => {
		const path = 'restore.ipynb';
		nb.createNotebook(path);
		const cell = nb.addCell(null, 'code', path, null, 'original = 1');

		// Snapshot the pre-edit state (first agent action always snapshots).
		const snap = cp.autoCheckpointBeforeAgentAction(path);
		expect(snap).not.toBeNull();

		// Mutate after the checkpoint.
		nb.setSource(cell.id, 'changed = 2', path);
		expect(nb.listCells(path).some((c) => c.source === 'changed = 2')).toBe(true);

		// Restore walks the source back.
		const res = cp.restoreCheckpoint(path, snap!.id);
		expect(res.ok).toBe(true);
		const sources = nb.listCells(path).map((c) => c.source);
		expect(sources).toContain('original = 1');
		expect(sources).not.toContain('changed = 2');
	});
});
