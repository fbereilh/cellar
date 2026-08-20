import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';
import { CHAT_MODEL_KEY, CHAT_MODEL_DEFAULT, CHAT_WEB_SEARCH_KEY } from '../../src/lib/chatCell';

/**
 * E2E for the **Chat cells** section of the Settings pane - the human surface of
 * the chat engine's two capability settings (model, and the web-search opt-in).
 *
 * The unit suite proves what the ENGINE does with those settings (`chat-run` for
 * the threading, `chat-engine-safety` for the argv and the init allowlist); what
 * only a real browser can prove is the half in between: that the pane a person
 * clicks writes the very keys the server reads back, in the exact shapes the
 * gates require. Those shapes are the whole safety story of this feature, so
 * they are asserted against the SERVER's own store (`GET /api/user-settings`),
 * never against component state:
 *
 *   - a never-touched install carries NEITHER key, and the pane shows the
 *     default model with search off - so "an existing install behaves identically
 *     until the user changes it" is a fact about the store, not a claim;
 *   - the opt-in stores a literal `true` (`chatWebSearchEnabled` accepts nothing
 *     else, so a `"true"` string here would silently leave search off);
 *   - turning it back OFF DELETES the key rather than storing `false` - absent is
 *     the default, so an opted-out store is byte-identical to a fresh one;
 *   - the model select stores the chosen id from the closed `CHAT_MODELS` list;
 *   - a reload shows the pane what the store holds, so what a person reads
 *     back is what the next run would use. (This pins the OUTCOME, not the
 *     seed-on-open mechanism behind it: the SSR-seeded client cache means a
 *     construction-time read would pass here too - the reason the seed waits for
 *     `open` is the pre-hydration empty store, which this level cannot observe.)
 *   - and the opt-OUT is on the wire before the client debounce could have
 *     fired, because the server re-reads these keys when a chat cell RUNS - so
 *     a debounced write leaves a window in which the next run is still granted
 *     the capability the user just turned off.
 *
 * `CELLAR_USER_SETTINGS` is redirected into the throwaway workspace by the shared
 * harness, so this spec can never rewrite the settings of whoever ran the suite.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
	if (!runtimeAvailable()) return;
	workspace = mkdtempSync(join(tmpdir(), 'cellar-chat-settings-'));
	const boot = await bootCellar(workspace);
	launcher = boot.proc;
	baseURL = boot.url;
});

test.afterAll(() => {
	if (launcher) killCellar(launcher);
	launcher = null;
	if (workspace) rmSync(workspace, { recursive: true, force: true });
});

test.beforeEach(() => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available');
});

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

test('a never-touched install carries neither key, and the pane shows the shipped defaults', async ({ page }) => {
	await page.goto(baseURL);
	await openSettings(page);

	await expect(page.getByTestId('settings-chat-model')).toHaveValue(CHAT_MODEL_DEFAULT);
	await expect(page.getByTestId('settings-chat-web-search')).not.toBeChecked();

	const before = await serverSettings(page);
	expect(before[CHAT_MODEL_KEY]).toBeUndefined();
	expect(before[CHAT_WEB_SEARCH_KEY]).toBeUndefined();

	await page.getByTestId('chat-settings-control').screenshot({
		path: test.info().outputPath('chat-settings-default.png')
	});
	await test.info().attach('chat-settings-default', {
		path: test.info().outputPath('chat-settings-default.png'),
		contentType: 'image/png'
	});
	await closeSettings(page);
});

test('the opt-in stores a literal true, and the model select stores its id', async ({ page }) => {
	await page.goto(baseURL);
	await openSettings(page);

	await page.getByTestId('settings-chat-web-search').click();
	await expect(page.getByTestId('settings-chat-web-search')).toBeChecked();
	await page.getByTestId('settings-chat-model').selectOption('opus');

	// Only a literal boolean `true` widens a session; a `"true"` string would not.
	await expect
		.poll(async () => (await serverSettings(page))[CHAT_WEB_SEARCH_KEY], { timeout: 10_000 })
		.toBe(true);
	await expect.poll(async () => (await serverSettings(page))[CHAT_MODEL_KEY], { timeout: 10_000 }).toBe('opus');

	await page.getByTestId('chat-settings-control').screenshot({
		path: test.info().outputPath('chat-settings-search-on.png')
	});
	await test.info().attach('chat-settings-search-on', {
		path: test.info().outputPath('chat-settings-search-on.png'),
		contentType: 'image/png'
	});
	await closeSettings(page);
});

test('a reload re-hydrates the pane from the store when the modal opens', async ({ page }) => {
	await page.goto(baseURL);
	await openSettings(page);

	await expect(page.getByTestId('settings-chat-model')).toHaveValue('opus');
	await expect(page.getByTestId('settings-chat-web-search')).toBeChecked();
	await closeSettings(page);
});

test('turning search back off DELETES the key: an opted-out store matches a fresh one', async ({ page }) => {
	await page.goto(baseURL);
	await openSettings(page);

	await page.getByTestId('settings-chat-web-search').click();
	await expect(page.getByTestId('settings-chat-web-search')).not.toBeChecked();

	await expect
		.poll(async () => CHAT_WEB_SEARCH_KEY in (await serverSettings(page)), { timeout: 10_000 })
		.toBe(false);
	// The model is an explicit selection and stays; only the flag is absent-by-default.
	expect((await serverSettings(page))[CHAT_MODEL_KEY]).toBe('opus');
	await closeSettings(page);
});

/**
 * The debounced client write is `FLUSH_DEBOUNCE_MS` (300ms, `$lib/clientStore`)
 * away from the server, so it cannot be what carries a CAPABILITY opt-out: the
 * server re-reads these keys when a chat cell RUNS, and a run started inside
 * that window would still have been granted `--tools`/`--allowedTools
 * WebSearch` after the user turned search off. The immediate write
 * (`setUserSettingNow`, the `setUiNow` rule the Databricks runtime toggle
 * already follows) is what closes it.
 *
 * Observed as the outbound PUT rather than by racing a read: the write carrying
 * the deletion must be ISSUED sooner than the debounce timer could possibly have
 * fired, which is a hard floor the debounced path can never beat.
 *
 * The interval is measured ENTIRELY IN THE PAGE, and that is what makes a 300ms
 * budget a real discriminator rather than a flake: the mark and the click happen
 * in one synchronous browser turn, so no Playwright round trip, worker
 * contention or event-loop stall can be mistaken for the debounce. `fetch` is
 * the platform API the store calls, wrapped here only to timestamp the request
 * it makes - the request itself, and the store, are untouched.
 *
 * Runs LAST because the spec is serial and shares one store: it opts in, then
 * out, leaving search off exactly as the test above does.
 */
