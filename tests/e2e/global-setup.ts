/**
 * Playwright `globalSetup`: no spec runs against a build that cannot be trusted.
 *
 * The e2e harness boots the REAL launcher without `--dev`, so every spec exercises
 * `build/index.js`. That guard used to live in the `pretest:e2e` npm hook, which
 * meant it only ran when someone went through npm — a bare
 * `npx playwright test <spec>`, the shape a developer or an agent types when
 * iterating on ONE spec, bypassed it entirely and got one of two bad runs:
 *
 *   - a STALE or ABSENT build → the launcher refuses to serve it, so every spec
 *     fails with `launcher exited early (1)` and the real reason is buried in
 *     interleaved launcher stdout rather than in the failure;
 *   - an INCOMPLETE build (`build/client` gone, a `vite build` killed part-way) →
 *     which passes the mtime comparison, so the launcher boots, the pages are
 *     broken, and each test burns its full assertion timeout on a misleading
 *     failure. MEASURED: a 3-test spec took 104s all-fail versus 8.8s all-pass.
 *
 * Running the same one guard here covers EVERY invocation, and it is the only
 * place it runs — see scripts/ensure-build.js.
 */
import { ensureFreshBuild } from '../../scripts/ensure-build.js';

export default function globalSetup(): void {
	const outcome = ensureFreshBuild();
	if (!outcome.ok) {
		// Thrown, not logged: an aborted run says why on line one, where a run that
		// went ahead and failed 300 assertions never would.
		throw new Error(
			`[cellar] e2e aborted before any spec ran: ${outcome.reason}.\n` +
				'Every spec boots the real launcher against build/index.js, so a build that is ' +
				'stale, absent or incomplete makes every result meaningless. Fix the build ' +
				'(`npm run build`) and re-run.'
		);
	}
}
