/**
 * "Stop" on a chat cell must actually stop it - promptly, and with nothing left
 * running behind it.
 *
 * ## What was wrong (REPRODUCED end to end before this suite existed)
 *
 * The stop chain was fully wired - the Stop control reaches `interruptKernel`,
 * which reaches `abortChatRuns(nb)`, which aborts the run's controller, which
 * the engine turns into a kill - and it still did not stop the run, because the
 * kill was `child.kill()`: ONE pid. The claude CLI spawns its own children (a
 * tool subprocess, a shell it ran), and those are not in that pid. Measured
 * against a real launcher and a real browser:
 *
 *   - a descendant of a stopped chat run stayed alive after the Stop press,
 *     after the run settled, and after Cellar's OWN Ctrl-C shutdown (the
 *     launcher SIGTERMs its direct children, so nothing anywhere reached it);
 *   - the descendant also inherited the child's stdout pipe, so node's `close`
 *     never fired and the run settled only on a 5s force-settle timer: 5.0s at
 *     the API, 5.3s of spinner in the browser after the click.
 *
 * The MASKING CONDITION is why this looked like it worked: a chat run whose
 * child leaves NO descendants - a short reply with no tool use, and every stub
 * in the rest of the suite - dies on SIGTERM, `close` fires at once, and the run
 * settles in milliseconds with nothing left behind. So the fix has to be checked
 * against a run that HAS a descendant, which is what every case here builds.
 *
 * ## Why these are real processes
 *
 * The whole defect lives in what a signal reaches, so a mocked `spawn` could not
 * see it in either direction: the stub is a real script, its grandchild is a
 * real process, and "is it gone" is asked of the OS. `signalRunTree` is not
 * exercised directly for the same reason - what matters is the reach, not the
 * call.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeCliEngine } from '../../src/lib/server/chat/claude-cli';
import {
	abortAllChatRuns,
	abortChatRuns,
	registerChatRun,
	stopChatRunsOnShutdown,
	unregisterChatRun,
	__resetChatRuns
} from '../../src/lib/server/chat/active';

let BIN: string;
let OUT: string;
const savedPath = process.env.PATH;

/** A bare init the engine's allowlist assertion accepts (no tools requested). */
const SAFE_INIT = JSON.stringify({
	type: 'system',
	subtype: 'init',
	tools: [],
	mcp_servers: [],
	slash_commands: [],
	skills: [],
	claude_code_version: '9.9.9-stub'
});

beforeAll(() => {
	BIN = mkdtempSync(join(tmpdir(), 'cellar-chat-stop-bin-'));
	OUT = mkdtempSync(join(tmpdir(), 'cellar-chat-stop-out-'));
	process.env.PATH = `${BIN}:${savedPath}`;
	writeStub();
});

afterAll(() => {
	process.env.PATH = savedPath;
	for (const d of [BIN, OUT]) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
});

afterEach(() => {
	__resetChatRuns();
});

/**
 * A stub `claude` that starts a long-lived GRANDCHILD, records its pid, and then
 * waits - the shape a real run has whenever the model used a tool.
 *
 * The grandchild `exec`s, so the pid in the file is the sleeper itself rather
 * than a shell that would exit on its own; and the stub `wait`s, so the direct
 * child does not exit first (which is what a CLI supervising its tools does).
 *
 * WRITTEN ONCE, and never rewritten while a run may still be executing it: a
 * shell reads its script INCREMENTALLY and seeks back after each command, and
 * `writeFileSync` truncates before it writes, so re-writing this file to give a
 * concurrent run its own pidfile could hand the parked `sh` an EOF or a partial
 * line. It would then exit early and orphan its grandchild outside a group whose
 * leader is already reaped - a flake shaped exactly like the bug under test. So
 * each INVOCATION names its own pidfile from its own `$$` instead, and the test
 * collects whichever file is new (`nextGrandchildPid`).
 */
function writeStub(): void {
	writeFileSync(
		join(BIN, 'claude'),
		[
			'#!/bin/sh',
			'cat > /dev/null', // drain the prompt off stdin, as the real CLI does
			`echo '${SAFE_INIT}'`,
			`echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"working"}}}'`,
			// The OUTER `$$` (this stub's pid) names the file; the escaped `\$\$` is
			// left for the INNER shell and is the sleeper's own pid.
			`sh -c "echo \\$\\$ > ${OUT}/$$.pid; exec sleep 900" &`,
			'wait',
			''
		].join('\n')
	);
	chmodSync(join(BIN, 'claude'), 0o755);
}

/** Start one engine run against the current stub. */
function startRun(signal: AbortSignal) {
	return claudeCliEngine.run({
		prompt: 'hello\n',
		configDir: null,
		notebookPath: null,
		signal,
		onDelta: () => {}
	});
}

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/**
 * Pidfiles already claimed by an earlier `nextGrandchildPid`. Every run in this
 * file is started and then WAITED FOR before the next one begins, so "the file
 * nobody has claimed yet" identifies the run that was just started.
 */
const claimed = new Set<string>();

