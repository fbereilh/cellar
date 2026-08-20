import { test, expect, type Page } from '@playwright/test';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * Chat cells against the REAL claude CLI - the one layer that proves the whole
 * chain: type menu -> run -> `claude -p` subprocess -> streamed reply ->
 * persisted `display_data` markdown -> rendered after reload - plus the sidebar
 * account panel and the sign-in flow (started and CANCELLED; a real OAuth is
 * never completed by a test).
 *
 * Gated twice, like `databricks-logout.test.ts` gates on the SDK: the usual
 * kernel runtime, AND a `claude` CLI that is installed and signed in ambiently
 * (`claude auth status --json` -> loggedIn). The reply test performs one tiny
 * real model turn on that ambient credential (~$0.002, the same budget both
 * design reports spent); everything else costs only `claude auth status` spawns.
 *
 * `CELLAR_CHAT_SLOTS` is redirected into the throwaway workspace, so the
 * sign-in test's slot directory can never land in the developer's real
 * `~/.cellar/claude/` - and the spec asserts that redirect actually held.
 *
 * The hidden-cell check is the e2e half of `chat-transcript.test.ts`: the
 * visible cell's token coming back in the reply proves the transcript really
 * reached the model, and the hidden cell's token cannot be echoed because it
 * was never sent (the unit suite pins the byte-level exclusion; this pins the
 * live wiring).
 */

const PY_ID = 'pycell000';
const HIDDEN_ID = 'hidden000';
const CHAT_ID = 'chatcell0';

// Neither token may appear in the question, or an echo would prove nothing.
const VISIBLE_TOKEN = 'kumquat';
const HIDDEN_TOKEN = 'zanzibar';
const QUESTION = 'In one short line, list every quoted string value assigned in the code above, and nothing else.';

let launcher: ChildProcess | null = null;
let workspace = '';
let slotsRoot = '';
let baseURL = '';

const cellBy = (page: Page, id: string) => page.locator(`[data-testid="cell"][data-cell-id="${id}"]`);

/** Collect page + console errors - a render throw is the failure mode to catch. */
function watchErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on('pageerror', (err) => errors.push(String(err?.message ?? err)));
	page.on('console', (msg) => {
		if (msg.type() === 'error') errors.push(msg.text());
	});
	return errors;
}

/**
 * Is the claude CLI installed and ambiently signed in? Probed with the SAME
 * env scrub the app's spawns use (`chatChildEnv`), so this gate and the app
 * cannot disagree about which credential answers - this spec runs inside agent
 * sessions whose `CLAUDE*`/`ANTHROPIC*` env would otherwise redirect the CLI.
 */
function chatCliGate(): { ready: boolean; reason: string } {
	const env: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (!k.startsWith('ANTHROPIC') && !k.startsWith('CLAUDE')) env[k] = v;
	}
	let res;
	try {
		res = spawnSync('claude', ['auth', 'status', '--json'], { env, encoding: 'utf8', timeout: 20_000 });
	} catch (err) {
		return { ready: false, reason: String(err) };
	}
	if (res.error) return { ready: false, reason: 'claude CLI is not installed' };
	try {
		const parsed = JSON.parse(res.stdout || '') as { loggedIn?: unknown };
		if (parsed.loggedIn === true) return { ready: true, reason: '' };
		return { ready: false, reason: 'the ambient claude CLI login is signed out' };
	} catch {
		return { ready: false, reason: 'claude auth status printed no JSON' };
	}
}

/** The notebook exactly as it sits on disk right now. */
function onDisk(name: string): { cells: Record<string, unknown>[] } {
	return JSON.parse(readFileSync(join(workspace, name), 'utf8'));
}

const diskCell = (name: string, id: string) => onDisk(name).cells.find((c) => c.id === id) as Record<string, unknown>;

/** A mime payload as nbformat stores it: a string, or an array of lines. */
function mimeText(v: unknown): string {
	return Array.isArray(v) ? v.join('') : typeof v === 'string' ? v : '';
}

/**
 * A fresh notebook per test (the raw-cell precedent): a visible code cell, a
 * cell hidden from agents, and a chat cell holding the question.
 */
