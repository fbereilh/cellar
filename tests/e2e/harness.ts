import { expect, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFreshness, missingReason, stalenessReason } from '../../src/lib/server/build-freshness.js';

/**
 * Shared launcher harness for cellar's Playwright E2E specs. Each spec boots the
 * REAL `cellar` launcher (Node app + Jupyter sidecar + a python3 kernel) against a
 * throwaway workspace; the app port is allocated dynamically per run, so the URL
 * is discovered from the launcher's stdout rather than a fixed `webServer`.
 *
 * The runtime (uv + python3 + the cached host-venv) is provisioned in CI and the
 * suite gates every PR (.github/workflows/e2e.yml). It still SKIPS when that
 * runtime is missing, which is right for a developer machine without `uv` — but
 * a skip is exactly wrong on a runner, so CI sets `CELLAR_E2E_REQUIRE_RUNTIME`
 * and the run aborts instead. See `runtimeMissing` just below.
 */

/** Repo root, resolved from this file's location (tests/e2e/harness.ts → ../..). */
export const REPO = resolve(fileURLToPath(import.meta.url), '../../..');

/**
 * What the kernel runtime is MISSING, if anything - the one rule, stated as the
 * list rather than as a boolean.
 *
 * `runtimeAvailable()` (the per-spec skip) and `assertRuntimePresent()` (the CI
 * guard in tests/e2e/global-setup.ts) are both projections of THIS, because the
 * two ask the same question and a second copy is how they come to disagree - and
 * a disagreement here is the specific failure that makes a CI e2e job green while
 * running nothing (every spec calls `test.skip(!runtimeAvailable(), …)`, and
 * Playwright exits 0 for a fully-skipped run).
 *
 * Each entry names the thing to install rather than the check that failed, since
 * the only reader who ever sees one is somebody fixing a runner.
 */
export function runtimeMissing(env: NodeJS.ProcessEnv = process.env): string[] {
	const has = (cmd: string) =>
		spawnSync(cmd, ['--version'], { stdio: 'ignore', env }).status === 0;
	const hostVenv = join(env.HOME || '', '.cellar', 'host-venv', 'bin', 'python');
	const missing: string[] = [];
	if (!has('uv')) missing.push('uv (https://docs.astral.sh/uv/ - the launcher shells out to it for every venv op)');
	if (!has('python3')) missing.push('python3');
	if (!existsSync(hostVenv))
		missing.push(
			`cellar's Jupyter host venv at ${hostVenv} (create it with \`node scripts/ensure-e2e-runtime.js\`)`
		);
	return missing;
}

/** True only when the kernel runtime the E2E needs is actually present. */
export function runtimeAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
	return runtimeMissing(env).length === 0;
}

/**
 * How long a launcher gets to print its URL before the boot is called dead.
 *
 * 60s, down from 90s. A warm boot here is ~1.2s MEASURED (three runs at load 4;
 * uv resolves the throwaway workspace's venv from cache), so 60s is ~46x the
 * measured cost - deliberately generous, because the cost of guessing LOW is a
 * whole spec file's worth of false failures on a merely loaded machine, while the
 * cost of guessing high is one wedged launcher held a minute instead of a minute
 * and a half. That still matters at `workers: 2` across ~50 spec files, where a
 * systemic boot failure is paid once per file. `CELLAR_E2E_BOOT_TIMEOUT_MS` raises
 * it for a genuinely cold uv cache, which is a one-time per-machine cost.
 */
export const BOOT_TIMEOUT_MS = Number(process.env.CELLAR_E2E_BOOT_TIMEOUT_MS) || 60_000;

/**
 * Say WHY a boot failed, at the assertion, not only in interleaved stdout.
 *
 * `launcher exited early (1)` on its own sends you reading the launcher's source;
 * the launcher had already printed the real reason, but Playwright reports the
 * rejection and nothing else. So the failure carries the build verdict (the
 * commonest cause by far - see tests/e2e/global-setup.ts) plus the tail of what
 * the launcher actually said.
 *
 * A pure function of (output, repo), and exported for that reason: what it CLAIMS
 * about a build is the part worth pinning, and a unit test can drive it against a
 * fixture repo without booting anything.
 */
export function bootDiagnostic(output: string, repo: string = REPO): string {
	const parts: string[] = [];
	const freshness = buildFreshness(repo);
	if (freshness.state === 'missing') parts.push(missingReason(repo, freshness));
	else if (freshness.state === 'stale')
		parts.push(`the production build is STALE (${stalenessReason(repo, freshness)})`);
	if (parts.length) parts.push('run `npm run build`');
	const tail = output.trim().split('\n').slice(-8).join('\n');
	return (
		(parts.length ? `\n  build: ${parts.join('; ')}.` : '') +
		(tail ? `\n  last launcher output:\n${tail.replace(/^/gm, '    ')}` : '')
	);
}