const FLUSH_DEBOUNCE_MS = 300;

interface OptOutProbe {
	__cellarOptOutMark?: number;
	__cellarOptOutDelay?: number;
}

test('the web-search opt-out reaches the server without waiting out the debounce', async ({ page }) => {
	await page.goto(baseURL);
	await openSettings(page);

	// Opt IN first, and let it settle, so the toggle below is a real opt-OUT
	// over a store that really holds `true`.
	await page.getByTestId('settings-chat-web-search').click();
	await expect
		.poll(async () => (await serverSettings(page))[CHAT_WEB_SEARCH_KEY], { timeout: 10_000 })
		.toBe(true);

	// Timestamp the opt-out PUT relative to the click that caused it. The opt-out
	// is the write that DELETES the key (a stored `false` would not be an
	// opted-out store - see the test above).
	await page.evaluate((key: string) => {
		const probe = window as unknown as OptOutProbe;
		const realFetch = window.fetch.bind(window);
		window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			try {
				const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
				if (init?.method === 'PUT' && url.includes('/api/user-settings') && probe.__cellarOptOutDelay === undefined) {
					const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
					if (key in body && body[key] === null && probe.__cellarOptOutMark !== undefined) {
						probe.__cellarOptOutDelay = performance.now() - probe.__cellarOptOutMark;
					}
				}
			} catch {
				/* the measurement may never disturb the write */
			}
			return realFetch(input, init);
		}) as typeof window.fetch;
	}, CHAT_WEB_SEARCH_KEY);

	// Mark and click in ONE browser turn - nothing between them to measure.
	await page.evaluate(() => {
		const probe = window as unknown as OptOutProbe;
		probe.__cellarOptOutMark = performance.now();
		document.querySelector<HTMLElement>('[data-testid="settings-chat-web-search"]')?.click();
	});

	await expect(page.getByTestId('settings-chat-web-search')).not.toBeChecked();

	const delay = await page.evaluate(() => (window as unknown as OptOutProbe).__cellarOptOutDelay);
	// Issued at all...
	expect(delay).not.toBeUndefined();
	// ...and strictly inside the debounce floor: the debounced path schedules its
	// flush FLUSH_DEBOUNCE_MS after the click, so it could never land here.
	expect(delay as number).toBeLessThan(FLUSH_DEBOUNCE_MS);

	// The write it carried is the one the server ends up holding.
	await expect
		.poll(async () => CHAT_WEB_SEARCH_KEY in (await serverSettings(page)), { timeout: 10_000 })
		.toBe(false);

	await closeSettings(page);
});
