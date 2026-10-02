import { test, expect } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';
import { alive, appPidOf, grandchildPid, installStubClaude, openChatNotebook, reapPids } from './chat-run-fixture';

/**
 * An app KILLED OUTRIGHT must not orphan its chat tree for good: the next launch
 * reaps it.
 *
 * ## Why this exists beside `chat-shutdown-hangup.spec.ts`
 *
 * A chat child leads a session of its own (that is what lets Stop reach the whole
 * tree), so the only things that stop it when the app goes away are the app's own
 * signal handlers. A SIGKILL runs none of them - nor does an OOM kill or a crash -
 * so before the on-disk registry (`src/lib/server/chat-run-registry.js`) such a
 * tree ran on in a session nothing would ever signal, and nothing recorded that it
 * was there. This drives the real thing end to end: a real launcher, a real
 * browser starting a real chat run whose CLI has a real descendant, the app
 * SIGKILLed by pid, and a SECOND real launch in the same folder.
 *
 * ## What makes it discriminating
 *
 * The CONTROL in the middle: after the SIGKILL, and with the first launcher gone,
 * the leader and its descendant are asserted STILL ALIVE. Without that the final
 * "they are gone" could be satisfied by the tree dying of its own accord (a broken
 * pipe, a stub that exits), which would prove nothing about the reaper. Only the
 * second launch can account for the deaths after that point.
 *
 * Both launches use the harness's workspace-scoped `CELLAR_CHAT_RUNS_DIR`, so the
 * sweep here never reads, let alone signals, a record of whoever runs the suite.
 * `CELLAR_ISOLATED` is cleared explicitly: an isolated launch records and sweeps
 * nothing, so an environment that sets it would turn this into a silent no-op.
 */

const NB = 'chat-orphan.ipynb';

let first: ChildProcess | null = null;
let second: ChildProcess | null = null;
let workspace = '';
const started: number[] = [];

test.beforeAll(() => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available - E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-chat-orphan-e2e-'));
	installStubClaude(workspace, join(workspace, 'grandchild.pid'));
});

test.afterAll(() => {
	for (const l of [first, second]) if (l) killCellar(l);
	first = second = null;
	reapPids(started);
	if (workspace && existsSync(workspace)) {
		try {
			rmSync(workspace, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
});

/** The records the app wrote for its chat process groups. */
function records(): Array<{ path: string; record: { pgid: number; ownerPid: number } }> {
	const dir = join(workspace, '.cellar', 'chat-runs');
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((n) => n.endsWith('.json') && !n.startsWith('.'))
		.map((n) => ({ path: join(dir, n), record: JSON.parse(readFileSync(join(dir, n), 'utf8')) }));
}

test('a SIGKILLed app leaves its chat tree behind, and the next launch reaps it', async ({ page }) => {
	test.setTimeout(240_000);
	const env = { CELLAR_CHAT_SLOTS: join(workspace, 'chat-slots'), CELLAR_ISOLATED: '' };

	const booted = await bootCellar(workspace, env);
	first = booted.proc;
	const launcherPid = first.pid as number;
	const appPid = appPidOf(launcherPid);

	const chat = await openChatNotebook(page, { baseURL: booted.url, workspace, name: NB });
	await chat.getByTestId('run').click();
	await expect(chat.getByTestId('running-indicator')).toBeVisible({ timeout: 60_000 });
	const gc = await grandchildPid(join(workspace, 'grandchild.pid'), started);

	// RECORDED, durably, by the app that owns it - before anything goes wrong.
	await expect.poll(() => records().length, { timeout: 10_000 }).toBe(1);
	const [{ path, record }] = records();
	const leader = record.pgid;
	started.push(leader);
	expect(record.ownerPid).toBe(appPid);
	expect(alive(leader)).toBe(true);

	// The death no handler sees.
	process.kill(appPid, 'SIGKILL');
	await expect.poll(() => alive(appPid), { timeout: 10_000 }).toBe(false);
	// The launcher shuts itself down once its app is gone; wait for that, so the
	// second launch is not a take-over of a live instance.
	await expect.poll(() => alive(launcherPid), { timeout: 30_000 }).toBe(false);
	first = null;

	// CONTROL: the tree really is orphaned. Nothing left in the old instance can
	// reach it, and it is not dying on its own.
	await page.waitForTimeout(1_000);
	expect(alive(leader)).toBe(true);
	expect(alive(gc)).toBe(true);
	expect(existsSync(path)).toBe(true);

	// The next launch in the same folder sweeps the registry before it serves.
	second = (await bootCellar(workspace, env)).proc;

	await expect.poll(() => alive(leader), { timeout: 10_000 }).toBe(false);
	await expect.poll(() => alive(gc), { timeout: 10_000 }).toBe(false);
	expect(existsSync(path)).toBe(false);
});
