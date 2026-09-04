import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';
import { CHAT_LEARNING_MODE_KEY, CHAT_MODEL_KEY, CHAT_MODEL_DEFAULT, CHAT_OTHER_NOTEBOOKS_KEY, CHAT_WEB_SEARCH_KEY, CHAT_WORKSPACE_READS_KEY } from '../../src/lib/chatCell';

/**
 * E2E for the **Chat cells** section of the Settings pane - the human surface of
 * the chat engine's capability settings (model, the web-search opt-in, and the
 * workspace-reads opt-in).
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
 *   - each opt-OUT is on the wire before the client debounce could have
 *     fired, because the server re-reads these keys when a chat cell RUNS - so
 *     a debounced write leaves a window in which the next run is still granted
 *     the capability the user just turned off. Asserted for BOTH capabilities:
 *     they are separate keys written by separate handlers, so the guarantee is
 *     not inherited by the second one from the first;
 *   - and the two opt-ins are INDEPENDENT: each stores and deletes its own key
 *     without touching the other. They widen the session in different directions
 *     (an outbound query channel vs. local file reach), so wanting one must never
 *     hand over the other - and a single shared "capabilities" flag is exactly
 *     the shortcut this asserts against.
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
	await expect(page.getByTestId('settings-chat-workspace-reads')).not.toBeChecked();
	await expect(page.getByTestId('settings-chat-other-notebooks')).not.toBeChecked();

	const before = await serverSettings(page);
	expect(before[CHAT_MODEL_KEY]).toBeUndefined();
	expect(before[CHAT_WEB_SEARCH_KEY]).toBeUndefined();
	// The reads key too: an upgraded install grants no file reach until asked.
	expect(before[CHAT_WORKSPACE_READS_KEY]).toBeUndefined();
	// ...and other notebooks stay denied until asked for separately.
	expect(before[CHAT_OTHER_NOTEBOOKS_KEY]).toBeUndefined();

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

test('the workspace-reads opt-in stores a literal true, and leaves web search alone', async ({ page }) => {
	await page.goto(baseURL);
	await openSettings(page);

	// Search is OFF at this point (the test above turned it back off), which is
	// what makes this a real independence check rather than a coincidence.
	await expect(page.getByTestId('settings-chat-web-search')).not.toBeChecked();
	await page.getByTestId('settings-chat-workspace-reads').click();
	await expect(page.getByTestId('settings-chat-workspace-reads')).toBeChecked();

	// Only a literal boolean `true` widens a session (`chatWorkspaceReadsEnabled`
	// accepts nothing else), so a `"true"` string here would silently leave reads off.
	await expect
		.poll(async () => (await serverSettings(page))[CHAT_WORKSPACE_READS_KEY], { timeout: 10_000 })
		.toBe(true);
	// ...and the OTHER capability was not handed over as a side effect.
	expect(CHAT_WEB_SEARCH_KEY in (await serverSettings(page))).toBe(false);
	await expect(page.getByTestId('settings-chat-web-search')).not.toBeChecked();

	await page.getByTestId('chat-settings-control').screenshot({
		path: test.info().outputPath('chat-settings-reads-on.png')
	});
	await test.info().attach('chat-settings-reads-on', {
		path: test.info().outputPath('chat-settings-reads-on.png'),
		contentType: 'image/png'
	});
	await closeSettings(page);
});

test('the other-notebooks opt-in is its own key, and does not widen the other two', async ({ page }) => {
	await page.goto(baseURL);
	await openSettings(page);

	// Reads are ON at this point and search is OFF, so this is a real independence
	// check: the narrowing this toggle lifts is a THIRD decision, and neither of
	// the two capabilities beside it may arrive as a side effect of taking it.
	await expect(page.getByTestId('settings-chat-workspace-reads')).toBeChecked();
	await expect(page.getByTestId('settings-chat-other-notebooks')).not.toBeChecked();
	await page.getByTestId('settings-chat-other-notebooks').click();
	await expect(page.getByTestId('settings-chat-other-notebooks')).toBeChecked();

	await expect
		.poll(async () => (await serverSettings(page))[CHAT_OTHER_NOTEBOOKS_KEY], { timeout: 10_000 })
		.toBe(true);
	expect(CHAT_WEB_SEARCH_KEY in (await serverSettings(page))).toBe(false);
	expect((await serverSettings(page))[CHAT_WORKSPACE_READS_KEY]).toBe(true);

	// Off again deletes it, so an opted-out store is byte-identical to a fresh one
	// - the same rule as its two neighbours, and it must hold for the key whose
	// default is what keeps other people's hidden cells out of a reply.
	await page.getByTestId('settings-chat-other-notebooks').click();
	await expect
		.poll(async () => CHAT_OTHER_NOTEBOOKS_KEY in (await serverSettings(page)), { timeout: 10_000 })
		.toBe(false);
	await closeSettings(page);
});

test('a reload re-hydrates the reads toggle, and turning it off DELETES its key', async ({ page }) => {
	await page.goto(baseURL);
	await openSettings(page);

	// What a person reads back after a reload is what the next run would use.
	await expect(page.getByTestId('settings-chat-workspace-reads')).toBeChecked();

	await page.getByTestId('settings-chat-workspace-reads').click();
	await expect(page.getByTestId('settings-chat-workspace-reads')).not.toBeChecked();
	// Absent, not `false`: an opted-out store is byte-identical to a fresh one.
	await expect
		.poll(async () => CHAT_WORKSPACE_READS_KEY in (await serverSettings(page)), { timeout: 10_000 })
		.toBe(false);
	await closeSettings(page);
});

/**
 * The debounced client write is `FLUSH_DEBOUNCE_MS` (300ms, `$lib/clientStore`)
 * away from the server, so it cannot be what carries a CAPABILITY opt-out: the
 * server re-reads these keys when a chat cell RUNS, and a run started inside
 * that window would still have been granted the `--tools`/`--allowedTools`
 * capability the user just turned off - `WebSearch`, or the workspace read
 * grants. The immediate write
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
 * Run LAST because the spec is serial and shares one store: each opts in, then
 * out, leaving both capabilities off exactly as the tests above do.
 */
