/**
 * The e2e build guard runs for EVERY playwright invocation, and exactly once.
 *
 * A bare `npx playwright test <spec>` - the shape a developer or an agent types
 * when iterating on one spec - used to bypass the guard entirely, because it lived
 * in the `pretest:e2e` npm hook. What that bought was one of two bad runs: a stale
 * or absent build makes the launcher refuse, so every spec fails with
 * `launcher exited early (1)` and the reason is buried in interleaved stdout; an
 * INCOMPLETE build passes the mtime comparison, so the launcher boots and each
 * test burns its assertion timeout on a misleading failure (MEASURED: a 3-test
 * spec took 104s all-fail versus 8.8s all-pass).
 *
 * These pin the behaviour of the shared guard plus the wiring that decides WHERE
 * it runs. The wiring half is source-shaped on purpose: playwright's config is not
 * loadable here, and e2e is deliberately absent from both CI and the no-mistakes
 * gate, so a unit-level assertion is the only thing that sees a regression.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureFreshBuild } from '../../scripts/ensure-build.js';

const REPO = resolve(fileURLToPath(import.meta.url), '../../..');
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');

let repo: string;

beforeEach(() => {
	repo = mkdtempSync(join(tmpdir(), 'cellar-e2e-guard-'));
	mkdirSync(join(repo, 'src'), { recursive: true });
	mkdirSync(join(repo, 'build', 'client'), { recursive: true });
	mkdirSync(join(repo, '.git'));
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

/** Stamp mtimes explicitly so the fixtures never race the filesystem clock. */
function writeAt(path: string, contents: string, seconds: number) {
	writeFileSync(path, contents);
	utimesSync(path, seconds, seconds);
}
const OLD = 1_000_000;
const NEW = 2_000_000;

/**
 * Writing a file leaves its containing directory at wall-clock time, and the
 * classifier folds directory mtimes in (that is what catches a delete-only
 * source change), so a fixture has to stamp them too.
 */
function freezeSrc(seconds: number) {
	utimesSync(join(repo, 'src'), seconds, seconds);
}

describe('ensureFreshBuild', () => {
	it('is a NO-OP on a fresh build — a re-run loop pays a directory walk, not a rebuild', () => {
		// `build` here would exit non-zero, so an ok:true/rebuilt:false verdict is
		// proof it was never spawned: this is what keeps `npm run test:e2e` at its
		// old cost now that the guard moved into every invocation.
		writeAt(join(repo, 'package.json'), JSON.stringify({ scripts: { build: 'exit 3' } }), OLD);
		writeAt(join(repo, 'src', 'a.ts'), 'export const a = 1;', OLD);
		freezeSrc(OLD);
		writeAt(join(repo, 'build', 'index.js'), '// built', NEW);

		expect(ensureFreshBuild({ repo, log: () => {} })).toMatchObject({ ok: true, rebuilt: false });
	});

	it('reports a FAILED rebuild rather than letting the run start on a bad build', () => {
		writeAt(join(repo, 'package.json'), JSON.stringify({ scripts: { build: 'exit 3' } }), OLD);
		writeAt(join(repo, 'build', 'index.js'), '// built', OLD);
		writeAt(join(repo, 'src', 'a.ts'), 'export const a = 1;', NEW);

		const outcome = ensureFreshBuild({ repo, log: () => {} });
		expect(outcome.ok).toBe(false);
		// The reason names the CAUSE, not just "the build failed": a run aborted
		// with "timed out" sends you reading source, one naming staleness does not.
		expect(outcome.reason).toMatch(/stale/i);
		// …and it names the source that outran the build, not just "something".
		expect(outcome.reason).toMatch(/src/);
	});

	it('names an INCOMPLETE build for what it is', () => {
		writeAt(join(repo, 'package.json'), JSON.stringify({ scripts: { build: 'exit 3' } }), OLD);
		writeAt(join(repo, 'build', 'index.js'), '// built', NEW);
		rmSync(join(repo, 'build', 'client'), { recursive: true, force: true });

		const outcome = ensureFreshBuild({ repo, log: () => {} });
		expect(outcome.ok).toBe(false);
		expect(outcome.reason).toMatch(/incomplete/i);
		expect(outcome.reason).toContain('build/client');
	});
});

describe('where the guard is wired', () => {
	it('playwright runs it in globalSetup, so a bare `npx playwright test` cannot skip it', () => {
		expect(read('playwright.config.ts')).toMatch(
			/globalSetup:\s*'\.\/tests\/e2e\/global-setup\.ts'/
		);
	});

	it('is not ALSO an npm hook — one guard, not two walks per `npm run test:e2e`', () => {
		expect(JSON.parse(read('package.json')).scripts).not.toHaveProperty('pretest:e2e');
	});

	it('globalSetup ABORTS the run when the build cannot be made good', () => {
		const src = read('tests/e2e/global-setup.ts');
		expect(src).toContain('ensureFreshBuild(');
		// Thrown, not logged: an aborted run says why on line one, where a run that
		// went ahead and failed 300 assertions never would.
		expect(src).toMatch(/if\s*\(!outcome\.ok\)[\s\S]{0,200}throw new Error/);
	});

	it('bounds the launcher boot and says WHY it failed', () => {
		const src = read('tests/e2e/harness.ts');
		// A bound, not the old bare 90_000 literal, and overridable for a cold cache.
		expect(src).toMatch(/BOOT_TIMEOUT_MS\s*=\s*Number\(process\.env\.CELLAR_E2E_BOOT_TIMEOUT_MS\)/);
		expect(src).toMatch(/\|\|\s*60_000/);
		expect(src).not.toContain('90_000');
		// Both failure paths (timeout AND early exit) carry the diagnostic: the
		// build verdict plus the tail of what the launcher actually said.
		expect(src).toMatch(/bootDiagnostic\(buf\)/);
		expect(src).toMatch(/proc\.on\('exit',\s*\(code\)\s*=>\s*fail\(/);
	});
});
