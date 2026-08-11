import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Vitest runs the server-side unit tests (pure Node, no browser, no kernel).
// It deliberately does NOT load the SvelteKit vite plugin: these tests import
// server modules by relative path and exercise pure logic, so booting the full
// app toolchain would only add cost and flakiness. esbuild (via vite) handles
// the TypeScript sources directly. The consequence: a Svelte component cannot be
// MOUNTED here - component behavior is proved in the Playwright E2E suite, and an
// invariant that is one expression wide gets a source guard instead (see
// tests/unit/html-preview.test.ts, html-output-style.test.ts, dataframe-grid.test.ts).
export default defineConfig({
	// Some server modules import siblings via SvelteKit's `$lib` alias; map it to
	// `src/lib` so those modules load under vitest (which skips the SvelteKit plugin).
	// `$app/environment` is stubbed so a `.svelte.ts` module (e.g. the shortcut
	// registry) whose PURE data/logic we test can import without the SvelteKit app.
	resolve: {
		alias: {
			$lib: fileURLToPath(new URL('./src/lib', import.meta.url)),
			'$app/environment': fileURLToPath(new URL('./tests/setup/app-environment.ts', import.meta.url))
		}
	},
	test: {
		// Only the unit suite; the Playwright E2E lives under tests/e2e and is run
		// by its own runner (`npm run test:e2e`), never by vitest.
		include: ['tests/unit/**/*.test.ts'],
		environment: 'node',
		// Load-time shim so `.svelte.ts` modules using runes at module scope import
		// under the plugin-less unit runner (see tests/setup/runes-shim.ts).
		setupFiles: ['./tests/setup/runes-shim.ts'],
		// Vitest's 5s default is a WALL-CLOCK budget written for a quiet machine, and
		// a large part of this suite drives real subprocesses (the python dataflow and
		// databricks probes, `git`, the SDK) and real timers. The suite runs ~140 files
		// across `cpus - 1` forks, and those forks each spawn again, so a correct-but-
		// contended test legitimately spends 10-20x its idle time - which surfaced as a
		// vitest timeout in whichever file happened to be scheduled alongside the
		// heaviest ones, rotating run to run. That is arithmetic in the harness, not a
		// defect in the code under test, so the allowance is the repo's existing
		// real-subprocess one (see databricks-logout.test.ts) applied by default rather
		// than per test. A genuinely hung test still fails; it just no longer fails
		// merely for being scheduled next to `git worktree`.
		testTimeout: 30_000,
		hookTimeout: 30_000
	}
});
