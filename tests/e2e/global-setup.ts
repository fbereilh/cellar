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
 *     failure. MEASURED: a 2-test spec took 65s all-fail versus 2.5s all-pass.
 *
 * Running the same one guard here covers EVERY invocation, and it is the only
 * place it runs — see scripts/ensure-build.js.
 */
import { ensureFreshBuild } from '../../scripts/ensure-build.js';
import { runtimeMissing } from './harness.js';

/**
 * Opt-in: REFUSE to run rather than skip when the kernel runtime is absent.
 *
 * Every spec is guarded by `test.skip(!runtimeAvailable(), …)`, which is right
 * for a developer machine without `uv` - the suite says so and gets out of the
 * way. It is exactly wrong for CI, where Playwright exits **0** for a run in
 * which every spec skipped: a job whose provisioning silently broke (a cache
 * miss, a `uv` install failure, a changed runner image) becomes a permanently
 * green required check that runs zero tests. MEASURED before this guard existed:
 *
 *     D=$(mktemp -d); HOME=$D npx playwright test tests/e2e/smoke.spec.ts; echo $?
 *     → 1 skipped
 *     → 0
 *
 * That is strictly worse than having no job, because it manufactures assurance.
 * So `.github/workflows/e2e.yml` sets this and the run aborts before a single
 * spec is collected.
 *
 * It is its OWN env var rather than a branch on `CI` for two reasons: a fork or
 * a contributor's CI may legitimately not provision the runtime and should keep
 * the skip, and gating on `CI` would make the guard untestable locally - which
 * is the whole point of a guard whose failure mode is silence.
 */
export const REQUIRE_RUNTIME_ENV = 'CELLAR_E2E_REQUIRE_RUNTIME';

/**
 * Throw naming what is missing, when the caller asked for the runtime to be
 * mandatory. A pure-ish function of (env, machine), exported so a unit test can
 * drive both branches without a Playwright run.
 */
export function assertRuntimePresent(env: NodeJS.ProcessEnv = process.env): void {
	if (!env[REQUIRE_RUNTIME_ENV]) return;
	const missing = runtimeMissing(env);
	if (!missing.length) return;
	throw new Error(
		`[cellar] e2e aborted before any spec ran: ${REQUIRE_RUNTIME_ENV} is set, but the ` +
			`kernel runtime is incomplete.\n` +
			missing.map((m) => `  - missing: ${m}`).join('\n') +
			'\nEvery spec skips itself when the runtime is absent and Playwright exits 0 for a ' +
			'fully-skipped run, so without this the job would have reported success having ' +
			'executed nothing. Provision the runtime (see .github/workflows/e2e.yml) and re-run.'
	);
}

/**
 * Playwright calls this with its resolved config, which this hook has no use for.
 * The second parameter is the `ensureFreshBuild` options seam: it lets a unit test
 * drive BOTH branches against a fixture repo rather than the real checkout, so the
 * abort is pinned as behaviour instead of as a shape in this file's source.
 */
export default function globalSetup(
	_config?: unknown,
	opts?: { repo?: string; log?: (msg: string) => void; env?: NodeJS.ProcessEnv }
): void {
	// Runtime first: a missing runtime makes every result meaningless in a way a
	// fresh build cannot rescue, and it is the cheaper check of the two.
	assertRuntimePresent(opts?.env);
	const outcome = ensureFreshBuild(opts);
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