const FLUSH_DEBOUNCE_MS = 300;

interface OptOutProbe {
	__cellarOptOutMark?: number;
	__cellarOptOutDelay?: number;
}

/**
 * One capability's opt-out, timed against the debounce floor. Parameterized
 * because the guarantee is a property of the HANDLER, not of the pane: each
 * toggle writes its own key through its own function, so proving it for web
 * search says nothing about workspace reads or about other notebooks - and those
 * two are the ones whose debounced window would leave the next run still holding
 * a file grant, or still able to read notebooks the person just closed off.
 */
async function assertOptOutBeatsDebounce(page: Page, key: string, testId: string): Promise<void> {
	await openSettings(page);

	// Opt IN first, and let it settle, so the toggle below is a real opt-OUT
	// over a store that really holds `true`.
	await page.getByTestId(testId).click();
	await expect.poll(async () => (await serverSettings(page))[key], { timeout: 10_000 }).toBe(true);

	// Timestamp the opt-out PUT relative to the click that caused it. The opt-out
	// is the write that DELETES the key (a stored `false` would not be an
	// opted-out store - see the tests above).
	await page.evaluate((k: string) => {
		const probe = window as unknown as OptOutProbe;
		probe.__cellarOptOutMark = undefined;
		probe.__cellarOptOutDelay = undefined;
		const realFetch = window.fetch.bind(window);
		window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			try {
				const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
				if (init?.method === 'PUT' && url.includes('/api/user-settings') && probe.__cellarOptOutDelay === undefined) {
					const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
					if (k in body && body[k] === null && probe.__cellarOptOutMark !== undefined) {
						probe.__cellarOptOutDelay = performance.now() - probe.__cellarOptOutMark;
					}
				}
			} catch {
				/* the measurement may never disturb the write */
			}
			return realFetch(input, init);
		}) as typeof window.fetch;
	}, key);

	// Mark and click in ONE browser turn - nothing between them to measure.
	await page.evaluate((t: string) => {
		const probe = window as unknown as OptOutProbe;
		probe.__cellarOptOutMark = performance.now();
		document.querySelector<HTMLElement>(`[data-testid="${t}"]`)?.click();
	}, testId);

	await expect(page.getByTestId(testId)).not.toBeChecked();

	const delay = await page.evaluate(() => (window as unknown as OptOutProbe).__cellarOptOutDelay);
	// Issued at all...
	expect(delay).not.toBeUndefined();
	// ...and strictly inside the debounce floor: the debounced path schedules its
	// flush FLUSH_DEBOUNCE_MS after the click, so it could never land here.
	expect(delay as number).toBeLessThan(FLUSH_DEBOUNCE_MS);

	// The write it carried is the one the server ends up holding.
	await expect.poll(async () => key in (await serverSettings(page)), { timeout: 10_000 }).toBe(false);

	await closeSettings(page);
}

