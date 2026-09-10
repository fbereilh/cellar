#!/usr/bin/env node
/**
 * Provision the kernel runtime the e2e suite needs, before Playwright starts.
 *
 * The suite boots the REAL launcher, which needs `uv`, `python3` and cellar's
 * private Jupyter host env at `~/.cellar/host-venv`. The first two are the
 * runner image's job (see .github/workflows/e2e.yml); the third is cellar's,
 * and the launcher creates it lazily on its first boot.
 *
 * Lazy is too late here. `tests/e2e/harness.ts`'s `runtimeAvailable()` reads
 * `~/.cellar/host-venv/bin/python` with `existsSync` at the moment the first
 * test runs, so on a cold runner EVERY spec would evaluate that as absent and
 * skip - before the launcher that would have created it ever booted. So the
 * venv is created UP FRONT, here.
 *
 * It calls the launcher's own `ensureHostEnv` rather than replaying `uv venv` +
 * `uv pip install jupyter-server` + the `.cellar-host-ready` marker, because a
 * second copy of that sequence would drift from the one the launcher checks -
 * and a venv missing only the marker is one the launcher silently rebuilds,
 * which would put a 20-40s install back into the first spec's boot timeout.
 *
 * Idempotent by construction: `ensureHostEnv` returns immediately when the
 * interpreter and the marker are both already there, so a restored cache costs
 * two `existsSync` calls.
 */
import { ensureHostEnv } from '../src/lib/server/venv.js';

try {
	const { hostVenv, created } = await ensureHostEnv({ stdio: 'inherit' });
	console.log(`[cellar] host venv ${created ? 'created' : 'already present'}: ${hostVenv}`);
} catch (err) {
	// Fail loudly and immediately. Left to the lazy path this surfaces much later
	// as ~90 fully-skipped spec files and a green run, which is the exact outcome
	// the CELLAR_E2E_REQUIRE_RUNTIME guard exists to make impossible.
	console.error(`[cellar] could not provision the e2e kernel runtime: ${err?.message ?? err}`);
	process.exit(1);
}
