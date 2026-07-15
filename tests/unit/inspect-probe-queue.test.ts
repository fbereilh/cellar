/**
 * Perf Tier 3, item 4: `kernel_state` reports busy from the run queue's OWN truth,
 * not only jupyter's lagging idle→busy status — closing the check-then-act window
 * in which an internal probe could be issued into a kernel a real cell run had
 * just claimed (the probe would then block behind that cell in jupyter).
 *
 * A run claims the kernel synchronously the instant it is dequeued (`queue.active`
 * / `queueStateFor(nb).running`), but jupyter's status flip lands a beat later. So
 * even with `kernelStatus() === 'idle'`, an active queue entry must short-circuit
 * `kernelState` to `{ busy: true }` WITHOUT running the probe.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunStreamEvent } from '../../src/lib/server/types';

const h = vi.hoisted(() => ({
	status: 'idle' as 'idle' | 'busy' | 'not_started',
	running: null as null | { nb: string; cellId: string; actor: string },
	execute: vi.fn()
}));

vi.mock('../../src/lib/server/kernel', () => ({
	kernelStatus: () => ({ status: h.status, id: 'k1' }),
	kernelSession: () => ({ session_id: 5 }),
	currentSessionId: () => 5,
	execute: h.execute
}));

vi.mock('../../src/lib/server/notebook', () => ({
	getActiveNotebookPath: () => '/ws/nb.ipynb',
	resolveNotebookPath: (nb?: string | null) => nb ?? '/ws/nb.ipynb'
}));

vi.mock('../../src/lib/server/run-queue', () => ({
	queueStateFor: () => ({ running: h.running, queue: [] })
}));

import { kernelState } from '../../src/lib/server/inspect';

// A probe execute that emits its session + one JSON stdout line (an empty namespace).
function probeExecute(_nb: string, _code: string, onEvent: (e: RunStreamEvent) => void) {
	onEvent({ type: 'kernel', id: 'k1', session: 5 } as RunStreamEvent);
	onEvent({
		type: 'output',
		output: { output_type: 'stream', name: 'stdout', text: JSON.stringify({ imports: [], functions: [], classes: [], variables: [] }) }
	} as RunStreamEvent);
	return Promise.resolve({ status: 'ok' });
}

describe('kernelState — queue-aware busy short-circuit', () => {
	beforeEach(() => {
		h.status = 'idle';
		h.running = null;
		h.execute.mockReset();
		h.execute.mockImplementation(probeExecute);
	});

	it('short-circuits to busy (no probe) when a run holds the kernel, even though jupyter still reads idle', async () => {
		h.status = 'idle'; // jupyter has not flipped to busy yet
		h.running = { nb: '/ws/nb.ipynb', cellId: 'c1', actor: 'user' }; // but the queue says a cell is running

		const state = await kernelState('/ws/nb.ipynb');

		expect(state).toEqual({ started: true, busy: true, session_id: 5 });
		expect(h.execute).not.toHaveBeenCalled(); // the probe was NOT issued into the busy kernel
	});

	it('still reports busy via jupyter status alone (regression guard)', async () => {
		h.status = 'busy';
		h.running = null;
		const state = await kernelState('/ws/nb.ipynb');
		expect(state).toMatchObject({ started: true, busy: true });
		expect(h.execute).not.toHaveBeenCalled();
	});

	it('runs the probe normally when the kernel is idle AND the queue is empty', async () => {
		h.status = 'idle';
		h.running = null;
		const state = await kernelState('/ws/nb.ipynb');
		expect(h.execute).toHaveBeenCalledTimes(1); // capability preserved: the probe still runs
		expect(state).toMatchObject({ started: true, session_id: 5, variables: [] });
	});

	it('returns not-started without touching the queue or the probe', async () => {
		h.status = 'not_started';
		const state = await kernelState('/ws/nb.ipynb');
		expect(state).toEqual({ started: false, session_id: null });
		expect(h.execute).not.toHaveBeenCalled();
	});
});