test('the web-search opt-out reaches the server without waiting out the debounce', async ({ page }) => {
	await page.goto(baseURL);
	await assertOptOutBeatsDebounce(page, CHAT_WEB_SEARCH_KEY, 'settings-chat-web-search');
});

test('the workspace-reads opt-out reaches the server without waiting out the debounce', async ({ page }) => {
	await page.goto(baseURL);
	await assertOptOutBeatsDebounce(page, CHAT_WORKSPACE_READS_KEY, 'settings-chat-workspace-reads');
});

test('the other-notebooks opt-out reaches the server without waiting out the debounce', async ({ page }) => {
	// The same floor for the third key, because the guarantee is a property of the
	// HANDLER: this one decides whether the next run may read OTHER people's
	// notebooks - including the cells their authors hid - so an opt-out sitting in
	// a debounce window is the same class of defect as the two beside it.
	await page.goto(baseURL);
	await assertOptOutBeatsDebounce(page, CHAT_OTHER_NOTEBOOKS_KEY, 'settings-chat-other-notebooks');
});

/**
 * The DETECT + REPORT half (the `sdkDbutils` precedent): an un-patternable
 * workspace path or notebook NAME makes workspace reads fail closed, and without
 * a report that fallback is silent - the toggle still renders on and its copy
 * still promises the reply may browse the workspace, while only the model is
 * told otherwise, so the person meets a reply that merely seems broken.
 *
 * The verdict itself and both its causes are pinned in
 * `tests/unit/chat-reads-availability.test.ts` against the real route; what only
 * a browser can show is that the pane RENDERS it, and renders nothing when there
 * is nothing to say. The notebook cause is used here because it is the one that
 * varies within a single workspace - reads off for this notebook, fine for the
 * one beside it - which is exactly why the sentence has to name which notebook.
 *
 * Runs LAST: it creates and focuses a notebook, changing the workspace the
 * serial tests above share.
 */
test('the learning-mode opt-out reaches the server without waiting out the debounce', async ({ page }) => {
	// The fourth key on the same floor. Learning mode is the one chat setting that
	// is NOT a capability - an opt-out sitting in a debounce window grants nothing -
	// so the argument here is legibility rather than a grant: the server re-reads
	// this key when a cell RUNS, so a run started right after the click would reply
	// in the voice the person just turned off. The guarantee is a property of the
	// HANDLER, and this toggle has its own, so the three beside it say nothing about
	// it.
	await page.goto(baseURL);
	await assertOptOutBeatsDebounce(page, CHAT_LEARNING_MODE_KEY, 'settings-chat-learning-mode');
});

test('an un-patternable notebook name is REPORTED at the toggle, naming that notebook', async ({ page }) => {
	await page.goto(baseURL);
	await openSettings(page);
	// Nothing to say on the healthy default notebook - a report here would be a
	// false alarm sending someone after a problem they do not have.
	await expect(page.getByTestId('settings-chat-reads-unavailable')).toHaveCount(0);
	await closeSettings(page);

	// Create and focus a notebook whose name cannot be spelled as a literal
	// permission rule (`{` is a glob metacharacter). The page is already open, so
	// the server's `notebook:opened` reaches it and the shell focuses that tab -
	// which is what makes it the notebook the pane reports about.
	const created = await page.request.post(`${baseURL}/api/notebooks`, {
		data: { path: 'run{1}.ipynb', create: true }
	});
	expect(created.ok()).toBe(true);
	await expect(page.getByRole('tab', { name: /run\{1\}/ })).toBeVisible({ timeout: 15_000 });

	await openSettings(page);
	const notice = page.getByTestId('settings-chat-reads-unavailable');
	await expect(notice).toBeVisible();
	// It must name the notebook: the verdict is per notebook, so an unqualified
	// "reads are off" would be wrong about the workspace as a whole.
	await expect(notice).toContainText('run{1}.ipynb');
	await expect(notice).toContainText(/other notebooks in this workspace are unaffected/i);
	await closeSettings(page);
});