/**
 * How long an MCP tool call gets before the client gives up.
 *
 * The SDK's own default is 60s, and these calls are not RPC pings - they RUN
 * CELLS (`add_and_run`, `clear_outputs` over a notebook full of output), so the
 * budget is really "how long may a kernel take". It was set on a 15-core M5 Pro
 * and `ubuntu-latest` measures 2.3-3x slower, so 60s there is 20-26s of the same
 * headroom. MEASURED: `mcp-ergonomics` and both `mcp-agent-sees-figures` tests
 * failed with `MCP error -32001: Request timed out` on the runner.
 *
 * Same reasoning as `CELLAR_E2E_EXPECT_TIMEOUT_MS` in playwright.config.ts, and
 * the same limit: it scales a HARNESS budget to the hardware, never a product
 * one, so it cannot hide a slow tool from a user - only from a test that was
 * measuring the runner rather than the code.
 */
export const MCP_CALL_TIMEOUT_MS = Number(process.env.CELLAR_E2E_MCP_TIMEOUT_MS) || 60_000;

/**
 * Remove a spec's throwaway workspace, tolerating the teardown race.
 *
 * Every spec's `afterAll` kills its launcher and then deletes the workspace, and
 * `killCellar` only SIGNALS - it cannot wait, because it is called from a
 * synchronous hook. So the launcher's own SIGTERM cleanup (which rewrites
 * `<ws>/.cellar/runtime.json`) can still be running while `rmSync` walks the
 * tree, and the removal fails `ENOTEMPTY` on a directory it had just emptied.
 * MEASURED on Linux CI, where it failed a test whose every assertion had
 * PASSED - a false red, which on a PR gate is the expensive kind of failure.
 *
 * `maxRetries` is node's own remedy for exactly this (it retries EBUSY, EMFILE,
 * ENFILE, ENOTEMPTY and EPERM), and it costs nothing when there is no race.
 * Anything still failing after that is swallowed: this is a `mkdtemp` directory
 * under the OS temp dir, so the worst case is one leftover directory the OS
 * reclaims - never a reason to fail a green test.
 */
export function removeWorkspace(ws: string | undefined | null): void {
	if (!ws) return;
	try {
		rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	} catch {
		/* a temp dir that would not delete is not a test failure */
	}
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
		let buf = '';
		// The exit handler stays wired for the whole life of the launcher - it is what
		// reports one that dies before printing its URL - so it MUST NOT do work once
		// the boot has settled: `killCellar` at teardown fires it after a perfectly
		// good boot, and bootDiagnostic() walks src/ and static/ to build an Error
		// that `reject` then discards on an already-resolved promise.
		let settled = false;
		const fail = (what: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error(`${what}${bootDiagnostic(buf)}`));
		};
		const timer = setTimeout(() => {
			// A timed-out launcher is still ALIVE, and nothing else will reap it: the
			// promise rejects, so the spec's `launcher` is never assigned and its
			// `if (launcher) killCellar(launcher)` teardown is skipped - leaving a
			// detached process group (app + jupyter sidecar + kernel) holding ports
			// past the whole Playwright run and past the removal of its mkdtemp
			// workspace. "Fails FAST" must not mean "leaks an instance nobody reaps",
			// so the same teardown the specs use runs here first. `killCellar` swallows
			// its own errors, so it can never mask the timeout being reported.
			// The `exit` path deliberately does NOT do this: that process is gone.
			killCellar(proc);
			fail(
				`launcher did not print its URL within ${BOOT_TIMEOUT_MS}ms ` +
					`(raise CELLAR_E2E_BOOT_TIMEOUT_MS if this machine is genuinely slower)`
			);
		}, BOOT_TIMEOUT_MS);
		const scan = (chunk: Buffer) => {
			const s = chunk.toString();
			buf += s;
			process.stdout.write(`[cellar-e2e] ${s}`);
			const m = buf.match(/app → (http:\/\/localhost:\d+)/);
			if (m && !settled) {
				settled = true;
				clearTimeout(timer);
				resolvePromise({ proc, url: m[1] });
			}
		};
		proc.stdout?.on('data', scan);
		proc.stderr?.on('data', scan);
		proc.on('exit', (code) => fail(`launcher exited early (${code})`));
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
 * open, whatever state this page inherited. Fourteen specs call this; THIRTEEN of
 * them had hand-rolled copies of the racy shape and were converted, and the
 * fourteenth is `chat-cell.spec.ts`, which had already worked out this fix in
 * place and was folded in, so there is exactly one copy.
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
