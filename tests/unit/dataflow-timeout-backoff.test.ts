/**
 * Dataflow probe: a persistently-timing-out batch BACKS OFF and CONVERGES.
 *
 * The staleness probe caches nothing on a failed run (so a timeout can never serve a
 * false `fresh`). On its own that is a CPU trap: a notebook whose analysis genuinely
 * exceeds `PROBE_TIMEOUT_MS` times out, caches nothing, and every next debounced
 * staleness pass (load / run-end / edit / structural change) resubmits the IDENTICAL
 * batch - deterministic, so it burns another ~timeout of CPU and is SIGKILLed again,
 * forever, pinning a core. These tests prove the backoff added to `dataflow.ts`:
 *   - an identical timed-out batch is NOT re-spawned within the backoff window,
 *   - concurrent identical passes fold into ONE in-flight probe (single-flight),
 *   - a CHANGED batch (a real edit) DOES re-probe (backoff resets on content change),
 *   - the window eventually elapses and re-probes (backoff is not permanent),
 *   - a timed-out notebook is reported conservative-STALE, never a false `fresh`,
 *   - a non-timeout failure (missing interpreter) is NOT backed off - it stays retryable,
 *   - a non-timeout failure degrades to empty dataflow (a ran cell reads `fresh`), so the
 *     conservative-STALE path is scoped to genuine timeouts only.
 *
 * The Python subprocess is MOCKED so the timeout path is forced deterministically
 * (no real interpreter, no 10s waits): a fake child that never answers is SIGKILLed
 * by the real per-probe timer, which we drive down to a few ms via the env knob.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { CellView } from '../../src/lib/server/types';

// Mutable state shared with the hoisted mock factories.
const h = vi.hoisted(() => ({
	count: 0,
	behavior: 'timeout' as 'timeout' | 'ok' | 'error',
	cells: [] as unknown[],
	sid: null as number | null
}));

function makeFakeChild(behavior: 'timeout' | 'ok' | 'error') {
	const child = new EventEmitter() as EventEmitter & {
		stdout: EventEmitter;
		stderr: EventEmitter;
		stdin: { on: () => void; end: () => void };
		kill: (sig?: string) => boolean;
	};
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.stdin = { on: () => {}, end: () => {} };
	// A SIGKILL (from the probe's timeout timer) closes the child with no sentinel line.
	child.kill = () => {
		queueMicrotask(() => child.emit('close', 0));
		return true;
	};
	if (behavior === 'ok') {
		// Answer immediately with a valid (empty) sentinel result, before the timer fires.
		queueMicrotask(() => {
			child.stdout.emit('data', Buffer.from('__CELLAR_DF__' + JSON.stringify({ ok: true, cells: {} }) + '\n'));
			child.emit('close', 0);
		});
	} else if (behavior === 'error') {
		// The interpreter cannot be spawned (ENOENT): the 'error' event fires fast, with
		// no timeout involved - this failure is cheap and must stay retryable (no backoff).
		queueMicrotask(() => child.emit('error', new Error('ENOENT')));
	}
	// 'timeout': never answer; the real per-probe timer SIGKILLs it.
	return child;
}

vi.mock('node:child_process', () => ({
	spawn: () => {
		h.count++;
		return makeFakeChild(h.behavior);
	}
}));
vi.mock('../../src/lib/server/databricks', () => ({ projectPython: () => 'python3' }));
vi.mock('../../src/lib/server/notebook', () => ({ listCells: () => h.cells }));
vi.mock('../../src/lib/server/kernel', () => ({ currentSessionId: () => h.sid }));

// Imported AFTER the mocks are registered (vitest hoists vi.mock above imports).
import { analyzeDataflow, getNotebookStaleness, __resetDataflowState } from '../../src/lib/server/dataflow';

const codeCell = (id: string, source: string): CellView =>
	({ id, cell_type: 'code', source, metadata: {}, outputs: [] }) as unknown as CellView;

/** A code cell stamped as having run in kernel session `sid` (so staleness evaluates it). */
const ranCell = (id: string, source: string, sid: number): CellView =>
	({
		id,
		cell_type: 'code',
		source,
		metadata: { cellar: { lastRun: { at: 1000, session: sid, status: 'ok' } } },
		outputs: []
	}) as unknown as CellView;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('dataflow probe timeout backoff', () => {
	beforeEach(() => {
		h.count = 0;
		h.behavior = 'timeout';
		h.cells = [];
		h.sid = null;
		__resetDataflowState();
		// A few-ms probe timeout so the fake child is SIGKILLed fast; a long backoff base
		// so within-test identical passes fall inside the window.
		process.env.CELLAR_DATAFLOW_PROBE_TIMEOUT_MS = '30';
		process.env.CELLAR_DATAFLOW_BACKOFF_BASE_MS = '60000';
		process.env.CELLAR_DATAFLOW_BACKOFF_MAX_MS = '120000';
	});
	afterEach(() => {
		delete process.env.CELLAR_DATAFLOW_PROBE_TIMEOUT_MS;
		delete process.env.CELLAR_DATAFLOW_BACKOFF_BASE_MS;
		delete process.env.CELLAR_DATAFLOW_BACKOFF_MAX_MS;
	});

	it('does NOT re-spawn an identical timed-out batch within the backoff window', async () => {
		const cells = [codeCell('a', 'x = 1'), codeCell('b', 'y = x + 1')];

		await analyzeDataflow(cells); // times out ⇒ one spawn, records backoff
		expect(h.count).toBe(1);

		// Every subsequent identical pass (a run-end, a re-load, a no-op structural pass)
		// must be served from the backoff WITHOUT spawning - the convergence guarantee.
		await analyzeDataflow(cells);
		await analyzeDataflow(cells);
		await analyzeDataflow(cells);
		expect(h.count).toBe(1);
	});

	it('folds concurrent identical passes into a single in-flight probe', async () => {
		const cells = [codeCell('a', 'x = 1')];
		// Fire two passes before either resolves: single-flight must share one subprocess.
		await Promise.all([analyzeDataflow(cells), analyzeDataflow(cells)]);
		expect(h.count).toBe(1);
	});

	it('re-probes when the batch changes (a real edit resets the backoff)', async () => {
		await analyzeDataflow([codeCell('a', 'x = 1')]); // times out ⇒ backed off
		expect(h.count).toBe(1);

		// The user edits the cell: a different source ⇒ a different batch signature ⇒ the
		// backoff does not apply, so analysis runs again (this is the "an edit re-probes").
		await analyzeDataflow([codeCell('a', 'x = 2  # edited')]);
		expect(h.count).toBe(2);
	});

	it('eventually re-probes after the backoff window elapses (not permanent)', async () => {
		process.env.CELLAR_DATAFLOW_BACKOFF_BASE_MS = '10';
		process.env.CELLAR_DATAFLOW_BACKOFF_MAX_MS = '10';
		const cells = [codeCell('a', 'x = 1')];

		await analyzeDataflow(cells); // times out ⇒ 10ms window
		expect(h.count).toBe(1);
		await analyzeDataflow(cells); // still inside the window ⇒ no spawn
		expect(h.count).toBe(1);

		await delay(80); // window (10ms) has now elapsed
		await analyzeDataflow(cells); // window passed ⇒ probe again (transient-failure recovery)
		expect(h.count).toBe(2);
	});

	it('reports a timed-out notebook as conservative-STALE, never a false fresh', async () => {
		const sid = 7;
		h.sid = sid;
		h.cells = [ranCell('a', 'df = load()', sid), ranCell('b', 'summary = df.describe()', sid)];

		const { cells: stale } = await getNotebookStaleness('/nb.ipynb');

		// Both cells ran this session but their dataflow could not be computed (probe timed
		// out), so neither may be certified fresh - the invariant this whole file protects.
		for (const id of ['a', 'b']) {
			expect(stale[id].state).toBe('stale');
			expect(stale[id].state).not.toBe('fresh');
			expect(stale[id].reason).toMatch(/timed out/i);
		}
	});

	it('does NOT back off a non-timeout failure (missing interpreter stays retryable)', async () => {
		h.behavior = 'error'; // spawn fails fast via the 'error' event, no timeout, no CPU burn
		const cells = [codeCell('a', 'x = 1')];

		await analyzeDataflow(cells);
		await analyzeDataflow(cells);
		await analyzeDataflow(cells);
		// A cheap, fast failure must retry every pass (the venv may come up); it is the
		// slow, CPU-burning TIMEOUT - not any failure - that the backoff exists to tame.
		expect(h.count).toBe(3);
	});

	it('does NOT mark a ran cell stale on a non-timeout failure (empty dataflow reads fresh)', async () => {
		// A missing interpreter is NOT a timeout, so it degrades to empty dataflow exactly
		// as before the backoff existed: a ran-this-session cell with no dependencies stays
		// `fresh`, never the conservative-stale the timeout path invents. This is what scopes
		// the "unavailable ⇒ stale" broadening to genuine timeouts only.
		h.behavior = 'error';
		const sid = 9;
		h.sid = sid;
		h.cells = [ranCell('a', 'x = 1', sid)];

		const { cells: stale } = await getNotebookStaleness('/nb.ipynb');

		expect(stale['a'].state).toBe('fresh');
		expect(stale['a'].state).not.toBe('stale');
	});
});
