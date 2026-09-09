import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Auto-checkpoint TIERS. `autoCheckpointBeforeAgentAction` (the RECOVERABLE tier -
 * runs, edits, adds, moves) must snapshot on the FIRST agent action for a notebook
 * and then once every CHECKPOINT_EVERY_N_ACTIONS actions, skipping the ones in
 * between — not once per action as the old time-coalesce effectively did for a
 * steadily-working agent. `checkpointBeforeDestructiveAgentAction` (the DESTRUCTIVE
 * tier - anything that deletes saved outputs) must snapshot EVERY time, because the
 * state it destroys has no recovery but the snapshot, and the two must not share
 * counters.
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

	it('NEVER throttles a destructive action, at any position in the sequence', () => {
		// The throttle is safe only for actions whose state can be produced again (a
		// run's outputs come back by re-running). An action that DELETES saved outputs
		// has no such recovery, so it takes its own snapshot every time - under the
		// single-tier rule four out of five `clear_outputs` calls were preceded by none.
		const path = 'destructive.ipynb';
		nb.createNotebook(path);
		nb.addCell(null, 'code', path, null, 'x = 1');

		// Deliberately NOT the first action for this notebook: the first is the one case
		// the throttle always snapshotted, so it would pass either way.
		expect(cp.autoCheckpointBeforeAgentAction(path)).not.toBeNull(); // action 1
		const before = cp.listCheckpoints(path).length;

		// Positions 2..(N+2) - every one inside a batch the throttle would have skipped.
		for (let i = 0; i < N + 1; i++) {
			expect(cp.checkpointBeforeDestructiveAgentAction(path), `destructive action ${i}`).toBeTruthy();
		}
		expect(cp.listCheckpoints(path).length - before).toBe(N + 1);
	});

	it('leaves the throttle counters alone, in both directions', () => {
		// The two tiers are independent mechanisms over one store. A destructive
		// snapshot must not GRANT the recoverable tier credit (or a run right after a
		// clear would skip a snapshot it was due) and must not SPEND it (or a refused
		// destructive call, whose snapshot is abandoned before it is ever committed,
		// would leave the counters describing a snapshot that does not exist).
		const path = 'tiers.ipynb';
		nb.createNotebook(path);
		nb.addCell(null, 'code', path, null, 'x = 1');

		expect(cp.autoCheckpointBeforeAgentAction(path)).not.toBeNull(); // action 1 of N
		// A pile of destructive actions in the middle of that batch...
		for (let i = 0; i < 10; i++) cp.checkpointBeforeDestructiveAgentAction(path);
		// ...leaves the recoverable tier exactly where it was: the N-1 actions after a
		// snapshot are skipped and the next one is due. If the destructive path had
		// reset the counter, the very next call would be "action 1" again and snapshot;
		// if it had incremented it, the run would come due early.
		for (let i = 2; i <= N; i++) expect(cp.autoCheckpointBeforeAgentAction(path), `action ${i}`).toBeNull();
		expect(cp.autoCheckpointBeforeAgentAction(path), `action ${N + 1}`).not.toBeNull();
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
