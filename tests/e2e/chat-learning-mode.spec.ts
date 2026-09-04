import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';
import { CHAT_LEARNING_MODE_KEY } from '../../src/lib/chatCell';
import { CHAT_LEARNING_MODE_BLOCK } from '../../src/lib/server/chat/claude-cli';

/**
 * LEARNING MODE, end to end: a person turns the toggle on in Settings, runs a
 * chat cell, and the child the product spawns carries the teaching block in its
 * `--system-prompt`.
 *
 * ## Why the assertion is on the ARGV, and why the CLI is a stub
 *
 * The subject is the chain the unit suite cannot see whole: the Settings pane
 * writes the person-scoped key, the SERVER re-reads it when a cell RUNS, the
 * engine composes the prompt from it, and the child is spawned with it. What
 * happens after that is the model's business - a real turn would spend money to
 * assert on prose a model is free to phrase any way it likes, which is a flaky
 * test of the wrong thing. So the stub `claude` RECORDS its argv and answers
 * with a fixed, valid stream; the claim under test is what the product sent,
 * which is exactly what learning mode decides.
 *
 * NUL-separated argv, deliberately: with learning mode on the system prompt
 * CONTAINS a newline (the block is two lines), so the line-split dump the unit
 * suite uses would tear one argument into two.
 *
 * ## The control is the load-bearing half
 *
 * Each assertion is run TWICE against the same stub - once with the toggle off,
 * once on - because "the block is present" alone would pass against a build that
 * appended it unconditionally, which is the regression that would silently change
 * every existing install's prompt. The off run must show the block ABSENT and the
 * argv otherwise IDENTICAL: learning mode moves `--system-prompt` and nothing
 * else, so it can never widen a session.
 *
 * Gated only on the kernel runtime (`bootCellar` needs its sidecar), not on a
 * signed-in `claude`: the stub answers `auth status` too.
 */

const CHAT_ID = 'chatcell0';
const QUESTION = 'Why does a gradient point uphill?';

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';
/** Where the stub dumps the argv of the run it was last spawned for. */
let argvFile = '';

const cellBy = (page: Page, id: string) => page.locator(`[data-testid="cell"][data-cell-id="${id}"]`);

/**
 * Install a stub `claude` in the shim directory `bootCellar` puts on the
 * launcher's PATH. It answers both things Cellar asks the binary - `auth status`
 * and the `-p` run - and records the run's argv NUL-separated.
 *
 * Its `system/init` reports NO tools, which is what the engine's exact-allowlist
 * assertion requires for a run with neither capability opted in: learning mode
 * must not change that, and a run it did change would fail `unsafe_init` here
 * rather than pass quietly.
 */
function installStubClaude(ws: string): void {
	const shim = join(ws, '.shim');
	mkdirSync(shim, { recursive: true });
	argvFile = join(ws, 'argv.bin');
	const init = JSON.stringify({
		type: 'system',
		subtype: 'init',
		tools: [],
		mcp_servers: [],
		slash_commands: [],
		skills: [],
		claude_code_version: '2.1.241-stub'
	});
	const result = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'A gradient points uphill.' });
	const bin = join(shim, 'claude');
	writeFileSync(
		bin,
		[
			'#!/bin/sh',
			'if [ "$1" = "auth" ]; then',
			`  echo '{"loggedIn":true,"authMethod":"claude.ai","email":"stub@example.com"}'`,
			'  exit 0',
			'fi',
			// NUL-separated: a learning-mode prompt carries a newline of its own.
			`for a in "$@"; do printf '%s\\0' "$a"; done > "${argvFile}"`,
			'cat > /dev/null', // drain the prompt off stdin, as the real CLI does
			`echo '${init}'`,
			`echo '${result}'`,
			'exit 0',
			''
		].join('\n')
	);
	chmodSync(bin, 0o755);
}

/** The argv of the last run the stub was spawned for. */
function recordedArgv(): string[] {
	const raw = readFileSync(argvFile, 'utf8');
	// A trailing NUL terminates the last argument rather than starting another.
	return raw.split('\0').slice(0, -1);
}

/** The `--system-prompt` value of a recorded argv. */
function promptOf(args: string[]): string {
	const at = args.indexOf('--system-prompt');
	expect(at).toBeGreaterThanOrEqual(0);
	return args[at + 1];
}

