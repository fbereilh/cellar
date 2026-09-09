/**
 * The e2e suite gates every PR, and three things have to hold for that gate to
 * mean anything. All three fail SILENTLY, which is why they are pinned here
 * rather than left to the workflow.
 *
 *   1. A missing kernel runtime must ABORT, not skip. Every spec carries
 *      `test.skip(!runtimeAvailable(), …)` and Playwright exits 0 for a run in
 *      which everything skipped, so a job whose provisioning broke reports
 *      success having executed nothing. MEASURED before the guard existed:
 *        D=$(mktemp -d); HOME=$D npx playwright test tests/e2e/smoke.spec.ts
 *        → 1 skipped, exit 0
 *      That is worse than having no job, because it manufactures assurance.
 *
 *   2. Sharding must split at SPEC-FILE granularity. Tests inside a file share
 *      one launcher, one workspace and one kernel and must stay ordered
 *      (`fullyParallel: false`); a file split across two shards would run half
 *      its tests against a launcher that never executed the other half's setup,
 *      which surfaces as flakiness rather than as an obvious error.
 *
 *   3. The workflow must actually enable (1). A guard nothing turns on is not a
 *      guard, and it is the same silence in a different place.
 *
 * Everything here is DRIVEN against the real modules where it can be. The two
 * assertions that must read the workflow YAML read it through the exported
 * constants rather than repeating literals, so a rename breaks the test instead
 * of quietly unwiring the thing it names.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import globalSetup, {
	assertRuntimePresent,
	REQUIRE_RUNTIME_ENV
} from '../../tests/e2e/global-setup';
import { runtimeAvailable, runtimeMissing } from '../../tests/e2e/harness';

const REPO = resolve(fileURLToPath(import.meta.url), '../../..');
const workflow = () => readFileSync(join(REPO, '.github/workflows/e2e.yml'), 'utf8');

/** A HOME with no `.cellar/host-venv` under it — the cold-runner shape. */
const emptyHome = () => mkdtempSync(join(tmpdir(), 'cellar-nohome-'));

/**
 * A PATH carrying `node` (so the process can still function) but not the tool
 * under test, which is how a runner that failed to install `uv` really looks.
 */
function pathWithout(omit: 'uv' | 'python3'): string {
	const dir = mkdtempSync(join(tmpdir(), 'cellar-path-'));
	for (const tool of ['node', 'uv', 'python3']) {
		if (tool === omit) continue;
		const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' });
		const bin = found.stdout.trim();
		if (bin) symlinkSync(bin, join(dir, tool));
	}
	return dir;
}

