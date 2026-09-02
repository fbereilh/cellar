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
	/** Never emit `close` - a grandchild is still holding the pipe. */
	holdOpen?: boolean;
	exitCode?: number | null;
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
				if (plan.exitFirst) {
					// The OS-legal interleaving: the process is gone, its output is not
					// yet readable. `close` follows only once the pipe drains.
					child.emit('exit', code, null);
					setTimeout(() => {
						writeOut();
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
});