/** Wait for the run just started to record its grandchild's pid, and return it. */
async function nextGrandchildPid(): Promise<number> {
	for (let i = 0; i < 200; i++) {
		for (const name of readdirSync(OUT)) {
			if (!name.endsWith('.pid') || claimed.has(name)) continue;
			const pid = Number(readFileSync(join(OUT, name), 'utf8').trim());
			if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
				claimed.add(name);
				return pid;
			}
		}
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error('the stub never started its grandchild - the fixture is broken, not the code');
}

/** Poll until `pid` is gone, or give up after `ms`. */
async function goneWithin(pid: number, ms: number): Promise<boolean> {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		if (!alive(pid)) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	return !alive(pid);
}

/** Kill a leaked process so one failing case cannot poison the machine. */
function reap(pid: number | null): void {
	if (pid == null) return;
	try {
		process.kill(pid, 'SIGKILL');
	} catch {
		/* already gone */
	}
}

describe('stopping a chat run', () => {
	it('kills what the CLI itself started, not just the CLI', async () => {
		const ctrl = new AbortController();
		const run = startRun(ctrl.signal);
		const gc = await nextGrandchildPid();
		try {
			expect(alive(gc)).toBe(true);

			ctrl.abort();
			await run;

			// The whole point: the descendant is gone. Before the fix it outlived the
			// stop, the run, and Cellar itself.
			expect(await goneWithin(gc, 8_000)).toBe(true);
		} finally {
			reap(gc);
		}
	}, 20_000);

	it('settles PROMPTLY on the verdict, not on a pipe a descendant still holds', async () => {
		const ctrl = new AbortController();
		const run = startRun(ctrl.signal);
		const gc = await nextGrandchildPid();
		try {
			const t0 = Date.now();
			ctrl.abort();
			const res = await run;
			const took = Date.now() - t0;

			expect(res.ok).toBe(false);
			expect(res.failure?.kind).toBe('cancelled');
			// The old force-settle floor was 5s. Well under it, and nowhere near a
			// number a person reads as "it did not stop": the bound is deliberately
			// generous against a loaded machine while still failing the 5s shape.
			expect(took).toBeLessThan(2_000);
		} finally {
			reap(gc);
		}
	}, 20_000);

	it('stops only the run that was stopped - a sibling keeps running', async () => {
		const a = new AbortController();
		const runA = startRun(a.signal);
		const gcA = await nextGrandchildPid();

		// B runs CONCURRENTLY with A - that is the point of this case - and the
		// stub is never rewritten to make it possible: A's shell is parked at
		// `wait` inside the very file B is about to execute.
		const b = new AbortController();
		const runB = startRun(b.signal);
		const gcB = await nextGrandchildPid();

		try {
			expect(gcA).not.toBe(gcB);
			// Registered per notebook, exactly as a run does, so this drives the real
			// scoping rule rather than the controllers directly.
			registerChatRun('/ws/a.ipynb', a);
			registerChatRun('/ws/b.ipynb', b);

			expect(abortChatRuns('/ws/a.ipynb')).toBe(1);
			await runA;
			expect(await goneWithin(gcA, 8_000)).toBe(true);

			// B is untouched: still running, still holding its own tree.
			expect(alive(gcB)).toBe(true);
			expect(b.signal.aborted).toBe(false);

			b.abort();
			await runB;
			expect(await goneWithin(gcB, 8_000)).toBe(true);
		} finally {
			reap(gcA);
			reap(gcB);
			unregisterChatRun('/ws/a.ipynb', a);
			unregisterChatRun('/ws/b.ipynb', b);
		}
	}, 30_000);
});

describe('a stopping app process', () => {
	it('aborts every live chat run, in every notebook', () => {
		const a = new AbortController();
		const b = new AbortController();
		registerChatRun('/ws/a.ipynb', a);
		registerChatRun('/ws/b.ipynb', b);

		expect(abortAllChatRuns()).toBe(2);
		expect(a.signal.aborted).toBe(true);
		expect(b.signal.aborted).toBe(true);
	});

	it('is what a shutdown signal reaches, and stops reaching once removed', () => {
		// An injected emitter, so this never touches the runner's own signal
		// handling (the `releaseOnShutdown` convention).
		const signals = new EventEmitter();
		const off = stopChatRunsOnShutdown(signals);

		const first = new AbortController();
		registerChatRun('/ws/a.ipynb', first);
		signals.emit('SIGTERM');
		expect(first.signal.aborted).toBe(true);

		const second = new AbortController();
		registerChatRun('/ws/a.ipynb', second);
		signals.emit('SIGINT');
		expect(second.signal.aborted).toBe(true);

		off();
		const third = new AbortController();
		registerChatRun('/ws/a.ipynb', third);
		signals.emit('SIGTERM');
		expect(third.signal.aborted).toBe(false);
		unregisterChatRun('/ws/a.ipynb', third);
	});

	it('kills the whole tree of a run that was still going when the process stopped', async () => {
		const ctrl = new AbortController();
		const run = startRun(ctrl.signal);
		const gc = await nextGrandchildPid();
		try {
			registerChatRun('/ws/live.ipynb', ctrl);
			const signals = new EventEmitter();
			const off = stopChatRunsOnShutdown(signals);
			signals.emit('SIGTERM');
			off();

			await run;
			expect(await goneWithin(gc, 8_000)).toBe(true);
		} finally {
			reap(gc);
			unregisterChatRun('/ws/live.ipynb', ctrl);
		}
	}, 20_000);
});
