import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * **A probe result is read once stdout has DRAINED, never merely once the process
 * has exited.**
 *
 * `child_process`'s `exit` fires the moment the process ends, with its stdio pipes
 * still open - so the sentinel line the child already wrote can still be sitting
 * unread. Reading `stdout` there turns a perfectly good probe into
 * `the Databricks probe crashed: python exited code=0`, a failure the user cannot
 * act on and that no retry of theirs explains. Which of the two ready events libuv
 * dispatches first is a scheduling detail, so the misreport is load-dependent:
 * invisible on a quiet machine, intermittent on a busy one.
 *
 * That ordering cannot be provoked from JavaScript, so it is pinned here instead:
 * `spawn` is replaced with a synthetic child that emits `exit` BEFORE its stdout -
 * exactly the interleaving the operating system is allowed to produce - and the
 * probe must still return the result.
 *
 * The bound matters as much as the wait. `close` is the honest event, but it may
 * never arrive at all: a grandchild that inherited the pipe holds it open (the
 * `login` op's browser launcher is precisely that shape), so a probe that waited
 * for `close` unconditionally would trade a rare false crash for a hang. The wait
 * is therefore capped, and a child that exits having written nothing is still
 * reported as a crash - a moment later, not never.
 */

const SENTINEL = '__CELLAR_DBX__';

/** How each fake child behaves: what it writes, and when it says it exited. */
type Script = {
	/** stdout chunks, delivered in order. */
	stdout: string[];
	/** stderr chunks. */
	stderr?: string[];
	/** Emit `exit` before any stdout is delivered (the race this file exists for). */
	exitFirst?: boolean;
	/**
	 * How many stdout chunks land BEFORE `exit`; the rest arrive during the drain.
	 * This is the >64 KB listing: the pipe hands over a first read that cuts the
	 * sentinel line mid-JSON, and only the tail carries its terminating newline.
	 */
	chunksBeforeExit?: number;
	/** Never emit `close` - a grandchild is still holding the pipe. */
	holdOpen?: boolean;
	exitCode?: number | null;
	/** Fire `exit` this many ms into the run, instead of immediately. */
	exitAtMs?: number;
	/** Deliver stdout (and `close`) this many ms into the run. Requires `exitAtMs`. */
	stdoutAtMs?: number;
};

/** The plan the next `spawn` should act out; `null` delegates to the real one. */
const script = vi.hoisted(() => ({ current: null as Script | null }));

vi.mock('node:child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:child_process')>();
	const { EventEmitter } = await import('node:events');
	const { PassThrough } = await import('node:stream');
	return {
		...actual,
		spawn: (command: string, args?: unknown, options?: unknown) => {
			const plan = script.current;
			if (!plan) return (actual.spawn as (...a: unknown[]) => unknown)(command, args, options);
			const child = new EventEmitter() as InstanceType<typeof EventEmitter> & Record<string, unknown>;
			const out = new PassThrough();
			const err = new PassThrough();
			child.stdout = out;
			child.stderr = err;
			child.stdin = null;
			child.pid = 4242;
			child.killed = false;
			child.kill = () => {
				child.killed = true;
				return true;
			};
			const code = plan.exitCode === undefined ? 0 : plan.exitCode;
			const writeOut = () => {
				for (const chunk of plan.stdout) out.write(chunk);
				for (const chunk of plan.stderr ?? []) err.write(chunk);
				out.end();
				err.end();
			};
			const finish = () => {
				if (!plan.holdOpen) child.emit('close', code, null);
			};
			// Two microtask hops so the caller's listeners are attached first.
			queueMicrotask(() => {
				if (plan.exitAtMs !== undefined) {
					// A scheduled run on the caller's clock: exit at one instant, output at
					// another, so a test can put the op timeout between the two.
					setTimeout(() => child.emit('exit', code, null), plan.exitAtMs);
					setTimeout(
						() => {
							writeOut();
							finish();
						},
						plan.stdoutAtMs ?? plan.exitAtMs
					);
				} else if (plan.exitFirst) {
					// The OS-legal interleaving: the process is gone, its output is not
					// yet readable. `close` follows only once the pipe drains.
					child.emit('exit', code, null);
					setTimeout(() => {
						writeOut();
						finish();
					}, 5);
				} else if (plan.chunksBeforeExit !== undefined) {
					// A partial first read: the head of an oversized line is already
					// readable when the process ends, its newline is not.
					for (const chunk of plan.stdout.slice(0, plan.chunksBeforeExit)) out.write(chunk);
					child.emit('exit', code, null);
					setTimeout(() => {
						for (const chunk of plan.stdout.slice(plan.chunksBeforeExit)) out.write(chunk);
						for (const chunk of plan.stderr ?? []) err.write(chunk);
						out.end();
						err.end();
						finish();
					}, 5);
				} else {
					writeOut();
					child.emit('exit', code, null);
					finish();
				}
			});
			return child;
		}
	};
});

let dbx: typeof import('../../src/lib/server/databricks');
let home: string;
const saved = new Map<string, string | undefined>();
const REDIRECTED = ['HOME', 'DATABRICKS_CONFIG_FILE', 'CELLAR_WORKSPACE', 'CELLAR_PROJECT_VENV'] as const;

