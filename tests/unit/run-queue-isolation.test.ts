/**
 * Per-kernel run queue isolation (kernel-per-notebook, Phase 1).
 *
 * The run queue is sharded per notebook: each notebook's kernel serializes its
 * own cells, but DIFFERENT notebooks run in parallel. These tests exercise the
 * pure queue logic — no kernel needed — proving a busy notebook never queues
 * another, that clearing/cancelling one notebook's queue leaves the other's
 * intact, and that the snapshots (`queueStateFor` per notebook, `queueStateAll`
 * across all) report the sharded state correctly.
 */
import { describe, it, expect } from 'vitest';
import {
	enqueueRun,
	queueStateFor,
	queueStateAll,
	queuePosition,
	clearRunQueue,
	cancelRun,
	RunCancelled,
	type RunTicket
} from '../../src/lib/server/run-queue';

const A = '/ws/a.ipynb';
const B = '/ws/b.ipynb';

/** Narrow a ticket to its fresh (non-duplicate) form. */
function fresh(t: RunTicket) {
	if (t.duplicate) throw new Error('expected a fresh ticket, got a duplicate');
	return t;
}

describe('per-kernel run queue isolation', () => {
	it('runs two notebooks in parallel: a busy notebook never queues another', () => {
		const a = fresh(enqueueRun({ nb: A, cellId: 'a1', source: 'x=1' }));
		// A is busy, but B's kernel is free — B must NOT wait behind A.
		const b = fresh(enqueueRun({ nb: B, cellId: 'b1', source: 'y=2' }));
		expect(a.queued).toBe(false);
		expect(b.queued).toBe(false);
		expect(queueStateFor(A).running?.cellId).toBe('a1');
		expect(queueStateFor(B).running?.cellId).toBe('b1');
		a.done();
		b.done();
	});

	it('serializes within a notebook (FIFO) but not across notebooks', () => {
		const a1 = fresh(enqueueRun({ nb: A, cellId: 'a1' }));
		const a2 = fresh(enqueueRun({ nb: A, cellId: 'a2' })); // waits behind a1
		const b1 = fresh(enqueueRun({ nb: B, cellId: 'b1' })); // own kernel, runs now
		expect(a2.queued).toBe(true);
		expect(queuePosition(A, 'a2')).toBe(1);
		expect(b1.queued).toBe(false);
		expect(queuePosition(B, 'b1')).toBe(0);

		// a1 finishes → a2 becomes A's active run; B is untouched throughout.
		a1.done();
		expect(queueStateFor(A).running?.cellId).toBe('a2');
		expect(queuePosition(A, 'a2')).toBe(0);
		a2.done();
		b1.done();
	});

	it('queueStateFor reports only that notebook; queueStateAll aggregates', () => {
		const a1 = fresh(enqueueRun({ nb: A, cellId: 'a1', actor: 'user' }));
		const a2 = fresh(enqueueRun({ nb: A, cellId: 'a2', actor: 'agent' }));
		const b1 = fresh(enqueueRun({ nb: B, cellId: 'b1', actor: 'user' }));

		const sa = queueStateFor(A);
		expect(sa.running?.cellId).toBe('a1');
		expect(sa.queue.map((e) => e.cellId)).toEqual(['a2']);
		// B's queue does not leak into A's slice.
		expect(sa.queue.every((e) => e.nb === A)).toBe(true);

		const all = queueStateAll();
		// Two kernels are running (one per notebook) — the aggregate lists both.
		expect(new Set(all.running.map((r) => r.cellId))).toEqual(new Set(['a1', 'b1']));
		expect(all.queue.map((e) => e.cellId)).toEqual(['a2']);

		a1.done();
		a2.done();
		b1.done();
	});

	it('clearRunQueue(A) drops only A pending; B keeps its queue and active run', async () => {
		const a1 = fresh(enqueueRun({ nb: A, cellId: 'a1' }));
		const a2 = fresh(enqueueRun({ nb: A, cellId: 'a2' }));
		const b1 = fresh(enqueueRun({ nb: B, cellId: 'b1' }));
		const b2 = fresh(enqueueRun({ nb: B, cellId: 'b2' }));

		const dropped = clearRunQueue(A, 'kernel_restart');
		expect(dropped).toBe(1); // only a2 was pending
		await expect(a2.wait()).rejects.toBeInstanceOf(RunCancelled);

		// B is entirely untouched: its active run and its pending run both survive.
		expect(queueStateFor(B).running?.cellId).toBe('b1');
		expect(queuePosition(B, 'b2')).toBe(1);
		// A's active run is not cancelled by a queue clear — the kernel op ends it.
		expect(queueStateFor(A).running?.cellId).toBe('a1');

		a1.done();
		b1.done();
		b2.done();
	});

	it('cancelRun targets one cell in one notebook only', async () => {
		const a1 = fresh(enqueueRun({ nb: A, cellId: 'a1' }));
		const a2 = fresh(enqueueRun({ nb: A, cellId: 'a2' }));
		const b1 = fresh(enqueueRun({ nb: B, cellId: 'b1' }));
		// A cell id can repeat across notebooks; cancelling A/a2 must not touch B.
		expect(cancelRun(A, 'a2')).toBe(true);
		await expect(a2.wait()).rejects.toBeInstanceOf(RunCancelled);
		expect(cancelRun(B, 'a2')).toBe(false); // no such pending cell in B
		expect(queueStateFor(B).running?.cellId).toBe('b1');
		a1.done();
		b1.done();
	});

	it('dedupes within a notebook and refreshes the pending source', () => {
		const a1 = fresh(enqueueRun({ nb: A, cellId: 'a1' }));
		const a2 = fresh(enqueueRun({ nb: A, cellId: 'a2', source: 'first' }));
		// Re-submitting a queued cell is a duplicate, but its source is refreshed.
		const dup = enqueueRun({ nb: A, cellId: 'a2', source: 'second' });
		expect(dup.duplicate).toBe(true);
		if (!dup.duplicate) throw new Error('unreachable');
		expect(dup.position).toBe(1);
		// The same cell id in another notebook is NOT a duplicate — separate queue.
		const b = fresh(enqueueRun({ nb: B, cellId: 'a2' }));
		expect(b.duplicate).toBe(false);

		a1.done();
		expect(a2.source()).toBe('second'); // ran what was last submitted
		a2.done();
		b.done();
	});

	it('an idle notebook has an empty snapshot and drops out of the aggregate', () => {
		// After the prior tests fully drained, both notebooks are idle again.
		expect(queueStateFor(A)).toEqual({ running: null, queue: [] });
		expect(queueStateFor(B)).toEqual({ running: null, queue: [] });
		const all = queueStateAll();
		expect(all.running).toEqual([]);
		expect(all.queue).toEqual([]);
	});
});
