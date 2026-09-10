import { test, expect } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';
import { alive, grandchildPid, installStubClaude, openChatNotebook, reapPids } from './chat-run-fixture';

/**
 * Pressing Stop on a running chat cell, as a HUMAN does it - and what must be
 * true afterwards, at BOTH levels the bug lived at.
 *
 * ## What this is a regression test for
 *
 * The chain from the Stop control to the engine's kill was already wired; the
 * kill was `child.kill()`, which signals ONE pid. The claude CLI spawns its own
 * children, and those survived: MEASURED in this exact setup before the fix, a
 * descendant of a stopped chat run was still alive after the click, after the
 * run settled, and after Cellar's own shutdown - while the spinner kept
 * spinning for 5.3s because that descendant held the inherited stdout pipe and
 * the run could only settle on a 5s force-settle timer.
 *
 * So the two assertions that matter are not interchangeable and both are here:
 * the spinner clears PROMPTLY, and the process is GONE. A UI-only check passes
 * against a build that leaks; a process-only check passes against one that
 * leaves the user watching a spinner.
 *
 * The CLI stub, and why it does not weaken any of that, is documented once at
 * `installStubClaude` in `./chat-run-fixture` - shared with the hang-up spec so
 * the run-with-a-real-descendant shape has exactly one home.
 *
 * Gated only on the kernel runtime `bootCellar` needs - the stub answers
 * `auth status` too, so no signed-in `claude` is required.
 */

// A name of its own, never the canonical `notebook.ipynb`: the shell opens that
// one by itself, so a tree click on it is not the plain open this helper assumes.
const NB = 'chat-stop.ipynb';

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';
/** Every descendant pid a test learned about, killed at teardown come what may. */
const started: number[] = [];

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available - E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-chat-stop-e2e-'));
	installStubClaude(workspace, join(workspace, 'grandchild.pid'));
	const booted = await bootCellar(workspace, { CELLAR_CHAT_SLOTS: join(workspace, 'chat-slots') });
	launcher = booted.proc;
	baseURL = booted.url;
});

test.afterAll(() => {
	if (launcher) killCellar(launcher);
	launcher = null;
	// A leaked descendant is what this spec is about, so never leave one behind
	// even when a case failed.
	reapPids(started);
	if (workspace && existsSync(workspace)) {
		try {
			rmSync(workspace, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
});

test('Stop ends the run promptly and leaves nothing of it running', async ({ page }) => {
	test.setTimeout(180_000);
	const pidfile = join(workspace, 'grandchild.pid');
	rmSync(pidfile, { force: true });
	const chat = await openChatNotebook(page, { baseURL, workspace, name: NB });

	await chat.getByTestId('run').click();
	await expect(chat.getByTestId('running-indicator')).toBeVisible({ timeout: 60_000 });

	// The CLI has a child of its own, and it is running.
	const gc = await grandchildPid(pidfile, started);
	expect(alive(gc)).toBe(true);

	const stop = chat.getByTestId('cell-interrupt');
	await expect(stop).toBeVisible();
	const clickedAt = Date.now();
	await stop.click();

	// PROMPTLY: the running affordance goes. The old force-settle floor was 5s,
	// so this bound fails the pre-fix shape while staying generous enough for a
	// loaded machine - it is the user-visible half of "stop means stop".
	await expect(chat.getByTestId('running-indicator')).toHaveCount(0, { timeout: 4_000 });
	expect(Date.now() - clickedAt).toBeLessThan(4_000);

	// NOTHING LEFT RUNNING: the descendant the CLI started is gone.
	await expect.poll(() => alive(gc), { timeout: 15_000 }).toBe(false);

	// HONEST: the cell says it was interrupted - not a finished reply, and not
	// the bare "Chat failed." an API error renders.
	const reply = chat.getByTestId('output-markdown');
	await expect(reply).toBeVisible({ timeout: 30_000 });
	await expect(reply).toContainText('(interrupted)');
	await expect(reply).not.toContainText('Chat failed');
	// The partial reply that DID stream is kept, so the stop did not discard what
	// the user had already been shown. It stays STREAM text rather than joining
	// the finalized markdown - `run.ts` only finalizes a run that ended `ok` - so
	// this is asked of the cell, not of the reply block.
	await expect(chat).toContainText('thinking about it');

	// And the run is genuinely over: the cell is runnable again.
	await expect(chat.getByTestId('run')).toBeEnabled();
});
