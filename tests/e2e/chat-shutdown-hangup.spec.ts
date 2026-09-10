import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * CLOSING THE TERMINAL must not leave a `claude` process tree behind, and must
 * still stop Cellar.
 *
 * ## Why this exists beside `chat-stop.spec.ts`
 *
 * A chat child is spawned `detached`, so it leads its own session and is no
 * longer in the terminal's foreground process group. The APP still is (the
 * launcher spawns it undetached), so a hard terminal close SIGHUPs the launcher
 * and the app and NOTHING ELSE - the whole chat tree is out of reach unless the
 * app reaches it on its way out. That is the same defect the group kill closes,
 * wearing a different hat: "stopping does not stop it" becoming "closing the
 * terminal does not stop it".
 *
 * ## The two assertions, and why NEITHER alone is enough
 *
 * MEASURED: adding any SIGHUP listener SUPPRESSES node's default terminate-on-
 * hang-up, and neither adapter-node nor the launcher has a SIGHUP path - so a
 * handler that aborts and forgets to die leaves a surviving APPLICATION, which
 * is a bigger hole than the one being closed. So this asserts BOTH:
 *
 *   - the app process is GONE (fails against a handler that suppresses the
 *     default without re-raising it);
 *   - the chat descendant is GONE (fails against no handler at all - CONFIRMED
 *     by running this spec against a build with the SIGHUP registration removed:
 *     the app still exited and the `sleep` was still alive).
 *
 * Both are asked of the OS by pid, because the subject is what a signal reaches.
 *
 * This instance is KILLED BY THE TEST, so it gets a launcher of its own rather
 * than sharing `chat-stop.spec.ts`'s.
 */

const CHAT_ID = 'chatcell0';
const NB = 'chat-hangup.ipynb';

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';
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
 * The app server's pid: the launcher's own child running the production build.
 * Read from `ps` rather than from a Cellar record, because an isolated (`--new`)
 * launch deliberately registers no instance - and the point here is to ask the
 * OS whether that process is still there.
 */
function appPidOf(launcherPid: number): number {
	const out = execFileSync('ps', ['-eo', 'pid=,ppid=,command='], { encoding: 'utf8' });
	for (const line of out.split('\n')) {
		const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
		if (!m) continue;
		const [, pid, ppid, command] = m;
		if (Number(ppid) !== launcherPid) continue;
		if (command.includes(`build${'/'}index.js`)) return Number(pid);
	}
	throw new Error('the app server is not a child of the launcher - the fixture is broken, not the code');
}

/** A stub `claude` whose run leaves a long-lived GRANDCHILD, as a tool call does. */
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
			'cat > /dev/null',
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

async function grandchildPid(pidfile: string): Promise<number> {
	await expect
		.poll(() => (existsSync(pidfile) ? Number(readFileSync(pidfile, 'utf8').trim()) : 0), { timeout: 60_000 })
		.toBeGreaterThan(0);
	const pid = Number(readFileSync(pidfile, 'utf8').trim());
	started.push(pid);
	return pid;
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available - E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-chat-hangup-e2e-'));
	installStubClaude(workspace, join(workspace, 'grandchild.pid'));
	const booted = await bootCellar(workspace, { CELLAR_CHAT_SLOTS: join(workspace, 'chat-slots') });
	launcher = booted.proc;
	baseURL = booted.url;
});

test.afterAll(() => {
	// The test kills this instance itself; this is the belt-and-braces path for a
	// case that failed before it got there.
	if (launcher) killCellar(launcher);
	launcher = null;
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

test('closing the terminal stops Cellar AND takes the chat tree with it', async ({ page }) => {
	test.setTimeout(180_000);
	const launcherPid = launcher?.pid;
	expect(launcherPid).toBeGreaterThan(0);
	const appPid = appPidOf(launcherPid as number);
	expect(alive(appPid)).toBe(true);

	const pidfile = join(workspace, 'grandchild.pid');
	rmSync(pidfile, { force: true });
	seedNotebook(NB, workspace);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await page.locator(`[data-testid="tree-file"][data-path="${NB}"]`).click();
	const chat = cellBy(page, CHAT_ID);
	await expect(chat).toBeVisible({ timeout: 30_000 });

	await chat.getByTestId('run').click();
	await expect(chat.getByTestId('running-indicator')).toBeVisible({ timeout: 60_000 });

	const gc = await grandchildPid(pidfile);
	expect(alive(gc)).toBe(true);

	// A hard terminal close, faithfully: the shell SIGHUPs its job's process
	// group, which holds the launcher and the app (the harness spawns the
	// launcher detached, so it leads that group) but NOT the chat child, which
	// leads a session of its own.
	process.kill(-(launcherPid as number), 'SIGHUP');

	// BOTH bounds sit UNDER `parent-watch`'s floor, and that is what makes them
	// discriminating rather than merely true. The orphan self-exit polls the
	// launcher every 5s and needs two consecutive dead readings, so it cannot
	// reach either process sooner than ~5s after the launcher goes - and when it
	// does it aborts chat runs too, which MASKS a broken hang-up path completely:
	// MEASURED, a handler that suppressed the default and never re-raised passed
	// this spec at 10.5s with a 20s bound, rescued by that watchdog. The real path
	// is a synchronous abort and a re-raise, MEASURED sub-second end to end, so
	// this leaves an order of magnitude of headroom while still failing anything
	// that has to wait for the watchdog.
	const PROMPT_MS = 3_000;

	// STILL EXITS, and by its OWN hand: a handler that suppressed node's default
	// terminate-on-hang-up and never re-raised would leave this app serving until
	// the watchdog noticed - and, with no launcher pid or a recycled one, forever.
	await expect.poll(() => alive(appPid), { timeout: PROMPT_MS }).toBe(false);

	// NOTHING LEFT RUNNING: the descendant the CLI started is gone too. With no
	// SIGHUP handler at all this never becomes true - the app dies on the spot by
	// default and nothing anywhere reaches the chat child's group (MEASURED: still
	// alive after 20s).
	await expect.poll(() => alive(gc), { timeout: PROMPT_MS }).toBe(false);
});
