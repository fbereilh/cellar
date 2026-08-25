import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { REPO, bootCellar, killCellar, runtimeAvailable } from './harness';

/**
 * `cellar cleanup` against REAL cellar instances in two REAL folders.
 *
 * This is the shape of the incident: someone ran `cellar cleanup --all` to clear
 * up their own leftovers and stopped a live notebook session — kernel, namespace,
 * unsaved work — in a folder they had never opened. The scope rule and the
 * consent rule are pinned in the unit suite (which is what CI runs); this pins
 * the whole stack, with actual launchers, actual Jupyter sidecars and actual
 * ports, because that is what was destroyed.
 *
 * Two isolations, both deliberate:
 *
 *  - a temp HOME, so the global registry holds only this spec's instances. Other
 *    spec files run concurrently with launchers of their own, and the developer
 *    running this has a cellar of their own; neither should be visible to a
 *    command whose job is stopping processes.
 *  - a `ps` shim that answers nothing for the machine-wide scan. If this fix ever
 *    regresses, an unshielded run would reach exactly the live session the fix
 *    exists to protect. A test for a data-loss bug must not be able to cause it.
 *
 * The host venv is symlinked in rather than rebuilt: it is a multi-minute
 * jupyter-server install, and it is read-only here.
 */

test.describe('cellar cleanup — cross-workspace safety', () => {
	test.skip(!runtimeAvailable(), 'needs uv + python3 + the cached cellar host-venv');
	test.setTimeout(300_000);

	test('--all stops only this workspace; another workspace needs the phrase', async () => {
		const home = mkdtempSync(join(tmpdir(), 'cellar-cleanup-home-'));
		const wsA = mkdtempSync(join(tmpdir(), 'cellar-cleanup-a-'));
		const wsB = mkdtempSync(join(tmpdir(), 'cellar-cleanup-b-'));

		mkdirSync(join(home, '.cellar'), { recursive: true });
		symlinkSync(join(homedir(), '.cellar', 'host-venv'), join(home, '.cellar', 'host-venv'));

		const shim = mkdtempSync(join(tmpdir(), 'cellar-cleanup-shim-'));
		const ps = join(shim, 'ps');
		writeFileSync(ps, '#!/bin/sh\n[ "$1" = "-eo" ] && exit 0\nexec /bin/ps "$@"\n');
		chmodSync(ps, 0o755);

		const env = { HOME: home, UV_CACHE_DIR: join(homedir(), '.cache', 'uv') };
		const cleanup = (args: string[]) =>
			spawnSync(process.execPath, [join(REPO, 'bin', 'cellar.js'), 'cleanup', ...args], {
				encoding: 'utf8',
				cwd: wsA,
				// A pipe, not a tty: the shape (any script, any agent) that used to be
				// read as blanket consent.
				input: '',
				env: { ...process.env, ...env, PATH: `${shim}:${process.env.PATH}`, CI: '' }
			});
		const responds = async (url: string) => {
			try {
				return (await fetch(url, { signal: AbortSignal.timeout(4000) })).ok;
			} catch {
				return false;
			}
		};

		let a: Awaited<ReturnType<typeof bootCellar>> | null = null;
		let b: Awaited<ReturnType<typeof bootCellar>> | null = null;
		try {
			b = await bootCellar(wsB, env);
			a = await bootCellar(wsA, env);
			expect(await responds(b.url)).toBe(true);
			expect(await responds(a.url)).toBe(true);

			await test.step('--all -y leaves the other workspace running', async () => {
				const r = cleanup(['--all', '-y', '--workspace', wsA]);
				expect(r.status).toBe(0);
				// The one that matters: B is somebody else's folder.
				expect(await responds(b!.url)).toBe(true);
				expect(await responds(a!.url)).toBe(false);
				// …and B is REPORTED as left running, with the flag that would reach
				// it. The old command was dangerous because its reach was invisible.
				expect(r.stdout).toContain(wsB);
				expect(r.stdout).toMatch(/left running elsewhere/i);
			});

			await test.step('--all-workspaces -y is refused; -y is not consent here', async () => {
				const r = cleanup(['--all-workspaces', '-y']);
				expect(r.status).toBe(1);
				expect(r.stderr).toContain('--confirm=stop-all-workspaces');
				expect(await responds(b!.url)).toBe(true);
			});

			await test.step('--dry-run shows the blast radius and stops nothing', async () => {
				const r = cleanup(['--all-workspaces', '--dry-run']);
				expect(r.status).toBe(0);
				expect(r.stdout).toMatch(/would stop/i);
				expect(r.stdout).toContain(wsB);
				expect(await responds(b!.url)).toBe(true);
			});

			await test.step('the exact phrase does stop it — deliberate stays possible', async () => {
				const r = cleanup(['--all-workspaces', '--confirm=stop-all-workspaces']);
				expect(r.status).toBe(0);
				await expect.poll(() => responds(b!.url), { timeout: 20_000 }).toBe(false);
			});
		} finally {
			if (a) killCellar(a.proc);
			if (b) killCellar(b.proc);
			for (const d of [home, wsA, wsB, shim]) rmSync(d, { recursive: true, force: true });
		}
	});
});
