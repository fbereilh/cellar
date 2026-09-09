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
 * spec took 65s all-fail versus 2.5s all-pass).
 *
 * These pin the behaviour of the shared guard plus the wiring that decides WHERE
 * it runs, and e2e is deliberately absent from both CI and the no-mistakes gate, so
 * a unit-level assertion is the only thing that sees a regression here. Everything
 * that CAN be driven is driven: playwright's config, its `globalSetup` module and
 * the harness are all ordinary importable modules, so the wiring is asserted by
 * calling it against a fixture repo rather than by grepping for a shape. The one
 * exception is the launcher's own message, which lives inside a CLI with no
 * importable seam.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureFreshBuild } from '../../scripts/ensure-build.js';
import globalSetup from '../../tests/e2e/global-setup';
import { bootDiagnostic, BOOT_TIMEOUT_MS } from '../../tests/e2e/harness';
import playwrightConfig from '../../playwright.config';

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

/**
 * Fixture builders, so each wiring case states the build state it is about.
 * `build: 'exit 3'` throughout: a rebuild attempt is then visible as a failure,
 * which is what proves the fresh path never spawns one.
 */
function fixtureFresh(): string {
	writeAt(join(repo, 'package.json'), JSON.stringify({ scripts: { build: 'exit 3' } }), OLD);
	writeAt(join(repo, 'src', 'a.ts'), 'export const a = 1;', OLD);
	freezeSrc(OLD);
	writeAt(join(repo, 'build', 'index.js'), '// built', NEW);
	return repo;
}
function fixtureIncomplete(): string {
	fixtureFresh();
	rmSync(join(repo, 'build', 'client'), { recursive: true, force: true });
	return repo;
}
function fixtureStale(): string {
	writeAt(join(repo, 'package.json'), JSON.stringify({ scripts: { build: 'exit 3' } }), OLD);
	writeAt(join(repo, 'build', 'index.js'), '// built', OLD);
	writeAt(join(repo, 'src', 'a.ts'), 'export const a = 1;', NEW);
	return repo;
}

describe('where the guard is wired', () => {
	it('playwright runs the guard module in globalSetup, so a bare `npx playwright test` cannot skip it', async () => {
		// The config's own value, resolved and imported: proves it names a real
		// module, and that the module is the very one whose abort behaviour the
		// cases below drive. A source grep would pass for a commented-out line.
		const named = playwrightConfig.globalSetup;
		expect(typeof named).toBe('string');
		const mod = await import(pathToFileURL(resolve(REPO, String(named))).href);
		expect(typeof mod.default).toBe('function');
		expect(mod.default).toBe(globalSetup);
	});

	it('is not ALSO an npm hook — one guard, not two walks per `npm run test:e2e`', () => {
		expect(JSON.parse(read('package.json')).scripts).not.toHaveProperty('pretest:e2e');
	});

	it('globalSetup ABORTS the run when the build cannot be made good', () => {
		// Thrown, not logged: an aborted run says why on line one, where a run that
		// went ahead and failed 300 assertions never would. And the reason names the
		// CAUSE plus the fix, not just "the build failed".
		let thrown: unknown = null;
		try {
			globalSetup(undefined, { repo: fixtureIncomplete(), log: () => {} });
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(Error);
		const message = (thrown as Error).message;
		expect(message).toMatch(/incomplete/i);
		expect(message).toContain('build/client');
		expect(message).toContain('npm run build');
	});

	it('globalSetup lets a fresh build through without spawning a rebuild', () => {
		expect(() => globalSetup(undefined, { repo: fixtureFresh(), log: () => {} })).not.toThrow();
	});

	it('a failed boot names the BUILD, not just the exit code', () => {
		// The whole point of the diagnostic: `launcher exited early (1)` on its own
		// sends the reader into the launcher's source, while the build verdict says
		// what to do. The incomplete case is the one that matters most — the entry
		// point is present, so the launcher boots and the failure looks unrelated.
		const said = bootDiagnostic('[cellar] workspace: /tmp/ws\nboom\n', fixtureIncomplete());
		expect(said).toMatch(/incomplete/i);
		expect(said).toContain('build/client');
		expect(said).toContain('npm run build');
		expect(said).toContain('boom');
	});

	it('a failed boot names a STALE build too', () => {
		const said = bootDiagnostic('boom\n', fixtureStale());
		expect(said).toMatch(/STALE/);
		expect(said).toContain('src');
	});

	it('claims nothing about the build when the build is fine, and still quotes the launcher', () => {
		// Over-reporting is the failure mode here: a boot that died for its own
		// reasons must not be blamed on a build that is provably good.
		const lines = Array.from({ length: 12 }, (_, i) => `line-${i + 1}`).join('\n');
		const said = bootDiagnostic(lines, fixtureFresh());
		expect(said).not.toMatch(/build:/);
		// The TAIL, so a launcher that talked for a whole spec file does not bury it.
		expect(said).toContain('line-12');
		expect(said).not.toContain('line-1\n');
	});

	it('bounds the launcher boot at 60s, and lets a cold machine raise it', async () => {
		expect(BOOT_TIMEOUT_MS).toBe(60_000);
		vi.stubEnv('CELLAR_E2E_BOOT_TIMEOUT_MS', '120000');
		vi.resetModules();
		try {
			const reloaded = await import('../../tests/e2e/harness');
			expect(reloaded.BOOT_TIMEOUT_MS).toBe(120_000);
		} finally {
			vi.unstubAllEnvs();
			vi.resetModules();
		}
	});

	it('the launcher names the ABSENT artifact, not a file that is sitting right there', () => {
		// `assertUsableBuild` lives inside the CLI, which runs on import and resolves
		// its repo from its own location, so there is no seam to drive: this is the
		// one source-shaped check here. What it guards is that the launcher routes
		// through missingReason() — whose two messages ARE driven, in
		// tests/unit/build-freshness.test.ts.
		const src = read('bin/cellar.js');
		expect(src).toMatch(/missingReason\(REPO, freshness\)/);
		expect(src).not.toMatch(/production build not found at \$\{freshness\.buildEntry\}/);
	});
});