function seedFixture(name: string): void {
	writeFileSync(
		join(workspace, name),
		JSON.stringify(
			{
				cells: [
					{
						cell_type: 'code',
						id: PY_ID,
						metadata: {},
						source: [`magic_fruit = "${VISIBLE_TOKEN}"`],
						outputs: [],
						execution_count: null
					},
					{
						cell_type: 'code',
						id: HIDDEN_ID,
						metadata: { cellar: { hidden_from_agent: true } },
						source: [`secret_word = "${HIDDEN_TOKEN}"`],
						outputs: [],
						execution_count: null
					},
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

/** Seed a notebook of this test's own, open it, and hand back its name. */
async function openFresh(page: Page, name: string): Promise<string> {
	seedFixture(name);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await page.locator(`[data-testid="tree-file"][data-path="${name}"]`).click();
	await expect(cellBy(page, CHAT_ID)).toBeVisible({ timeout: 30_000 });
	return name;
}

/**
 * Expand the sidebar CHAT section. The open/closed state persists in the
 * SERVER-owned UI store, so a prior test's open can survive into this one - a
 * blind toggle then CLOSES it - and the restore lands at hydration, after the
 * first paint. So converge: click only while the panel is really closed,
 * retried until it is visibly open, whatever state this page inherited.
 */
async function openChatSection(page: Page): Promise<void> {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	const body = page.getByTestId('chat-body');
	await expect(async () => {
		if (!(await body.isVisible())) await page.getByTestId('section-chat').click();
		await expect(body).toBeVisible({ timeout: 1_000 });
	}).toPass({ timeout: 30_000 });
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available - E2E is local-only');
	const cli = chatCliGate();
	test.skip(!cli.ready, `claude CLI not installed or not signed in - real-CLI chat E2E is local-only (${cli.reason})`);
	workspace = mkdtempSync(join(tmpdir(), 'cellar-chat-e2e-'));
	slotsRoot = join(workspace, 'chat-slots');
	const booted = await bootCellar(workspace, { CELLAR_CHAT_SLOTS: slotsRoot });
	launcher = booted.proc;
	baseURL = booted.url;
});

test.afterAll(async () => {
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

test('a chat run reaches the model, excludes the hidden cell, persists as markdown, and survives reload', async ({ page }) => {
	test.setTimeout(300_000);
	const errors = watchErrors(page);
	const nb = await openFresh(page, 'chat-basic.ipynb');

	const chat = cellBy(page, CHAT_ID);
	await expect(chat.getByTestId('chat-badge')).toBeVisible();

	// Run = send. The running affordance is the live "streaming" signal a short
	// real reply reliably shows; the delta rail itself is unit-covered.
	await chat.getByTestId('run').click();
	await expect(chat.getByTestId('running-bar')).toBeVisible({ timeout: 30_000 });

	// The reply lands as RENDERED markdown (the display_data text/markdown path).
	const reply = chat.getByTestId('output-markdown');
	await expect(reply).toBeVisible({ timeout: 240_000 });
	// The visible cell's token coming back proves the transcript reached the
	// model; the hidden token CANNOT appear, because it was never sent.
	await expect(reply).toContainText(VISIBLE_TOKEN);
	await expect(reply).not.toContainText(HIDDEN_TOKEN);

	// Persisted at run:end: one display_data carrying text/markdown, hidden-free.
	await expect
		.poll(() => {
			const outs = (diskCell(nb, CHAT_ID)?.outputs as Record<string, unknown>[] | undefined) ?? [];
			return outs.length === 1 ? (outs[0].output_type as string) : `waiting (${outs.length} outputs)`;
		}, { timeout: 30_000 })
		.toBe('display_data');
	const out = ((diskCell(nb, CHAT_ID).outputs as Record<string, unknown>[])[0].data ?? {}) as Record<string, unknown>;
	const md = mimeText(out['text/markdown']);
	expect(md).toContain(VISIBLE_TOKEN);
	expect(md).not.toContain(HIDDEN_TOKEN);
	expect(mimeText(out['text/plain'])).toContain(VISIBLE_TOKEN);

	// A reopened notebook renders the SAVED reply as markdown - no kernel, no CLI.
	await page.reload();
	await page.locator(`[data-testid="tree-file"][data-path="${nb}"]`).click();
	const reopened = cellBy(page, CHAT_ID).getByTestId('output-markdown');
	await expect(reopened).toBeVisible({ timeout: 30_000 });
	await expect(reopened).toContainText(VISIBLE_TOKEN);

	expect(errors, `unexpected page/console errors:\n${errors.join('\n')}`).toEqual([]);
});

test('the type menu turns a code cell into a chat cell, persisted as a tagged code cell', async ({ page }) => {
	test.setTimeout(120_000);
	const nb = await openFresh(page, 'chat-type-menu.ipynb');

	const py = cellBy(page, PY_ID);
	await py.getByTestId('type-toggle').click();
	await py.getByTestId('type-option-chat').click();
	await expect(py.getByTestId('chat-badge')).toBeVisible();

	// On disk it stays an nbformat CODE cell wearing the language tag - the same
	// interop rule as SQL, so plain Jupyter still opens the notebook.
	await expect
		.poll(() => {
			const cell = diskCell(nb, PY_ID);
			const cellar = (cell?.metadata as Record<string, Record<string, unknown>> | undefined)?.cellar;
			return `${cell?.cell_type}/${cellar?.language}`;
		}, { timeout: 15_000 })
		.toBe('code/chat');
});

test('the sidebar CHAT section shows the borrowed ambient account, with no sign-out control for it', async ({ page }) => {
	test.setTimeout(120_000);
	await openChatSection(page);

	// The gate guarantees an ambient login, and the redirected slots root starts
	// empty, so the resolution is the borrowed terminal credential.
	const status = page.getByTestId('chat-status-line');
	await expect(status).toBeVisible({ timeout: 30_000 });
	await expect(status).not.toContainText('Not signed in');
	await expect(status).not.toContainText('not installed');

	// The borrow rule, rendered: an explanation where the sign-out would be - and
	// no sign-out control anywhere, since no Cellar-owned slot exists yet.
	await expect(page.getByTestId('chat-borrowed-note')).toBeVisible();
	await expect(page.getByTestId('chat-borrowed-note')).toContainText('never signs it out');
	await expect(page.getByTestId('chat-slot-signout')).toHaveCount(0);
});

test('sign-in surfaces the OAuth URL into the redirected slot, renders no credential, and cancels cleanly', async ({ page }) => {
	test.setTimeout(180_000);
	// Unique per run, so the never-touches-~/.cellar assertion below is airtight.
	const slot = `spec-${Date.now()}`;
	await openChatSection(page);
	await expect(page.getByTestId('chat-status-line')).toBeVisible({ timeout: 30_000 });

	await page.getByTestId('chat-add-account').click();
	await page.getByTestId('chat-slot-name').fill(slot);
	await page.getByTestId('chat-login-start').click();

	// The real `claude auth login` runs server-side in the slot's isolated
	// CLAUDE_CONFIG_DIR; the panel polls the captured URL up (BROWSER stub or the
	// paste-fallback line - no browser is popped from the server).
	const url = page.getByTestId('chat-login-url');
	await expect(url).toBeVisible({ timeout: 60_000 });
	const href = (await url.getAttribute('href')) ?? '';
	expect(href).toMatch(/^https:\/\//);
	expect(href).toMatch(/claude\.com|claude\.ai|anthropic\.com/);

	// The slot landed under the workspace redirect, and NOT in the developer's
	// real machine-level slot store.
	expect(existsSync(join(slotsRoot, slot))).toBe(true);
	expect(existsSync(join(homedir(), '.cellar', 'claude', slot))).toBe(false);

	// Identity fields only ever reach the panel - nothing API-key-shaped renders.
	expect(await page.getByTestId('chat-body').textContent()).not.toContain('sk-ant-');

	// Cancel: the OAuth is never completed by a test. The slot survives as a
	// signed-out row, and the ambient account is untouched.
	await page.getByTestId('chat-login-cancel').click();
	await expect(page.getByTestId('chat-login-url')).toHaveCount(0);
	const row = page.locator(`[data-testid="chat-slot-row"][data-slot="${slot}"]`);
	await expect(row).toBeVisible({ timeout: 30_000 });
	await expect(row).toContainText('signed out');
	await expect(page.getByTestId('chat-borrowed-note')).toBeVisible();
});
