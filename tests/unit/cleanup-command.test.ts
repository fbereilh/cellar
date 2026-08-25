import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processStartTime, registerInstance, readInstance } from '../../src/lib/server/instances';
import { pidAlive } from '../../src/lib/server/runtime';
import { CONFIRM_PHRASE } from '../../src/lib/server/cleanup-plan';

/**
 * `cellar cleanup` — the CLI, end to end, against REAL processes.
 *
 * The bug: `cellar cleanup --all`, run to tidy up leftovers in one folder, stopped
 * every live cellar in EVERY folder — destroying a live notebook session (kernel,
 * namespace, unsaved work) belonging to someone who was not even involved. And the
 * confirmation could not save them: it was satisfied by `--yes`, by `CI`, and by a
 * NON-TTY STDIN, so a plain `cellar cleanup --all` from any script or agent killed
 * them with no flag and no prompt at all. Both halves were reproduced with two real
 * instances in two real folders before this fix.
 *
 * Why the whole CLI rather than just the planner: the planner is pinned separately
 * (cleanup-scope.test.ts), but the property that matters here is a property of the
 * COMMAND — which consents count, and which do not. A test of the plan alone would
 * still pass if `-y` were wired back into the cross-workspace gate.
 *
 * This drives the real `bin/cellar.js` as a subprocess. Registry entries point at
 * real long-lived processes we spawn (the `instances-reap.test.ts` pattern), so the
 * identity check permits a genuine kill and "did it survive" is a real question
 * about a real pid — no jupyter, no venv, no browser.
 */

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CLI = join(REPO, 'bin', 'cellar.js');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A real, long-lived process standing in for an instance's launcher.
 *
 * DOUBLE-FORKED on purpose: a direct child of this test process becomes a ZOMBIE
 * when killed and stays visible to `process.kill(pid, 0)` until the parent reaps
 * it — and the parent here is blocked inside `spawnSync`, so it cannot. The CLI
 * would then wait out its full SIGTERM grace on every kill (measured: ~8s each,
 * turning this file into a minute). Reparenting to init means the OS reaps it,
 * so "is it dead" is answerable the moment it dies.
 */
async function spawnVictim(): Promise<number> {
	const r = spawnSync('/bin/sh', ['-c', `${process.execPath} -e 'setTimeout(() => {}, 120000)' >/dev/null 2>&1 & echo $!`], {
		encoding: 'utf8'
	});
	const pid = parseInt(r.stdout.trim(), 10);
	for (let i = 0; i < 100; i++) {
		if (pid && pidAlive(pid) && processStartTime(pid) != null) break;
		await sleep(20);
	}
	return pid;
}

function killVictim(pid: number | null) {
	if (pid && pidAlive(pid)) {
		try {
			process.kill(pid, 'SIGKILL');
		} catch {}
	}
}

