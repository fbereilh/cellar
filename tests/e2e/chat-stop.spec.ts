import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

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
 * ## Why the CLI is a stub, and what that does not weaken
 *
 * The subject is what a SIGNAL reaches, not what a model says - so the stub is
 * the honest fixture: it reproduces the one property of a real run that matters
 * here (the CLI has a child of its own, which the real one has whenever the
 * model used a tool) and lets the descendant be identified by pid and asked
 * about directly. A real turn could not make that observation any sharper, and
 * could not be asked to hang on demand.
 *
 * Gated only on the kernel runtime `bootCellar` needs - the stub answers
 * `auth status` too, so no signed-in `claude` is required.
 */

const CHAT_ID = 'chatcell0';
// A name of its own, never the canonical `notebook.ipynb`: the shell opens that
// one by itself, so a tree click on it is not the plain open this helper assumes.
const NB = 'chat-stop.ipynb';

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';
/** Every descendant pid a test learned about, killed at teardown come what may. */
const started: number[] = [];

const cellBy = (page: Page, id: string) => page.locator(`[data-testid="cell"][data-cell-id="${id}"]`);

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/**
 * A stub `claude` that starts a long-lived GRANDCHILD, records its pid, and
 * waits on it - the shape a real run has whenever the model used a tool.
 *
 * The grandchild `exec`s so the recorded pid is the sleeper itself, and the stub
 * `wait`s so the direct child does not exit first (a CLI supervising its tools
 * does not either). `$$` is expanded by the inner shell, hence the quoting.
 */
function installStubClaude(ws: string, pidfile: string): void {
	const shim = join(ws, '.shim');
	mkdirSync(shim, { recursive: true });
	const init = JSON.stringify({
		type: 'system',
		subtype: 'init',
		tools: [],
		mcp_servers: [],
		slash_commands: [],
		skills: [],
		claude_code_version: '9.9.9-stub'
	});
	const bin = join(shim, 'claude');
	writeFileSync(
		bin,
		[
			'#!/bin/sh',
			'if [ "$1" = "auth" ]; then',
			`  echo '{"loggedIn":true,"authMethod":"claude.ai","email":"stub@example.com"}'`,
			'  exit 0',
			'fi',
			'cat > /dev/null', // drain the prompt off stdin, as the real CLI does
			`echo '${init}'`,
			`echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"thinking about it"}}}'`,
			`sh -c 'echo $$ > ${pidfile}; exec sleep 900' &`,
			'wait',
			''
		].join('\n')
	);
	chmodSync(bin, 0o755);
}

function seedNotebook(name: string, ws: string): void {
	writeFileSync(
		join(ws, name),
		JSON.stringify(
			{
				cells: [
					{
						cell_type: 'code',
						id: CHAT_ID,
						metadata: { cellar: { language: 'chat' } },
						source: ['what is 2+2?'],
						outputs: [],
						execution_count: null
					}
				],
				metadata: {},
				nbformat: 4,
				nbformat_minor: 5
			},
			null,
			1
		)
	);
}

/** The pid the stub recorded for this run's descendant. */
async function grandchildPid(pidfile: string): Promise<number> {
	await expect
		.poll(() => (existsSync(pidfile) ? Number(readFileSync(pidfile, 'utf8').trim()) : 0), { timeout: 60_000 })
		.toBeGreaterThan(0);
	const pid = Number(readFileSync(pidfile, 'utf8').trim());
	started.push(pid);
	return pid;
}

async function openFresh(page: Page, name: string): Promise<void> {
	seedNotebook(name, workspace);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await page.locator(`[data-testid="tree-file"][data-path="${name}"]`).click();
	await expect(cellBy(page, CHAT_ID)).toBeVisible({ timeout: 30_000 });
}

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
	for (const pid of started) {
		try {
			process.kill(pid, 'SIGKILL');
		} catch {
			/* already gone */
		}
	}
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
	await openFresh(page, NB);
	const chat = cellBy(page, CHAT_ID);

	await chat.getByTestId('run').click();
	await expect(chat.getByTestId('running-indicator')).toBeVisible({ timeout: 60_000 });

	// The CLI has a child of its own, and it is running.
	const gc = await grandchildPid(pidfile);
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
