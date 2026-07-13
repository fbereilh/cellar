import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	processStartTime,
	verifyPidIdentity,
	pidReapDecision,
	registerInstance,
	readInstance,
	reapInstance,
	reapVanishedWorkspaces
} from '../../src/lib/server/instances';
import { pidAlive } from '../../src/lib/server/runtime';

/**
 * Pid-reuse–safe reaping.
 *
 * The bug this pins: a fresh `cellar` launch reaped a registry entry whose
 * launcherPid the OS had since handed to an UNRELATED live process (its own
 * worktree was deleted), killing that process and its live kernel. The fix is an
 * identity check — a recorded pid may be killed ONLY when the live process is
 * provably the same one we registered (its real start time matches). These tests
 * exercise the identity primitive and the end-to-end reap decision against a
 * REAL live process we control.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Spawn a real, long-lived child process and return it once `ps` can see it. */
async function spawnVictim(): Promise<ChildProcess> {
	const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
		stdio: 'ignore'
	});
	// Wait until the pid is both alive and visible to `ps` (start time readable).
	for (let i = 0; i < 50; i++) {
		if (child.pid && pidAlive(child.pid) && processStartTime(child.pid) != null) break;
		await sleep(20);
	}
	return child;
}

function killChild(child: ChildProcess | null) {
	if (child?.pid && pidAlive(child.pid)) {
		try {
			child.kill('SIGKILL');
		} catch {}
	}
}

describe('processStartTime', () => {
	it('returns the start time of a live process', () => {
		const t = processStartTime(process.pid);
		expect(typeof t).toBe('number');
		// Our own start time is in the past, not the future.
		expect(t!).toBeLessThanOrEqual(Date.now() + 2000);
	});

	it('returns null for a pid that does not exist', () => {
		// 2^31-ish pid that is not allocatable on any real system.
		expect(processStartTime(2147480000)).toBeNull();
	});
});

describe('verifyPidIdentity', () => {
	it('confirms a match when the recorded start time equals the live one', () => {
		const start = processStartTime(process.pid)!;
		expect(verifyPidIdentity(process.pid, { startTime: start })).toBe(true);
	});

	it('rejects an impostor whose live start time differs from the record', () => {
		const start = processStartTime(process.pid)!;
		// Record a start time an hour before the live process actually started →
		// this is the pid-reuse signature.
		expect(verifyPidIdentity(process.pid, { startTime: start - 3600_000 })).toBe(false);
	});

	it('confirms via the legacy startedAt window when no start time was recorded', () => {
		// A real process started at/just before its registration → confirmed.
		expect(verifyPidIdentity(process.pid, { startedAt: Date.now() })).toBe(true);
	});

	it('rejects via the legacy window when the live process is much newer', () => {
		// Entry registered an hour ago, but the live pid started just now → reused.
		expect(verifyPidIdentity(process.pid, { startedAt: Date.now() - 3600_000 })).toBe(false);
	});

	it('returns null (unverifiable → do not kill) with no baseline', () => {
		expect(verifyPidIdentity(process.pid, {})).toBeNull();
	});

	it('returns false for a dead pid (nothing to kill)', () => {
		expect(verifyPidIdentity(2147480000, { startedAt: Date.now() })).toBe(false);
	});
});

describe('pidReapDecision', () => {
	it('kills only on a positive identity match', () => {
		const start = processStartTime(process.pid)!;
		expect(pidReapDecision(process.pid, start, undefined).kill).toBe(true);
	});

	it('never kills an impostor pid', () => {
		const start = processStartTime(process.pid)!;
		const d = pidReapDecision(process.pid, start - 3600_000, undefined);
		expect(d.kill).toBe(false);
		expect(d.alive).toBe(true);
		expect(d.reason).toMatch(/impostor/i);
	});

	it('never kills when identity is unverifiable', () => {
		const d = pidReapDecision(process.pid, undefined, undefined);
		expect(d.kill).toBe(false);
		expect(d.reason).toMatch(/unverifiable/i);
	});

	it('no-ops on a missing pid', () => {
		expect(pidReapDecision(undefined, undefined, undefined).kill).toBe(false);
	});
});

