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
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: [['list']],
	use: {
		trace: 'retain-on-failure'
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]
});
