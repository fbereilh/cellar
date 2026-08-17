/**
 * The live "running 12s" elapsed clock on an executing cell.
 *
 * Four things have to hold and each fails silently on its own:
 *
 *  1. FORMAT — the live clock and the settled `ran … · 1.2s` badge that replaces
 *     it must speak one duration vocabulary, and the live one must not jitter.
 *  2. TICKER — a second, FAST shared ticker, ref-counted so it runs only while
 *     something is executing. A per-cell `setInterval` (200 cells → 200 timers) or
 *     a timer left armed at rest are both the regression this exists to stop.
 *  3. ORIGIN — the run start is stamped by the SERVER, once, at the instant
 *     `run:end` measures `durationMs` from, and reaches a client that missed
 *     `run:start` through the queue snapshot. A start derived from when a tab
 *     noticed `running` flip would restart at 0s on every reconnect.
 *  4. PAIRING — `runningId` and `runningSince` are one fact; a site that moved one
 *     without the other would time the wrong run.
 *
 * Vitest runs without the SvelteKit plugin (see vitest.config.ts), so the two
 * component-level rules get SOURCE guards; what the human SEES is proved by
 * `tests/e2e/run-elapsed.spec.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatElapsed, formatDuration } from '../../src/lib/relativeTime';
import { createNowTicker, RUN_TICK_MS, NOW_TICK_MS } from '../../src/lib/nowTicker';

describe('formatElapsed — the live clock', () => {
	it('reads whole seconds under a minute, so a 1s tick never shows a jittering decimal', () => {
		// `formatDuration` renders this range as `1.2s`/`820ms`, written for a value
		// that has stopped moving. Ticking once a second it would read `1.0s`, `2.0s`
		// — a decimal that is always `.0`, and a width that changes with the digits.
		expect(formatElapsed(1_000)).toBe('1s');
		expect(formatElapsed(1_999)).toBe('1s'); // floors: never rounds a second up early
		expect(formatElapsed(12_000)).toBe('12s');
		expect(formatElapsed(59_999)).toBe('59s');
		expect(formatElapsed(12_400)).not.toContain('.');
	});

	it('hands over to the settled badge in the SAME units, so nothing jumps at run end', () => {
		// The last live tick and the badge that replaces it describe one run.
		expect(formatElapsed(12_300)).toBe('12s');
		expect(formatDuration(12_300)).toBe('12.3s'); // same unit, gains precision
		expect(formatElapsed(65_000)).toBe('1m 5s');
		expect(formatDuration(65_000)).toBe('1m 5s'); // identical past a minute
	});

	it('DELEGATES the minutes tier rather than respelling it', () => {
		// One owner for `Xm Ys`. Sweep the boundary and every whole second of the
		// first few minutes: each must be exactly what formatDuration says.
		for (let s = 60; s < 400; s++) {
			expect(formatElapsed(s * 1000)).toBe(formatDuration(s * 1000));
		}
	});

	it('never renders the impossible `1m 60s` that a raw delegation would', () => {
		// formatDuration rounds its seconds remainder, so 119.7s spells `1m 60s`.
		// formatElapsed floors to a whole second first, which a round cannot lift.
		expect(formatDuration(119_700)).toBe('1m 60s'); // the pre-existing edge, unchanged
		for (let ms = 59_000; ms <= 121_000; ms += 137) {
			expect(formatElapsed(ms)).not.toMatch(/\b60s$/);
		}
		expect(formatElapsed(119_700)).toBe('1m 59s');
	});

	it('reads 0s for a start that is not behind us, never a negative or a blank', () => {
		// Reachable exactly once: the first frame after a run starts, reading a
		// `runNowMs()` frozen since the last run released the ticker. That IS a
		// just-started run, so `0s` is both the safe and the correct answer.
		expect(formatElapsed(-4_000)).toBe('0s');
		expect(formatElapsed(0)).toBe('0s');
		expect(formatElapsed(999)).toBe('0s');
		expect(formatElapsed(null)).toBe('0s');
		expect(formatElapsed(undefined)).toBe('0s');
		expect(formatElapsed(Number.NaN)).toBe('0s');
	});
});

describe('the fast ticker (RUN_TICK_MS)', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('is a SECOND cadence, not a faster global one', () => {
		// Dropping NOW_TICK_MS to 1s would wake every idle `ran 2m ago` badge in the
		// notebook 15x more often to redraw text that has not changed.
		expect(RUN_TICK_MS).toBe(1000);
		expect(NOW_TICK_MS).toBe(15000);
	});

	it('starts when a run starts and stops when the last one ends — nothing ticks at rest', () => {
		let ticks = 0;
		const ticker = createNowTicker(() => ticks++, RUN_TICK_MS);

		// At rest: no timer, whatever else the app is doing.
		expect(ticker.running).toBe(false);
		expect(vi.getTimerCount()).toBe(0);

		const cellA = ticker.subscribe();
		expect(ticker.running).toBe(true);
		expect(ticks).toBe(1); // immediate, so the first render is never stale

		vi.advanceTimersByTime(3000);
		expect(ticks).toBe(4); // ~once a second

		// A second notebook starts running too: still ONE interval.
		const cellB = ticker.subscribe();
		expect(vi.getTimerCount()).toBe(1);
		expect(ticker.count).toBe(2);

		cellA();
		expect(ticker.running).toBe(true); // B is still executing
		cellB();
		expect(ticker.running).toBe(false); // last run out → timer gone
		expect(vi.getTimerCount()).toBe(0);

		const at = ticks;
		vi.advanceTimersByTime(60_000);
		expect(ticks).toBe(at); // and it really stops: no leaked wakeups at rest
	});

	it('re-arms exactly one interval for the next run', () => {
		const ticker = createNowTicker(() => {}, RUN_TICK_MS);
		ticker.subscribe()();
		const again = ticker.subscribe();
		expect(ticker.running).toBe(true);
		expect(vi.getTimerCount()).toBe(1);
		again();
	});

	it('drives a reactive now the elapsed reads from', async () => {
		// `now.svelte.ts` under the runes shim: `$state` is the identity, so the
		// module-level reassignment is a plain one and the getter is exercised for
		// real. Reactivity itself is a browser concern (see the e2e).
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		const now = await import('../../src/lib/now.svelte');
		expect(now.isRunTickerRunning()).toBe(false);

		const started = now.runNowMs();
		const release = now.subscribeRunNow();
		expect(now.isRunTickerRunning()).toBe(true);
		expect(now.runTickerSubscriberCount()).toBe(1);

		vi.advanceTimersByTime(12_000);
		expect(now.runNowMs() - started).toBe(12_000);
		expect(formatElapsed(now.runNowMs() - started)).toBe('12s');

		release();
		expect(now.isRunTickerRunning()).toBe(false);
		expect(now.runTickerSubscriberCount()).toBe(0);
	});

	it('the fast and the slow ticker are independent instances', async () => {
		const now = await import('../../src/lib/now.svelte');
		const release = now.subscribeRunNow();
		// A run does not arm the badge ticker, and vice versa.
		expect(now.isRunTickerRunning()).toBe(true);
		expect(now.isNowTickerRunning()).toBe(false);
		release();

		const slow = now.subscribeNow();
		expect(now.isNowTickerRunning()).toBe(true);
		expect(now.isRunTickerRunning()).toBe(false);
		slow();
	});
});

// ---- The origin: one server-stamped start, reaching a client that missed it ----

describe('the run start on the queue snapshot', () => {
	async function freshQueue() {
		vi.resetModules();
		return import('../../src/lib/server/run-queue');
	}

	it('is absent until the run reports in, then carries the run\'s OWN instant', async () => {
		const { enqueueRun, queueStateFor, noteRunStarted } = await freshQueue();
		const nb = '/ws/a.ipynb';
		const ticket = enqueueRun({ nb, cellId: 'c1', actor: 'user', source: 'x' });
		expect(ticket.duplicate).toBe(false);

		// The kernel is claimed but the run has not begun executing: "running, start
		// unknown" is the honest reading — a consumer shows no clock, never a 0s one
		// measured from an origin nobody stamped.
		expect(queueStateFor(nb).running).toMatchObject({ cellId: 'c1' });
		expect(queueStateFor(nb).running?.startedAt).toBeUndefined();

		noteRunStarted(nb, 'c1', 1_700_000_000_000);
		expect(queueStateFor(nb).running?.startedAt).toBe(1_700_000_000_000);
	});

	it('reaches ALL THREE snapshot shapes, so no surface is left without it', async () => {
		const { enqueueRun, queueStateFor, queueStateAll, queuesByNotebook, noteRunStarted } = await freshQueue();
		const nb = '/ws/a.ipynb';
		enqueueRun({ nb, cellId: 'c1', actor: 'agent', source: 'x' });
		noteRunStarted(nb, 'c1', 42_000);

		expect(queueStateFor(nb).running?.startedAt).toBe(42_000);
		expect(queueStateAll().running[0]?.startedAt).toBe(42_000);
		expect(queuesByNotebook()[nb].running?.startedAt).toBe(42_000);
	});

	it('BROADCASTS, so a notebook mounting mid-run is seeded with the start', async () => {
		// A tab already holding the SSE stream is served the last `queue:changed`
		// replayed. Without this broadcast that snapshot is the pre-start one, and a
		// notebook mounted mid-run would show a running cell whose clock never
		// appears until the queue happens to change again (possibly never).
		vi.resetModules();
		const seen: unknown[] = [];
		vi.doMock('../../src/lib/server/events', () => ({
			publishGlobal: (ev: unknown) => seen.push(ev),
			publish: () => {}
		}));
		const { enqueueRun, noteRunStarted } = await import('../../src/lib/server/run-queue');
		const nb = '/ws/a.ipynb';
		enqueueRun({ nb, cellId: 'c1', actor: 'user', source: 'x' });
		const beforeStart = seen.length;

		noteRunStarted(nb, 'c1', 99_000);
		expect(seen.length).toBe(beforeStart + 1);
		expect(seen.at(-1)).toMatchObject({
			type: 'queue:changed',
			running: [{ nb, cellId: 'c1', startedAt: 99_000 }]
		});

		// It costs ONE publish per RUN, not per report: a repeat of the same instant
		// changes nothing and must not fan another snapshot out to every tab.
		noteRunStarted(nb, 'c1', 99_000);
		expect(seen.length).toBe(beforeStart + 1);
		vi.doUnmock('../../src/lib/server/events');
		vi.resetModules();
	});

	it('is a silent no-op for a cell that does not hold the kernel', async () => {
		// Run bookkeeping may never be what breaks a run.
		const { enqueueRun, queueStateFor, noteRunStarted } = await freshQueue();
		const nb = '/ws/a.ipynb';
		enqueueRun({ nb, cellId: 'c1', actor: 'user', source: 'x' });
		enqueueRun({ nb, cellId: 'c2', actor: 'user', source: 'y' }); // waiting behind c1

		expect(() => noteRunStarted(nb, 'c2', 1)).not.toThrow(); // queued, not running
		expect(() => noteRunStarted('/ws/other.ipynb', 'c1', 1)).not.toThrow(); // no such queue
		expect(queueStateFor(nb).running?.startedAt).toBeUndefined();
	});

	it('does not survive its run: the next cell starts with its own clock', async () => {
		// The entry is dropped wholesale at release, so a fresh run can never inherit
		// the previous one's origin and open at some minutes-old elapsed.
		const { enqueueRun, queueStateFor, noteRunStarted } = await freshQueue();
		const nb = '/ws/a.ipynb';
		const first = enqueueRun({ nb, cellId: 'c1', actor: 'user', source: 'x' });
		const second = enqueueRun({ nb, cellId: 'c2', actor: 'user', source: 'y' });
		noteRunStarted(nb, 'c1', 1_000);

		if (!first.duplicate) first.done(); // c2 takes the kernel
		expect(queueStateFor(nb).running?.cellId).toBe('c2');
		expect(queueStateFor(nb).running?.startedAt).toBeUndefined();

		noteRunStarted(nb, 'c2', 5_000);
		expect(queueStateFor(nb).running?.startedAt).toBe(5_000);
		if (!second.duplicate) second.done();
	});
});

describe('the run reports its own start (run.ts)', () => {
	// Drives the REAL `executeCellRun` with only the Jupyter-facing `execute` and the
	// document writes faked, so the three channels a client can learn a run's start
	// from are OBSERVED rather than grepped for: the SSE `run:start`, this run's own
	// NDJSON `run:start` frame, and the queue snapshot (`noteRunStarted`). All three
	// must carry ONE instant, and the closing `run:end` must measure `durationMs`
	// from that same instant — which is what makes the live clock hand over to the
	// settled badge without ever going backwards.
	const NB = '/ws/run-origin.ipynb';
	const CELL = 'c1';
	const T0 = 1_700_000_000_000;

	type RunMod = typeof import('../../src/lib/server/run');
	type QueueMod = typeof import('../../src/lib/server/run-queue');
	type EventsMod = typeof import('../../src/lib/server/events');
	type ExecuteImpl = (nb: string, code: string, onEvent: (ev: Record<string, unknown>) => void) => Promise<unknown>;

	let clock = T0;

	beforeEach(() => {
		clock = T0;
		// A controllable wall clock: deterministic and indifferent to HOW MANY times
		// the run reads it, so `durationMs` can be asserted exactly rather than within
		// a window. Fake timers are deliberately avoided — the run arms a real flush
		// interval it clears itself.
		vi.spyOn(Date, 'now').mockImplementation(() => clock);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.doUnmock('../../src/lib/server/kernel');
		vi.doUnmock('../../src/lib/server/notebook');
		vi.resetModules();
	});

	async function load(execute: ExecuteImpl): Promise<{ run: RunMod; queue: QueueMod; events: EventsMod }> {
		vi.resetModules();
		vi.doMock('../../src/lib/server/kernel', () => ({ execute }));
		vi.doMock('../../src/lib/server/notebook', () => ({
			setOutputs: () => {},
			setOutputsLive: () => {},
			setLastRun: () => {},
			clearOutputsLive: () => {},
			getCell: () => ({ cell_type: 'code', metadata: {} })
		}));
		const [run, queue, events] = await Promise.all([
			import('../../src/lib/server/run'),
			import('../../src/lib/server/run-queue'),
			import('../../src/lib/server/events')
		]);
		return { run, queue, events };
	}

	it('hands ONE server-stamped instant to all three channels, and measures durationMs from it', async () => {
		let queue!: QueueMod;
		let snapshotDuringRun: { cellId: string; startedAt?: number } | null = null;

		const mods = await load(async (nb, _code, onEvent) => {
			onEvent({ type: 'kernel', session: 9 });
			// Read the live queue while the run holds the kernel: this is exactly what a
			// tab connecting (or a notebook mounting) mid-run is seeded with.
			snapshotDuringRun = queue.queueStateFor(nb).running;
			clock = T0 + 5_000; // the run takes 5s of wall clock
			return { status: 'ok' };
		});
		queue = mods.queue;

		const published: Record<string, unknown>[] = [];
		const off = mods.events.subscribe((ev) => published.push(ev as unknown as Record<string, unknown>));
		const ndjson: Record<string, unknown>[] = [];

		const ticket = mods.queue.enqueueRun({ nb: NB, cellId: CELL, actor: 'user', source: 'x = 1' });
		if (ticket.duplicate) throw new Error('unreachable: fresh ticket expected');
		await ticket.wait();
		try {
			await mods.run.executeCellRun({
				nb: NB,
				cellId: CELL,
				actor: 'user',
				source: 'x = 1',
				onEvent: (ev) => ndjson.push(ev as unknown as Record<string, unknown>)
			});
		} finally {
			ticket.done();
			off();
		}

		// Channel 1 — the SSE event every other tab learns the run from.
		const sseStart = published.find((e) => e.type === 'run:start');
		expect(sseStart, 'the run must publish run:start').toBeTruthy();
		expect(sseStart!.at).toBe(T0);

		// Channel 2 — this run's own NDJSON frame (its initiating tab suppresses the
		// SSE echo by originId, so this is the only way it learns its run started).
		const ndjsonStart = ndjson.find((e) => e.type === 'run:start');
		expect(ndjsonStart, 'the run must emit run:start on its own stream').toBeTruthy();
		expect(ndjsonStart!.at).toBe(T0);

		// Channel 3 — the queue snapshot, read live AND as broadcast.
		expect(snapshotDuringRun).toMatchObject({ cellId: CELL, startedAt: T0 });
		const broadcastStarts = published
			.filter((e) => e.type === 'queue:changed')
			.flatMap((e) => (e.running as { cellId: string; startedAt?: number }[]) ?? [])
			.filter((r) => r.cellId === CELL && r.startedAt != null);
		expect(broadcastStarts.length, 'the start must be broadcast so a late joiner is seeded').toBeGreaterThan(0);
		for (const r of broadcastStarts) expect(r.startedAt).toBe(T0);

		// And the settled duration is measured from that SAME instant, so the last
		// live tick and the badge that replaces it can never disagree.
		const ndjsonEnd = ndjson.find((e) => e.type === 'run:end');
		const sseEnd = published.find((e) => e.type === 'run:end');
		expect(ndjsonEnd).toMatchObject({ at: T0, durationMs: 5_000 });
		expect(sseEnd).toMatchObject({ at: T0, durationMs: 5_000 });
	});

	it('never lets a client see a start LATER than the duration it hands over to', async () => {
		// The failure this rules out: an origin minted anywhere other than the run
		// itself (the queue at dequeue, or a client noticing `running` flip) sits after
		// the run's own start, so the live clock would read higher than the settled
		// badge and the handover would go BACKWARDS.
		const mods = await load(async () => {
			clock = T0 + 1_234;
			return { status: 'ok' };
		});

		const ndjson: Record<string, unknown>[] = [];
		const ticket = mods.queue.enqueueRun({ nb: NB, cellId: CELL, actor: 'agent', source: 'y = 2' });
		if (ticket.duplicate) throw new Error('unreachable: fresh ticket expected');
		await ticket.wait();
		try {
			await mods.run.executeCellRun({
				nb: NB,
				cellId: CELL,
				actor: 'agent',
				source: 'y = 2',
				onEvent: (ev) => ndjson.push(ev as unknown as Record<string, unknown>)
			});
		} finally {
			ticket.done();
		}

		const start = ndjson.find((e) => e.type === 'run:start') as { at: number };
		const end = ndjson.find((e) => e.type === 'run:end') as { at: number; durationMs: number };
		// The elapsed a client would render at the last tick before run:end.
		const liveAtHandover = clock - start.at;
		expect(end.durationMs).toBeGreaterThanOrEqual(liveAtHandover);
		expect(end.at).toBe(start.at);
	});
});

// ---- The two component rules (source guards; behavior lives in the e2e) -------

describe('LiveNotebook — runningId and runningSince move together', () => {
	const SRC = readFileSync(fileURLToPath(new URL('../../src/lib/LiveNotebook.svelte', import.meta.url)), 'utf8');

	it('writes them ONLY through markRunning/clearRunning', () => {
		// A site that moved `runningId` alone would leave the clock timing the run
		// BEFORE it — the reason this is a pair rather than two independent states.
		// Mirrors the `wipeVariablesLocally()` guard in shell-refresh-handlers.
		// Statement-level assignments only: not the `$state` declaration, not the
		// `runningId={runningId}` prop, not a comparison.
		const writes = [...SRC.matchAll(/(?<!let )\brunningId\s*=\s*(?![={])/g)];
		expect(writes.length, 'every runningId write must be inside markRunning/clearRunning').toBe(2);
		for (const m of writes) {
			const decl = SRC.lastIndexOf('function ', m.index);
			const name = SRC.slice(decl).match(/^function (\w+)/)?.[1];
			expect(['markRunning', 'clearRunning']).toContain(name);
		}
		// The declaration itself is the `$state` initializer, not an assignment.
		expect(SRC).toContain('let runningId = $state<string | null>(null)');
		expect(SRC).toContain('let runningSince = $state<number | null>(null)');
		// And both helpers really move both fields.
		for (const fn of ['markRunning', 'clearRunning']) {
			const at = SRC.indexOf(`function ${fn}(`);
			const body = SRC.slice(at, SRC.indexOf('\n\t}', at));
			expect(body, `${fn} must set runningId`).toMatch(/runningId =/);
			expect(body, `${fn} must set runningSince`).toMatch(/runningSince =/);
		}
	});

	it('takes the start from the SERVER on every path a run can be learned from', () => {
		// The three: this tab's own NDJSON stream, another actor's run over SSE, and
		// the queue snapshot a mid-run mount/reconnect is seeded from. Deriving it
		// from the `running` transition instead would restart the clock at 0s for a
		// query that has been going ten minutes.
		expect(SRC).toContain("markRunning(id, typeof ev.at === 'number' ? ev.at : null)"); // own run
		expect(SRC).toContain('markRunning(ev.cellId, ev.at ?? null)'); // foreign run over SSE
		expect(SRC).toContain('markRunning(running.cellId, running.startedAt ?? null)'); // snapshot
		expect(SRC).not.toMatch(/markRunning\([^)]*Date\.now\(\)/); // never a client clock
	});
});

describe('Cell — the elapsed is gated on actually running', () => {
	const SRC = readFileSync(fileURLToPath(new URL('../../src/lib/Cell.svelte', import.meta.url)), 'utf8');

	it('subscribes to the FAST ticker only while the indicator is shown, and releases it', () => {
		// Gated on `showRunning` (the 180ms-delayed reveal), so a cell fast enough
		// never to flash the indicator never arms the timer either; returning the
		// release as the effect cleanup is what stops it when the run ends.
		expect(SRC).toContain('subscribeRunNow');
		expect(SRC).toMatch(/if \(!showRunning \|\| runStartedAt == null\) return;\s*\n\s*return subscribeRunNow\(\);/);
		// Never a per-cell interval for this: every cell mounts this component.
		const elapsedBlock = SRC.slice(SRC.indexOf('const elapsedText'), SRC.indexOf('const elapsedText') + 200);
		expect(elapsedBlock).not.toContain('setInterval');
	});

	it('reads the elapsed under the SAME condition it subscribes under', () => {
		// Read without a live subscription `runNowMs()` is frozen; keeping the two
		// conditions identical is what bounds that to a single `0s` frame.
		expect(SRC).toContain('showRunning && runStartedAt != null ? formatElapsed(runNowMs() - runStartedAt)');
	});

	it('reserves the digits\' width so a tick never reflows the toolbar', () => {
		// The slot is `justify-end`, so `9s` → `10s` → `1m 5s` would nudge every
		// control to its left once a second without a reserved, tabular width.
		const at = SRC.indexOf('data-testid="running-elapsed"');
		expect(at).toBeGreaterThan(-1);
		const tag = SRC.slice(SRC.lastIndexOf('<span', at), at);
		expect(tag).toContain('tabular-nums');
		expect(tag).toMatch(/min-w-\[[\d.]+rem\]/);
	});

	it('only ever shows it on a cell the notebook says is running', () => {
		// `Notebook.svelte` hands the start to the running cell alone, so a cell
		// cannot render a clock without the running affordance it belongs to.
		const NB = readFileSync(fileURLToPath(new URL('../../src/lib/Notebook.svelte', import.meta.url)), 'utf8');
		expect(NB).toContain('runStartedAt={runningId === cell.id ? runningSince : null}');
	});
});
