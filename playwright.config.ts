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
 */
export default defineConfig({
	testDir: './tests/e2e',
	// Kernel boot + cell execution is inherently slower than a pure-web test.
	timeout: 120_000,
	expect: { timeout: 30_000 },
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
	fullyParallel: false,
	workers: process.env.CI ? 1 : 2,
	retries: 0,
	reporter: [['list']],
	use: {
		trace: 'retain-on-failure'
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]
});