function seedNotebook(name: string): void {
	writeFileSync(
		join(workspace, name),
		JSON.stringify(
			{
				cells: [
					{
						cell_type: 'code',
						id: CHAT_ID,
						metadata: { cellar: { language: 'chat' } },
						source: [QUESTION],
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

async function openSettings(page: Page): Promise<void> {
	await page.getByTestId('app-menu').click();
	await page.getByTestId('open-settings').click();
	await expect(page.getByTestId('settings-modal')).toBeVisible();
	await page.getByTestId('chat-settings-control').scrollIntoViewIfNeeded();
	await expect(page.getByTestId('chat-settings-control')).toBeVisible();
}

async function closeSettings(page: Page): Promise<void> {
	await page.getByTestId('settings-close').click();
	await expect(page.getByTestId('settings-modal')).toHaveCount(0);
}

/** The settings map as the SERVER holds it - what a chat run would read. */
async function serverSettings(page: Page): Promise<Record<string, unknown>> {
	const res = await page.request.get(`${baseURL}/api/user-settings`);
	expect(res.ok()).toBe(true);
	return (await res.json()) as Record<string, unknown>;
}

/** Open a fresh notebook and run its chat cell, returning the argv that produced it. */
async function runChat(page: Page, name: string): Promise<string[]> {
	seedNotebook(name);
	if (existsSync(argvFile)) rmSync(argvFile);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await page.locator(`[data-testid="tree-file"][data-path="${name}"]`).click();
	const chat = cellBy(page, CHAT_ID);
	await expect(chat).toBeVisible({ timeout: 30_000 });
	await chat.getByTestId('run').click();
	// The reply landing is what proves the child really ran to completion, so the
	// recorded argv belongs to a run the product considered successful.
	await expect(chat.getByTestId('output-markdown')).toContainText('gradient points uphill', { timeout: 120_000 });
	await expect.poll(() => existsSync(argvFile), { timeout: 30_000 }).toBe(true);
	return recordedArgv();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
	if (!runtimeAvailable()) return;
	workspace = mkdtempSync(join(tmpdir(), 'cellar-learning-mode-'));
	installStubClaude(workspace);
	const booted = await bootCellar(workspace, { CELLAR_CHAT_SLOTS: join(workspace, 'chat-slots') });
	launcher = booted.proc;
	baseURL = booted.url;
});

test.afterAll(() => {
	if (launcher) killCellar(launcher);
	launcher = null;
	if (workspace && existsSync(workspace)) {
		try {
			rmSync(workspace, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
});

test.beforeEach(() => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available');
});

test('learning mode: off by default, and turning it on sends the teaching block in --system-prompt', async ({ page }) => {
	test.setTimeout(240_000);

	// --- CONTROL: the shipped default. -----------------------------------------
	await page.goto(baseURL);
	await openSettings(page);
	await expect(page.getByTestId('settings-chat-learning-mode')).not.toBeChecked();
	// A never-touched install carries the key not at all, so an upgrade behaves
	// exactly as before this setting existed.
	expect(CHAT_LEARNING_MODE_KEY in (await serverSettings(page))).toBe(false);
	await closeSettings(page);

	const off = await runChat(page, 'learning-off.ipynb');
	expect(promptOf(off)).not.toContain(CHAT_LEARNING_MODE_BLOCK);
	expect(promptOf(off)).not.toContain('act as a teacher');

	// --- THE PATH UNDER TEST: a person turns it on. ----------------------------
	await openSettings(page);
	await page.getByTestId('settings-chat-learning-mode').click();
	await expect(page.getByTestId('settings-chat-learning-mode')).toBeChecked();
	// A literal `true`, the only value the run-time gate accepts - a `"true"`
	// string here would leave the reply untaught while the toggle read on.
	await expect
		.poll(async () => (await serverSettings(page))[CHAT_LEARNING_MODE_KEY], { timeout: 10_000 })
		.toBe(true);
	await page.getByTestId('chat-settings-control').screenshot({
		path: test.info().outputPath('chat-settings-learning-on.png')
	});
	await test.info().attach('chat-settings-learning-on', {
		path: test.info().outputPath('chat-settings-learning-on.png'),
		contentType: 'image/png'
	});
	await closeSettings(page);

	const on = await runChat(page, 'learning-on.ipynb');
	// The block reaches the child VERBATIM, newline and all.
	expect(promptOf(on)).toContain(CHAT_LEARNING_MODE_BLOCK);
	expect(promptOf(on)).toContain('\n');

	// --- What did NOT move. ----------------------------------------------------
	// Learning mode changes the prompt and nothing else, so the rest of the argv
	// - the tool request, any grant, the model, every isolation flag - is
	// byte-identical. Anything else here would be a capability change arriving as
	// a side effect of asking to be taught.
	const withoutPrompt = (args: string[]) => {
		const at = args.indexOf('--system-prompt');
		return [...args.slice(0, at), ...args.slice(at + 2)];
	};
	expect(withoutPrompt(on)).toEqual(withoutPrompt(off));
	// ...and the prompt itself only GREW: the capability sentence the shape sends
	// is untouched, so a taught reply is not also a mis-described one.
	expect(promptOf(on)).toBe(`${promptOf(off)} ${CHAT_LEARNING_MODE_BLOCK}`);

	// --- And the opt-out is as complete as the opt-in. -------------------------
	await openSettings(page);
	await page.getByTestId('settings-chat-learning-mode').click();
	await expect(page.getByTestId('settings-chat-learning-mode')).not.toBeChecked();
	// Absent, not `false`: an opted-out store is byte-identical to a fresh one.
	await expect
		.poll(async () => CHAT_LEARNING_MODE_KEY in (await serverSettings(page)), { timeout: 10_000 })
		.toBe(false);
	await closeSettings(page);

	const offAgain = await runChat(page, 'learning-off-again.ipynb');
	expect(promptOf(offAgain)).toBe(promptOf(off));
});

test('a reload re-hydrates the toggle from the store', async ({ page }) => {
	test.setTimeout(120_000);
	// What a person reads back after a reload is what the next run would use - the
	// same claim its sibling toggles make, for the setting whose default decides
	// how every reply in this install is written.
	await page.goto(baseURL);
	await openSettings(page);
	await expect(page.getByTestId('settings-chat-learning-mode')).not.toBeChecked();
	await page.getByTestId('settings-chat-learning-mode').click();
	await expect
		.poll(async () => (await serverSettings(page))[CHAT_LEARNING_MODE_KEY], { timeout: 10_000 })
		.toBe(true);
	await closeSettings(page);

	await page.reload();
	await openSettings(page);
	await expect(page.getByTestId('settings-chat-learning-mode')).toBeChecked();
	// Leave the store as this file found it, so a later spec's fresh-install
	// assertions are not decided by this one.
	await page.getByTestId('settings-chat-learning-mode').click();
	await expect
		.poll(async () => CHAT_LEARNING_MODE_KEY in (await serverSettings(page)), { timeout: 10_000 })
		.toBe(false);
	await closeSettings(page);
});