beforeAll(async () => {
	for (const key of REDIRECTED) saved.set(key, process.env[key]);
	home = mkdtempSync(join(tmpdir(), 'cellar-probe-drain-'));
	const cfg = join(home, '.databrickscfg');
	writeFileSync(cfg, ['[pat]', 'host = https://drain.example.com', 'token = dummy-pat', ''].join('\n'));
	// A marker `projectPython()` can stat. It is never executed - `spawn` is faked.
	const marker = join(home, 'fake-python');
	writeFileSync(marker, 'cellar test marker - never executed\n', { mode: 0o644 });
	process.env.HOME = home;
	process.env.DATABRICKS_CONFIG_FILE = cfg;
	process.env.CELLAR_WORKSPACE = home;
	process.env.CELLAR_PROJECT_VENV = marker;
	dbx = await import('../../src/lib/server/databricks');
});

afterAll(() => {
	for (const [key, value] of saved) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(home, { recursive: true, force: true });
});

/** Drive one real probe (through the public `listClusters`) against a scripted child. */
async function runProbe(plan: Script) {
	script.current = plan;
	try {
		return await dbx.listClusters({ profile: 'pat' });
	} finally {
		script.current = null;
	}
}

const clusters = (n: number) =>
	`${SENTINEL}${JSON.stringify({ ok: true, clusters: Array.from({ length: n }, (_, i) => ({ id: `c${i}` })) })}\n`;

describe('a probe result is read once stdout has drained', () => {
	it('returns the result even when `exit` arrives BEFORE any stdout (the CI race)', async () => {
		const result = await runProbe({ stdout: [clusters(2)], exitFirst: true });
		expect(result).toHaveLength(2);
	});

	it('still returns it when the result arrives SPLIT across chunks after exit', async () => {
		const line = clusters(1);
		const cut = SENTINEL.length + 4;
		const result = await runProbe({ stdout: [line.slice(0, cut), line.slice(cut)], exitFirst: true });
		expect(result).toHaveLength(1);
	});

	it('is unchanged on the ordinary path: stdout first, then exit', async () => {
		const result = await runProbe({ stdout: [clusters(3)] });
		expect(result).toHaveLength(3);
	});

	/**
	 * The bound. A grandchild holding the pipe means `close` never comes; the probe
	 * must still answer rather than wait out the op's whole timeout. The result is
	 * already in hand at `exit`, so this must not even cost the grace window.
	 */
	it('answers immediately at exit when the result is already in hand, even if `close` never comes', async () => {
		const started = Date.now();
		const result = await runProbe({ stdout: [clusters(1)], holdOpen: true });
		expect(result).toHaveLength(1);
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	/**
	 * And a genuinely empty probe is still a crash - reported a moment later rather
	 * than never, and still naming HOW the process died.
	 */
	it('reports a child that exited having written nothing as a crash, not a hang', async () => {
		const started = Date.now();
		await expect(runProbe({ stdout: [], exitFirst: true, exitCode: 0 })).rejects.toThrow(
			/probe crashed: python exited code=0/
		);
		expect(Date.now() - started).toBeLessThan(20_000);
	});

	it('still prefers the child\'s own stderr as the failure detail', async () => {
		await expect(
			runProbe({ stdout: [], stderr: ['Traceback: boom\n'], exitFirst: true, exitCode: 1 })
		).rejects.toThrow(/Traceback: boom/);
	});

	/**
	 * A result in hand must be a COMPLETE one. A listing big enough to outrun a
	 * single pipe read (a `catalogs`/`schemas`/`tables` reply carries up to
	 * `MAX_ROWS` rows) hands over a first chunk that starts with the sentinel and is
	 * cut mid-JSON, with the terminating newline arriving only afterwards - so a
	 * fast path keyed on the PREFIX settles on a truncated line and reports
	 * `unparseable probe result`, which is the same load-dependent false failure
	 * this file exists to remove.
	 */
	it('waits for the newline when the pipe cuts the sentinel line mid-JSON', async () => {
		const line = clusters(400);
		const cut = Math.floor(line.length / 2);
		expect(line.slice(0, cut).startsWith(SENTINEL)).toBe(true);
		expect(line.slice(0, cut)).not.toContain('\n');
		const result = await runProbe({
			stdout: [line.slice(0, cut), line.slice(cut)],
			chunksBeforeExit: 1
		});
		expect(result).toHaveLength(400);
	});

	/**
	 * The op timeout bounds how long the child may RUN, and once `exit` has fired the
	 * child is gone. Left armed across the drain it fires against a dead process,
	 * SIGKILLs it and rejects with a timeout that never happened - after which
	 * `finish` sees `killedByTimeout` and silently drops the result that had just
	 * drained. `PROBE_DRAIN_GRACE_MS` is the only bound the drain needs.
	 */
	it('does not reject with a timeout when the child exits just before its deadline', async () => {
		vi.useFakeTimers();
		// Exit inside the op's window, output a beat after the deadline it no longer
		// answers to, and still well inside the drain grace.
		script.current = { stdout: [clusters(2)], exitAtMs: 44_500, stdoutAtMs: 45_500 };
		try {
			const pending = dbx.listClusters({ profile: 'pat' });
			const outcome = pending.then(
				(clusters) => ({ status: 'resolved' as const, clusters }),
				(error: unknown) => ({ status: 'rejected' as const, error: String(error) })
			);
			await vi.advanceTimersByTimeAsync(60_000);
			const settled = await outcome;
			expect(settled).toMatchObject({ status: 'resolved' });
			expect(settled.status === 'resolved' ? settled.clusters : []).toHaveLength(2);
		} finally {
			script.current = null;
			vi.useRealTimers();
		}
	});
});