describe('cellar cleanup — scope + consent', () => {
	let home: string;
	let shim: string;
	let wsMine: string;
	let wsTheirs: string;
	let mine: number | null = null;
	let theirs: number | null = null;
	let realHome: string | undefined;

	beforeAll(() => {
		home = mkdtempSync(join(tmpdir(), 'cellar-cleanup-home-'));
		// The registry lives under $HOME, and this file writes entries from the test
		// process while the CLI reads them from a subprocess — so BOTH have to see
		// the same temp HOME, and neither may touch the developer's real registry.
		realHome = process.env.HOME;
		process.env.HOME = home;
		wsMine = mkdtempSync(join(tmpdir(), 'cellar-ws-mine-'));
		wsTheirs = mkdtempSync(join(tmpdir(), 'cellar-ws-theirs-'));

		// A `ps` shim that answers NOTHING for the machine-wide `-eo` scan, and
		// passes every other form (`-o lstart= -p <pid>`, which the identity check
		// needs) straight through.
		//
		// This is a SAFETY measure, not a convenience: `scanUntrackedCellarProcesses`
		// looks at every process on the machine, and if this fix ever regresses, an
		// unshielded run of this test would reach the developer's own live cellar —
		// exactly the session the fix exists to protect. A test for a data-loss bug
		// must not be able to cause it. Untracked-process handling is pinned purely
		// in cleanup-scope.test.ts, which needs no real processes at all.
		shim = mkdtempSync(join(tmpdir(), 'cellar-shim-'));
		const ps = join(shim, 'ps');
		writeFileSync(ps, '#!/bin/sh\n[ "$1" = "-eo" ] && exit 0\nexec /bin/ps "$@"\n');
		chmodSync(ps, 0o755);
	});

	afterAll(() => {
		if (realHome === undefined) delete process.env.HOME;
		else process.env.HOME = realHome;
		for (const d of [home, wsMine, wsTheirs, shim]) rmSync(d, { recursive: true, force: true });
	});

	/** Run the real CLI with an isolated registry and no machine-wide ps reach. */
	function cleanup(args: string[]) {
		return spawnSync(process.execPath, [CLI, 'cleanup', ...args], {
			encoding: 'utf8',
			cwd: wsMine,
			// stdin is a pipe, i.e. NOT a tty — the very shape (any script, any agent)
			// that used to be treated as blanket consent.
			input: '',
			env: { ...process.env, HOME: home, PATH: `${shim}:${process.env.PATH}`, CI: '' }
		});
	}

	beforeEach(async () => {
		mine = await spawnVictim();
		theirs = await spawnVictim();
		for (const [pid, ws] of [
			[mine, wsMine],
			[theirs, wsTheirs]
		] as const) {
			registerInstance({
				launcherPid: pid!,
				workspace: ws,
				launcherStart: processStartTime(pid!)!,
				startedAt: Date.now()
			});
		}
	});

	afterEach(() => {
		killVictim(mine);
		killVictim(theirs);
		mine = theirs = null;
	});

	it('REGRESSION: --all -y stops this workspace and leaves the other one running', async () => {
		const r = cleanup(['--all', '-y', '--workspace', wsMine]);

		expect(r.status).toBe(0);
		await sleep(200);
		expect(pidAlive(mine!)).toBe(false); // mine: asked for, stopped
		expect(pidAlive(theirs!)).toBe(true); // theirs: never mine to stop
		// Left running is REPORTED, not silently dropped: the old command was
		// dangerous precisely because its blast radius was invisible.
		expect(r.stdout).toMatch(/left running elsewhere/i);
		expect(r.stdout).toContain(wsTheirs);
		// It names the FLAG that would reach them, and never the phrase. This IS the
		// incident's own shape — an agent tidying its leftovers — so printing it a
		// ready-to-run cross-workspace command would have our own tool supplying the
		// deliberate intent the phrase exists to demand.
		expect(r.stdout).toMatch(/cellar cleanup --all-workspaces/);
		expect(r.stdout).not.toContain(CONFIRM_PHRASE);
	});

	it('REGRESSION: a plain --all (no -y, non-TTY) cannot reach the other workspace', async () => {
		// The exact shape of the reported incident, minus the -y that was blamed for
		// it: a non-TTY stdin alone used to be full consent.
		const r = cleanup(['--all', '--workspace', wsMine]);
		await sleep(200);
		expect(pidAlive(theirs!)).toBe(true);
		expect(r.status).toBe(0);
	});

	it('REGRESSION: the default scope stops nothing that is alive', async () => {
		const r = cleanup(['-y', '--workspace', wsMine]);
		await sleep(200);
		expect(pidAlive(mine!)).toBe(true);
		expect(pidAlive(theirs!)).toBe(true);
		expect(r.status).toBe(0);
		// …and it points at the flag that WOULD stop the caller's own instance,
		// so the safe tier stays discoverable — still without the phrase.
		expect(r.stdout).toMatch(/cellar cleanup --all\b/);
		expect(r.stdout).not.toContain(CONFIRM_PHRASE);
	});

	it('REGRESSION: -y does NOT unlock --all-workspaces', async () => {
		const r = cleanup(['--all-workspaces', '-y', '--workspace', wsMine]);
		await sleep(200);
		expect(r.status).toBe(1);
		expect(pidAlive(theirs!)).toBe(true);
		expect(pidAlive(mine!)).toBe(true); // refused whole, not half-applied
		expect(r.stderr).toContain(`--confirm=${CONFIRM_PHRASE}`);
	});

	it('REGRESSION: CI=1 does NOT unlock --all-workspaces either', async () => {
		const r = spawnSync(process.execPath, [CLI, 'cleanup', '--all-workspaces', '--workspace', wsMine], {
			encoding: 'utf8',
			cwd: wsMine,
			input: '',
			env: { ...process.env, HOME: home, PATH: `${shim}:${process.env.PATH}`, CI: '1' }
		});
		await sleep(200);
		expect(r.status).toBe(1);
		expect(pidAlive(theirs!)).toBe(true);
	});

	it('a wrong confirmation phrase aborts and stops nothing', async () => {
		const r = cleanup(['--all-workspaces', '--confirm=yes', '--workspace', wsMine]);
		await sleep(200);
		expect(r.status).toBe(1);
		expect(pidAlive(theirs!)).toBe(true);
		expect(pidAlive(mine!)).toBe(true);
	});

	it('the exact phrase does stop another workspace — deliberate is still possible', async () => {
		const r = cleanup(['--all-workspaces', `--confirm=${CONFIRM_PHRASE}`, '--workspace', wsMine]);
		await sleep(300);
		expect(r.status).toBe(0);
		expect(pidAlive(theirs!)).toBe(false);
		expect(pidAlive(mine!)).toBe(false);
	});

	it('--dry-run shows the full blast radius and stops nothing', async () => {
		const r = cleanup(['--all-workspaces', '--dry-run', '--workspace', wsMine]);
		await sleep(200);
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/would stop/i);
		expect(r.stdout).toContain(wsTheirs);
		expect(r.stdout).toContain(wsMine);
		expect(pidAlive(mine!)).toBe(true);
		expect(pidAlive(theirs!)).toBe(true);
	});

	it('rejects an unknown flag instead of silently choosing a different scope', async () => {
		// `--all-workspace` (singular) used to be ignored, so a typo silently ran a
		// different command than the one that was typed. This one stops processes;
		// an argument it does not understand must stop it.
		const r = cleanup(['--all-workspace', '-y', '--workspace', wsMine]);
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(/unknown flag/i);
		await sleep(200);
		expect(pidAlive(mine!)).toBe(true);
	});

	it('still reaps an orphan in ANOTHER workspace with no flags at all', async () => {
		// The tidy case must stay a one-word command, or the safe default is one
		// nobody uses. An orphan — launcher gone, child still running — belongs to
		// no live session, so it is fair game at every scope.
		const orphanPid = await spawnVictim();
		registerInstance({
			launcherPid: 2147480001, // a pid that cannot exist → launcher is "gone"
			appPid: orphanPid,
			appStart: processStartTime(orphanPid)!,
			workspace: wsTheirs,
			startedAt: Date.now()
		});
		try {
			const r = cleanup(['-y', '--workspace', wsMine]);
			await sleep(300);
			expect(r.status).toBe(0);
			expect(pidAlive(orphanPid)).toBe(false);
			expect(readInstance(2147480001)).toBeNull();
			// …while both live instances are untouched.
			expect(pidAlive(mine!)).toBe(true);
			expect(pidAlive(theirs!)).toBe(true);
		} finally {
			killVictim(orphanPid);
		}
	});

	it('REGRESSION: still tidies when the working directory has been deleted', async () => {
		// A removed worktree is exactly what leaves orphans behind — the registry
		// lives in $HOME so it outlives the folder — and `process.cwd()` throws
		// there, so cleanup died with an unhandled ENOENT before printing anything.
		// The one situation that PRODUCES orphans was the one that could not reap
		// them.
		const gone = mkdtempSync(join(tmpdir(), 'cellar-ws-gone-'));
		const orphanPid = await spawnVictim();
		registerInstance({
			launcherPid: 2147480002, // launcher "gone" → its app is an orphan
			appPid: orphanPid,
			appStart: processStartTime(orphanPid)!,
			workspace: wsTheirs,
			startedAt: Date.now()
		});
		try {
			// Node cannot be SPAWNED into a missing directory, it has to inherit one:
			// delete the cwd out from under a live shell, then exec the CLI in it.
			const r = spawnSync(
				'/bin/sh',
				['-c', 'cd "$1" && rmdir "$1" && exec "$2" "$3" cleanup -y', 'sh', gone, process.execPath, CLI],
				{
					encoding: 'utf8',
					input: '',
					env: { ...process.env, HOME: home, PATH: `${shim}:${process.env.PATH}`, CI: '' }
				}
			);
			await sleep(300);
			expect(r.stderr).not.toMatch(/uv_cwd|ENOENT/);
			expect(r.status).toBe(0);
			expect(pidAlive(orphanPid)).toBe(false);
			// …and an unknowable cwd claims nothing: neither live instance is touched.
			expect(pidAlive(mine!)).toBe(true);
			expect(pidAlive(theirs!)).toBe(true);
		} finally {
			killVictim(orphanPid);
			rmSync(gone, { recursive: true, force: true });
		}
	});
});