describe('the runtime guard turns a vacuous skip into a failure', () => {
	it('is INERT unless the caller asks for it — a dev machine without uv keeps the skip', () => {
		// The reason this is opt-in rather than a branch on CI: a fork, or a
		// contributor's own CI, may legitimately not provision the runtime, and a
		// guard that cannot be switched off would make the suite unrunnable there.
		expect(() => assertRuntimePresent({ ...process.env, HOME: emptyHome() })).not.toThrow();
	});

	it('ABORTS naming the host venv when it is missing, and names the fix', () => {
		const home = emptyHome();
		let thrown: unknown = null;
		try {
			assertRuntimePresent({ ...process.env, [REQUIRE_RUNTIME_ENV]: '1', HOME: home });
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(Error);
		const message = (thrown as Error).message;
		// Names the missing thing, where it should be, and how to create it — the
		// only reader who ever sees this is somebody fixing a runner.
		expect(message).toContain(join(home, '.cellar', 'host-venv'));
		expect(message).toContain('scripts/ensure-e2e-runtime.js');
		// And says WHY a green run would otherwise have been wrong, because the
		// failure it prevents is invisible by construction.
		expect(message).toMatch(/exits 0|executed nothing/i);
	});

	it.each(['uv', 'python3'] as const)('ABORTS naming %s when it is off PATH', (tool) => {
		expect(() =>
			assertRuntimePresent({
				...process.env,
				[REQUIRE_RUNTIME_ENV]: '1',
				PATH: pathWithout(tool)
			})
		).toThrow(new RegExp(`missing: ${tool}`));
	});

	it('lets a complete runtime through', () => {
		// Guarded on the real machine having one, because the point of the case is
		// that a PRESENT runtime does not abort — asserting that against a faked
		// absence would be vacuous. Skipped rather than faked so the suite stays
		// green on a machine without uv.
		if (!runtimeAvailable()) return;
		expect(() =>
			assertRuntimePresent({ ...process.env, [REQUIRE_RUNTIME_ENV]: '1' })
		).not.toThrow();
	});

	it('runs from globalSetup, BEFORE the build check', () => {
		// Ordering matters for the message the reader gets: a runner with no
		// runtime usually also has no build, and "your build is stale" would send
		// them to fix the wrong thing. `repo` points at a directory with no build
		// at all, so the build check would certainly fail if it were reached.
		const nothing = mkdtempSync(join(tmpdir(), 'cellar-norepo-'));
		mkdirSync(join(nothing, '.git'));
		expect(() =>
			globalSetup(undefined, {
				repo: nothing,
				log: () => {},
				env: { ...process.env, [REQUIRE_RUNTIME_ENV]: '1', HOME: emptyHome() }
			})
		).toThrow(new RegExp(REQUIRE_RUNTIME_ENV));
	});

	it('states the rule ONCE — runtimeAvailable is a projection of runtimeMissing', () => {
		// The two are read by different callers (the per-spec skip, and the CI
		// abort). A second copy of the predicate is precisely how the job comes to
		// run zero tests while reporting success, so they must not merely agree
		// today — one must be defined in terms of the other.
		expect(runtimeAvailable()).toBe(runtimeMissing().length === 0);
	});
});

describe('the workflow enables the guard it depends on', () => {
	it('sets the require-runtime variable', () => {
		// Read through the exported constant: renaming it must break this test
		// rather than silently leaving the workflow setting a variable nothing
		// reads, which is the same green-and-empty run one step removed.
		expect(workflow()).toContain(REQUIRE_RUNTIME_ENV);
	});

	it('runs on pull_request — the gate is the whole point', () => {
		expect(workflow()).toMatch(/^on:\n(?:.*\n)*?\s{2}pull_request:/m);
	});

	it('does not let one red shard cancel the others', () => {
		// A cancelled sibling reports neither pass nor fail, so `fail-fast: true`
		// would make the suite's pass rate unmeasurable exactly when it matters.
		expect(workflow()).toMatch(/fail-fast:\s*false/);
	});
});

describe('sharding splits whole spec files', () => {
	it('gives every file to exactly one shard, and covers them all', () => {
		// Driven through Playwright's real sharder rather than asserted from its
		// docs: this is a behaviour of the installed version, and a change to it
		// would break the suite as flakiness rather than as an error. `--list`
		// collects without running, so this costs no launcher boots.
		const SHARDS = 6;
		const seen = new Map<string, number[]>();
		for (let i = 1; i <= SHARDS; i++) {
			const out = spawnSync(
				'npx',
				['playwright', 'test', `--shard=${i}/${SHARDS}`, '--list'],
				{ cwd: REPO, encoding: 'utf8', timeout: 120_000 }
			);
			expect(out.status, `--shard=${i}/${SHARDS} --list failed:\n${out.stderr}`).toBe(0);
			for (const m of out.stdout.matchAll(/›\s+(\S+\.spec\.ts):/g)) {
				const shards = seen.get(m[1]) ?? [];
				if (!shards.includes(i)) shards.push(i);
				seen.set(m[1], shards);
			}
		}
		const split = [...seen].filter(([, shards]) => shards.length > 1);
		expect(split, 'a spec file was split across shards').toEqual([]);
		// And nothing was dropped: the union is every spec file on disk.
		const onDisk = spawnSync('sh', ['-c', 'ls tests/e2e/*.spec.ts | wc -l'], {
			cwd: REPO,
			encoding: 'utf8'
		});
		expect(seen.size).toBe(Number(onDisk.stdout.trim()));
	});
});
