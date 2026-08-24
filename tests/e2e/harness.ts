import { expect, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Shared launcher harness for cellar's Playwright E2E specs. Each spec boots the
 * REAL `cellar` launcher (Node app + Jupyter sidecar + a python3 kernel) against a
 * throwaway workspace; the app port is allocated dynamically per run, so the URL
 * is discovered from the launcher's stdout rather than a fixed `webServer`. The
 * runtime (uv + python3 + the cached host-venv) is not reliably present in CI, so
 * these are LOCAL, best-effort checks that SKIP when the runtime is missing — the
 * vitest unit suite is the must-pass gate.
 */

/** Repo root, resolved from this file's location (tests/e2e/harness.ts → ../..). */
export const REPO = resolve(fileURLToPath(import.meta.url), '../../..');

/** True only when the kernel runtime the E2E needs is actually present. */
export function runtimeAvailable(): boolean {
	const has = (cmd: string) => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;
	const hostVenv = join(process.env.HOME || '', '.cellar', 'host-venv', 'bin', 'python');
	return has('uv') && has('python3') && existsSync(hostVenv);
}

/**
 * Spawn the launcher and resolve the app URL it prints once fully up.
 *
 * `env` adds to the launcher's environment. It exists for state that is GLOBAL to
 * the machine rather than scoped to the throwaway workspace - `CELLAR_USER_SETTINGS`
 * being the case it was added for: that store defaults to a real file in the home
 * directory, so a spec touching it without redirecting it first would be rewriting
 * the settings of whoever ran the suite.
 *
 * Which is why redirecting it is the DEFAULT here rather than each spec's job: every
 * booted app READS that store on its first SSR load (the upload-affix default is
 * hydrated from it), so "only the specs that write it need to opt in" is already
 * wrong - and a spec that does write it is exactly the one whose author is least
 * likely to notice. Unless `env` names its own, the store is redirected into the
 * throwaway workspace, so it dies with it. A spec that needs two launchers to SHARE
 * one global store passes the same path to both, which is the one case the default
 * cannot serve.
 *
 * It goes under the workspace's `.cellar/`, not its root: that directory is the one
 * place Cellar treats as gitignored runtime state, and specs that `git init` their
 * workspace assert on git decorations and `status` - so a redirected store at the
 * root would surface as an untracked file the moment any spec wrote a setting.
 */
export function bootCellar(
	ws: string,
	env: Record<string, string> = {}
): Promise<{ proc: ChildProcess; url: string }> {
	// A no-op `open`/`xdg-open` on PATH so the launcher's "open the browser" step
	// is suppressed — Playwright drives its own browser against the URL.
	const shim = join(ws, '.shim');
	mkdirSync(shim, { recursive: true });
	for (const name of ['open', 'xdg-open']) {
		const p = join(shim, name);
		writeFileSync(p, '#!/bin/sh\nexit 0\n');
		chmodSync(p, 0o755);
	}

	const proc = spawn(
		'node',
		[join(REPO, 'bin', 'cellar.js'), '-w', ws, '--new', '--no-mcp-config', '-y'],
		{
			cwd: REPO,
			env: {
				...process.env,
				PATH: `${shim}:${process.env.PATH}`,
				CI: '1',
				CELLAR_USER_SETTINGS: join(ws, '.cellar', 'user-settings.json'),
				...env
			},
			stdio: ['ignore', 'pipe', 'pipe'],
			detached: true
		}
	);

	return new Promise((resolvePromise, reject) => {
		const timer = setTimeout(() => reject(new Error('launcher did not become ready in time')), 90_000);
		let buf = '';
		const scan = (chunk: Buffer) => {
			const s = chunk.toString();
			buf += s;
			process.stdout.write(`[cellar-e2e] ${s}`);
			const m = buf.match(/app → (http:\/\/localhost:\d+)/);
			if (m) {
				clearTimeout(timer);
				resolvePromise({ proc, url: m[1] });
			}
		};
		proc.stdout?.on('data', scan);
		proc.stderr?.on('data', scan);
		proc.on('exit', (code) => {
			clearTimeout(timer);
			reject(new Error(`launcher exited early (${code})`));
		});
	});
}

/** Kill the launcher and its whole process group (app + jupyter sidecar). */
export function killCellar(proc: ChildProcess): void {
	if (proc.pid == null) return;
	try {
		process.kill(-proc.pid, 'SIGTERM');
	} catch {
		try {
			proc.kill('SIGTERM');
		} catch {
			/* already gone */
		}
	}
}

/**
 * Expand a sidebar section, CONVERGING rather than toggling once.
 *
 * A section's open/closed state lives in the SERVER-owned UI store, so it
 * survives into the next test and the next page - and the restore lands at
 * HYDRATION, after the first paint. A helper that reads visibility once and
 * clicks on that reading therefore has a real race: with the stored state
 * CLOSED and the check landing pre-hydration, the click opens the section
 * locally and hydration then closes it again, after which the single
 * `toBeVisible()` waits out its whole timeout on a panel nothing will reopen.
 * Load does not cause that - it only widens the window, which is why these
 * surfaced as "unrelated flakes" in busy full runs (`databricks-two-card-redesign`
 * and `git-notebook-commits` are named in AGENTS.md for exactly this).
 *
 * So click only while the panel is REALLY closed, retried until it is visibly
 * open, whatever state this page inherited. Nine specs had hand-rolled copies of
 * the racy shape; `chat-cell.spec.ts` had already worked out this fix in place,
 * and this is that rule with one home.
 */
export async function openSidebarSection(page: Page, section: string, body: string, timeout = 30_000): Promise<void> {
	const header = page.getByTestId(`section-${section}`);
	await expect(header).toBeVisible({ timeout });
	const panel = page.getByTestId(body);
	await expect(async () => {
		if (!(await panel.isVisible().catch(() => false))) await header.click();
		await expect(panel).toBeVisible({ timeout: 1_000 });
	}).toPass({ timeout });
}
