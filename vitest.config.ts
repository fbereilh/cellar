import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Vitest runs the server-side unit tests (pure Node, no browser, no kernel).
// It deliberately does NOT load the SvelteKit vite plugin: these tests import
// server modules by relative path and exercise pure logic, so booting the full
// app toolchain would only add cost and flakiness. esbuild (via vite) handles
// the TypeScript sources directly.
export default defineConfig({
	// Some server modules import siblings via SvelteKit's `$lib` alias; map it to
	// `src/lib` so those modules load under vitest (which skips the SvelteKit plugin).
	resolve: {
		alias: {
			$lib: fileURLToPath(new URL('./src/lib', import.meta.url))
		}
	},
	test: {
		// Only the unit suite; the Playwright E2E lives under tests/e2e and is run
		// by its own runner (`npm run test:e2e`), never by vitest.
		include: ['tests/unit/**/*.test.ts'],
		environment: 'node'
	}
});