describe('reapInstance — identity-verified end to end', () => {
	let realHome: string | undefined;
	let tmpHome: string;
	let victim: ChildProcess | null = null;

	beforeAll(() => {
		// Isolate the global registry (~/.cellar/instances) to a temp HOME so the
		// test never touches the user's real registry.
		realHome = process.env.HOME;
		tmpHome = mkdtempSync(join(tmpdir(), 'cellar-home-'));
		process.env.HOME = tmpHome;
	});

	afterAll(() => {
		if (realHome === undefined) delete process.env.HOME;
		else process.env.HOME = realHome;
		rmSync(tmpHome, { recursive: true, force: true });
	});

	beforeEach(async () => {
		victim = await spawnVictim();
	});

	afterEach(() => {
		killChild(victim);
		victim = null;
	});

	it('PRUNES but does NOT kill a reused (impostor) launcher pid', async () => {
		const pid = victim!.pid!;
		const actualStart = processStartTime(pid)!;
		// Register a vanished-workspace entry pointing at this live pid, but with a
		// start time an hour in the past — i.e. the recorded instance is long gone
		// and the OS reused its pid for our victim. This is the exact reported bug.
		registerInstance({
			launcherPid: pid,
			workspace: '/definitely/not/a/real/workspace',
			launcherStart: actualStart - 3600_000,
			startedAt: Date.now() - 3600_000
		});

		const logs: string[] = [];
		const res = await reapInstance(readInstance(pid), {
			log: (m: string) => logs.push(m),
			reason: 'vanished-workspace'
		});

		// The unrelated process MUST survive.
		expect(pidAlive(pid)).toBe(true);
		expect(res.killedAny).toBe(false);
		// The stale entry is pruned so it can't mislead a future reaper.
		expect(readInstance(pid)).toBeNull();
		// The decision is auditable in the log.
		expect(logs.join('\n')).toMatch(/IMPOSTOR|SKIP/i);
	});

	it('reaps a genuine same-workspace instance (intended take-over preserved)', async () => {
		const pid = victim!.pid!;
		const actualStart = processStartTime(pid)!;
		registerInstance({
			launcherPid: pid,
			workspace: tmpHome, // exists
			launcherStart: actualStart,
			startedAt: Date.now()
		});

		const res = await reapInstance(readInstance(pid), { reason: 'same-workspace-takeover' });

		expect(res.killedAny).toBe(true);
		expect(pidAlive(pid)).toBe(false);
		expect(readInstance(pid)).toBeNull();
	});

	it('reapVanishedWorkspaces (the misfiring sweep) prunes without killing an impostor', async () => {
		// Reproduce the reported bug at the sweep level: a deleted-worktree entry
		// whose pid the OS reused for the user's unrelated launcher.
		const pid = victim!.pid!;
		const actualStart = processStartTime(pid)!;
		registerInstance({
			launcherPid: pid,
			workspace: '/gone/worktree/that/was/removed',
			launcherStart: actualStart - 3600_000,
			startedAt: Date.now() - 3600_000
		});

		const reaped = await reapVanishedWorkspaces({ excludePid: process.pid });

		// The victim (an unrelated live process) is untouched — the whole point.
		expect(pidAlive(pid)).toBe(true);
		// Its stale entry is pruned so no future sweep can mistake it again.
		expect(readInstance(pid)).toBeNull();
		// The sweep still processed it (as a candidate), it just didn't kill it.
		expect(reaped.some((e) => e.launcherPid === pid)).toBe(true);
	});

	it('reaps a legacy entry with no recorded start time via the startedAt window', async () => {
		const pid = victim!.pid!;
		registerInstance({
			launcherPid: pid,
			workspace: tmpHome,
			startedAt: Date.now() // just registered → matches a just-started process
		});

		const res = await reapInstance(readInstance(pid), { reason: 'same-workspace' });
		expect(res.killedAny).toBe(true);
		expect(pidAlive(pid)).toBe(false);
	});
});
