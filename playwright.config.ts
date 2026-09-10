import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for cellar's single end-to-end smoke spec.
 *
 * The spec boots the REAL `cellar` launcher (both servers + the Jupyter kernel)
 * against a scratch workspace and manages that lifecycle itself, because the app
 * port is allocated dynamically per run — there is no fixed URL for Playwright's
 * built-in `webServer` to wait on. So there is no `webServer`/`baseURL` here; the
 * spec discovers the URL from the launcher's stdout and tears the launcher down.
 *
 * This E2E requires the full runtime (uv + python3 + the cached host-venv), so it
 * is a LOCAL, best-effort check — the vitest unit suite is the must-pass CI gate.
 * When the runtime is absent the spec skips itself gracefully.
 *
 * `globalSetup` is what makes the missing `webServer` safe: with no server for
 * Playwright to own, nothing else would verify the build every spec is about to
 * boot, and a bare `npx playwright test <spec>` would silently run against a
 * stale, absent or incomplete one. See tests/e2e/global-setup.ts.
 */
export default defineConfig({
	testDir: './tests/e2e',
	globalSetup: './tests/e2e/global-setup.ts',
	// Kernel boot + cell execution is inherently slower than a pure-web test.
	//
	// Both budgets were chosen on a 15-core M5 Pro, and `ubuntu-latest` measures
	// **2.3-3x slower** on this repo's own build and unit steps - so a 30s wait
	// there is 10-13s of this machine's headroom, and MEASURED, that is where the
	// e2e gate's failures land: on the first Linux runs, three of the four
	// timing-sensitive real-kernel failures (`kernel-status-ui`,
	// `virtualization-pinning`, `notebook-column-width`) died at ~28-33s, i.e. at
	// the assertion budget rather than at anything the code did. Scaling them on
	// the runner is not slack for a flaky suite - it keeps the SAME real headroom
	// the numbers were picked to give. `retries` stays 0, so a genuine regression
	// is still a red check; it just takes longer to say so.
	timeout: Number(process.env.CELLAR_E2E_TIMEOUT_MS) || 120_000,
	expect: { timeout: Number(process.env.CELLAR_E2E_EXPECT_TIMEOUT_MS) || 30_000 },
	// Keep `fullyParallel: false`: tests INSIDE a file share one booted launcher, one
	// workspace and one kernel, so they must stay ordered. `workers` is file-level
	// concurrency, which IS safe here — every spec gets its own mkdtemp workspace,
	// its own dynamically-allocated ports, and passes `--new` (so concurrent
	// launchers never reap each other).
	//
	// 2, not more: the serial suite used under one core of fifteen, and 2 cuts it
	// ~2.5x (369s -> 142-201s) green across repeated full runs. 4 was NOT faster
	// (the makespan is bound by a few long spec files) and broke four
	// timing-sensitive real-kernel specs. Do not raise it without first splitting
	// those into their own workers:1 project. See
	// data/cellar-test-timing-scout-t7/report.md.
	//
	// This used to read `process.env.CI ? 1 : 2`, and that `1` was NOT a measured
	// guard — it is the file's original unconditional default (#47 added the `: 2`
	// for local runs and left the CI branch as it found it) on a branch that had
	// never once executed, because e2e did not run in CI until .github/workflows/
	// e2e.yml. So there is nothing to preserve: the honest default is the same
	// value on both, and `CELLAR_E2E_WORKERS` is where CI states its own. The
	// suite is latency-bound rather than CPU-bound (MEASURED: user 583s + sys 215s
	// across a 1191s serial wall ≈ 0.67 of one core), which is why a 4-vCPU runner
	// takes more than one worker without becoming CPU-starved — but it is ALSO why
	// it is sensitive to contention, so raise the env var on evidence, not hope.
	fullyParallel: false,
	workers: Number(process.env.CELLAR_E2E_WORKERS) || 2,
	retries: 0,
	reporter: [['list']],
	use: {
		trace: 'retain-on-failure'
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]
});
