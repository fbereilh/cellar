import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar, openSidebarSection } from './harness';
import { UPLOAD_DATE_TOKENS } from '../../src/lib/databricksUploadName';

/**
 * E2E for the **cross-project default** upload prefix/postfix set in Settings.
 *
 * Someone who stamps every upload the same way should say so once rather than once
 * per repo, so the default lives in the global `~/.cellar/` store - and the rule
 * that makes that safe is a DIRECTION: a project with an affix of its own always
 * wins, and the default only fills in for a project that has never been asked.
 * Getting that backwards would silently rewrite naming a user set deliberately.
 *
 * **Two launchers, two workspaces, one global store.** Cross-project apply is the
 * entire point of the feature, so it is exercised across two REAL projects rather
 * than asserted about one: `A` is opened, given an affix of its own and used to set
 * the default; `B` is a different workspace served by a different launcher on a
 * different port, and never asked anything. Both are pointed at the same
 * `CELLAR_USER_SETTINGS` file, which is what makes them one user with two projects.
 * (That file also has to be redirected at all: it defaults to a real file in the
 * home directory, so a spec touching it would rewrite the settings of whoever ran
 * the suite.)
 *
 * What is pinned:
 *
 *   - the default set in A reaches B - a project that has never been asked seeds
 *     from it and uploads under it - while A keeps its own affix untouched;
 *   - a default changed while a Databricks panel is ALREADY OPEN reaches it with no
 *     reload (the panel is mounted lazily and then kept mounted for the session, so
 *     a one-shot read left the Settings copy promising something it did not do);
 *   - a default change that MOVES the affix drops the armed replace confirm, which
 *     names a path built from the OLD one - while a seed that changes nothing
 *     (reopening the section) leaves a still-accurate box alone;
 *   - the same change made while a replace is IN FLIGHT defers instead, so the
 *     settled reply is never discarded as superseded, and applies once it lands -
 *     and when that reply is an `exists`, the confirm it arms SURVIVES the deferred
 *     seed, because there it is the only outcome there is;
 *   - a default that fails validation is refused rather than persisted, and the last
 *     valid one is left standing;
 *   - clearing a project's field is an ANSWER ("no prefix here"), so the default
 *     does not creep back on the next load;
 *   - the default is a FILE, not per-origin state, which is the whole reason it is
 *     not `localStorage`;
 *   - it takes the same tokens (`{YYYYMM}` and friends) and the same not-a-token
 *     warning as the sidebar's own fields.
 *
 * Deliberately NOT claimed: that a default written by one running instance reaches
 * another whose PAGE is already open. The server store re-reads the file when its
 * stamp moves, so a fresh load of B always sees what A wrote; a browser sitting on a
 * rendered page is not pushed to.
 *
 * **Every test establishes the state it needs, and the `afterEach` puts the shared
 * stores back.** There is one global store and two per-project ones behind these
 * tests, so a test that leaned on the value its predecessor left would turn a single
 * genuine regression into a cascade of unrelated red - and the restore, written as a
 * trailing statement, would be skipped by exactly the failure that poisons the store.
 */

let launcherA: ChildProcess | null = null;
let launcherB: ChildProcess | null = null;
/** `projectA` sets an affix of its own; `projectB` is never asked. */
let projectA = '';
let projectB = '';
let settingsFile = '';
let settingsDir = '';
let urlA = '';
let urlB = '';

const HOST = 'https://dbc-demo.cloud.databricks.com';
const USER = 'me@corp.example.com';
const PREFIX_DEFAULT_KEY = 'cellar-databricks-upload-prefix-default';
const POSTFIX_DEFAULT_KEY = 'cellar-databricks-upload-postfix-default';
const PREFIX_KEY = 'cellar-databricks-upload-prefix';
const POSTFIX_KEY = 'cellar-databricks-upload-postfix';
/** Short enough that a wedged page cannot eat the hook's budget before the reset. */
const UI_CLEAR_TIMEOUT_MS = 2_000;

/**
 * The instances a test has actually opened, so the reset touches those and no others.
 *
 * Which of the two has read the global store, and when, is part of what this file
 * says: B inherits a default on a load that comes AFTER A wrote it. Resetting through
 * an instance a test never went near would quietly make that ordering untrue.
 */
const touched = new Set<string>();

function connectedStatus() {
	return {
		connection: {
			connected: true,
			profile: 'DEFAULT',
			host: HOST,
			clusterId: '0710-abc123-xyz',
			clusterName: 'analytics-prod',
			sparkVersion: '15.4.x-scala2.12'
		},
		config: { profiles: [{ name: 'DEFAULT', host: HOST, hasToken: true }] },
		install: { python: '/tmp/.venv/bin/python', sdk: true, connect: true },
		uv: true,
		signedInHosts: [],
		signedInProfiles: []
	};
}

async function mockDatabricks(page: Page): Promise<Record<string, unknown>[]> {
	await page.route(/\/api\/databricks(\?.*)?$/, async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(connectedStatus())
		});
	});
	await page.route(/\/api\/databricks\/clusters(\?.*)?$/, async (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ clusters: [] }) })
	);
	const seen: Record<string, unknown>[] = [];
	await page.route(/\/api\/databricks\/upload$/, async (route) => {
		const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
		seen.push(body);
		const path = `/Users/${USER}/${String(body.prefix ?? '')}notebook${String(body.postfix ?? '')}`;
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ ok: true, status: 'uploaded', path, url: null, overwritten: false })
		});
	});
	return seen;
}

/**
 * Open one of the two instances.
 *
 * The workspace is fixed by that launcher's own `-w`, so WHICH project this is, is
 * decided by which URL is passed - there is deliberately no `?ws=` query parameter,
 * which the app does not read (`workspaceRoot()` is `CELLAR_WORKSPACE || cwd`) and
 * which would have read as if a single instance could be pointed at either project.
 */
async function openProject(page: Page, url: string): Promise<void> {
	touched.add(url);
	await page.goto(url);
	const openBtn = page.getByTestId('empty-open-notebook');
	// Settle on whichever the shell paints - the empty state, or a notebook that is
	// already open - BEFORE probing. Probed earlier, a slow first paint reports the
	// button invisible, the click becomes a no-op, and the wait below then times out
	// on a notebook nothing ever opened (a real flake under `workers: 2`).
	await expect(openBtn.or(page.locator('[data-testid="cell"]:visible').first())).toBeVisible();
	if (await openBtn.isVisible().catch(() => false)) await openBtn.click();
	await expect(page.locator('[data-testid="cell"]:visible').first()).toBeVisible();
}

async function openDatabricksSection(page: Page): Promise<void> {
	await openSidebarSection(page, 'databricks', 'databricks-body');
}

async function openSettings(page: Page): Promise<void> {
	await page.getByTestId('app-menu').click();
	await page.getByTestId('open-settings').click();
	await expect(page.getByTestId('settings-modal')).toBeVisible();
}

async function closeSettings(page: Page): Promise<void> {
	await page.getByTestId('settings-close').click();
	await expect(page.getByTestId('settings-modal')).toHaveCount(0);
}

/**
 * That project's OWN prefix, as the SERVER store holds it - what a reload reads back.
 *
 * The field's write is debounced client-side, so `fill()` followed straight by
 * `page.reload()` rests on the unload-time `keepalive` PUT being PROCESSED before the
 * new document's SSR read: the browser guarantees the request survives the navigation,
 * not that the server has finished with it. Losing that race re-seeds the global
 * default, which is precisely the symptom these tests exist to catch - so a flake here
 * would read as a real regression. Poll this until the write has landed, then reload.
 *
 * Note the value polled for after CLEARING is the empty string, not `undefined`: an
 * emptied field persists as `''` on purpose, because that is what outranks the global
 * default. Waiting for the key to be absent would be waiting for the opposite rule.
 */
async function storedProjectPrefix(page: Page, url: string): Promise<unknown> {
	const res = await page.request.get(`${url}/api/ui-state`);
	return ((await res.json()) as Record<string, unknown>)[PREFIX_KEY];
}

/** The global store as it is ON DISK - what another instance would read back. */
function storedDefaults(): Record<string, unknown> {
	try {
		return JSON.parse(readFileSync(settingsFile, 'utf8'));
	} catch {
		return {};
	}
}

/**
 * Set the cross-project default THROUGH one instance's own store, and wait for it to
 * reach the file - which is what another instance reads back.
 *
 * Writing it through a server rather than into the file behind everyone's back is
 * what keeps the seeding honest: this is the same store the Settings pane writes, so
 * a test that needs a default in place starts from the state the UI would have left.
 */
async function seedGlobalDefault(page: Page, url: string, prefix: string): Promise<void> {
	touched.add(url);
	await expect
		.poll(async () => {
			await page.request.put(`${url}/api/user-settings`, { data: { [PREFIX_DEFAULT_KEY]: prefix } });
			return storedDefaults()[PREFIX_DEFAULT_KEY];
		})
		.toBe(prefix);
}

/**
 * Put the shared stores back, unconditionally - the whole reason this is a hook.
 *
 * Three stores sit behind this file: one global default, and one per-project affix per
 * instance. Restoring them as a trailing statement inside each test meant the restore
 * was skipped by precisely the failure that left them dirty, so one genuine regression
 * surfaced as several unrelated red tests.
 *
 * The UI clear is best-effort and carries its OWN short timeout: after a failure the
 * page can be in any state at all, and an auto-waiting `fill()` would burn the hook's
 * budget without ever reaching the authoritative reset below. The SERVER store is that
 * authority, and the PUT sits INSIDE the poll so a debounced write still in flight from
 * the page is simply overwritten by the next pass rather than racing the last one.
 */
async function resetStores(page: Page): Promise<void> {
	for (const id of ['settings-upload-prefix', 'settings-upload-postfix', 'databricks-upload-prefix', 'databricks-upload-postfix']) {
		const field = page.getByTestId(id);
		try {
			if (await field.isVisible().catch(() => false)) {
				await field.fill('', { timeout: UI_CLEAR_TIMEOUT_MS });
			}
		} catch {
			// Not in a state to type into - the stores below are the authority.
		}
	}
	const urls = [...touched];
	await expect
		.poll(async () => {
			const left: unknown[] = [];
			for (const url of urls) {
				try {
					await page.request.put(`${url}/api/user-settings`, {
						data: { [PREFIX_DEFAULT_KEY]: null, [POSTFIX_DEFAULT_KEY]: null }
					});
					await page.request.put(`${url}/api/ui-state`, {
						data: { [PREFIX_KEY]: null, [POSTFIX_KEY]: null }
					});
					left.push(await storedProjectPrefix(page, url));
				} catch {
					// A request that did not land says nothing about the store - keep polling.
					left.push('unread');
				}
			}
			const defaults = storedDefaults();
			left.push(defaults[PREFIX_DEFAULT_KEY], defaults[POSTFIX_DEFAULT_KEY]);
			return left.every((v) => v === undefined);
		})
		.toBe(true);
}

function localToday() {
	const d = new Date();
	const yyyy = String(d.getFullYear());
	const mm = String(d.getMonth() + 1).padStart(2, '0');
	return { yyyymm: `${yyyy}${mm}`, dashed: `${yyyy}-${mm}` };
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	projectA = mkdtempSync(join(tmpdir(), 'cellar-e2e-defaults-a-'));
	projectB = mkdtempSync(join(tmpdir(), 'cellar-e2e-defaults-b-'));
	settingsDir = mkdtempSync(join(tmpdir(), 'cellar-e2e-defaults-home-'));
	settingsFile = join(settingsDir, 'settings.json');
	// The SAME global store for both: one user, two projects. Booting alone reads
	// nothing - each app loads the file on its first SSR page load, which is what lets
	// the ordering below have A write it before B ever looks.
	const [a, b] = await Promise.all([
		bootCellar(projectA, { CELLAR_USER_SETTINGS: settingsFile }),
		bootCellar(projectB, { CELLAR_USER_SETTINGS: settingsFile })
	]);
	launcherA = a.proc;
	urlA = a.url;
	launcherB = b.proc;
	urlB = b.url;
});

test.afterAll(async () => {
	for (const proc of [launcherA, launcherB]) if (proc) killCellar(proc);
	launcherA = null;
	launcherB = null;
	for (const d of [projectA, projectB, settingsDir]) {
		if (d && existsSync(d)) {
			try {
				rmSync(d, { recursive: true, force: true });
			} catch {
				/* best effort */
			}
		}
	}
});

/* Unconditional, and `resetStores` explains why that matters. */
test.afterEach(async ({ page }) => {
	await resetStores(page);
});

test('project A sets its own affix, then a default - and keeps its own', async ({ page }) => {
	await mockDatabricks(page);
	await openProject(page, urlA);
	await openDatabricksSection(page);

	// This project answers for itself.
	await page.getByTestId('databricks-upload-prefix').fill('team_');
	await expect(page.getByTestId('databricks-upload-preview')).toHaveText('team_notebook');
	await expect.poll(() => storedProjectPrefix(page, urlA)).toBe('team_');

	// The user then sets a cross-project default that says something quite different.
	await openSettings(page);
	// The token buttons are here too: this is where the pattern is authored, so it is
	// where the vocabulary is worth the most.
	await expect(page.getByTestId('settings-upload-token')).toHaveCount(UPLOAD_DATE_TOKENS.length);
	await page.getByTestId('settings-upload-prefix').fill('{YYYYMM}_');
	// Settings shows what it resolves to, through the same resolver the sidebar and the
	// server use - a fourth opinion about the name is exactly what must not exist.
	const { yyyymm } = localToday();
	await expect(page.getByTestId('settings-upload-preview')).toHaveText(`${yyyymm}_notebook`);
	// It is the PATTERN that persists, not today's resolved date.
	await expect.poll(() => storedDefaults()[PREFIX_DEFAULT_KEY]).toBe('{YYYYMM}_');
	await closeSettings(page);

	// A is UNTOUCHED by it - a default that overrode would silently rewrite naming the
	// user set deliberately, project by project.
	await page.reload();
	await openProject(page, urlA);
	await openDatabricksSection(page);
	await expect(page.getByTestId('databricks-upload-prefix')).toHaveValue('team_');
	await expect(page.getByTestId('databricks-upload-preview')).toHaveText('team_notebook');
});

test('project B - a different workspace, never asked - inherits it, and uploads under it', async ({
	page
}) => {
	// The cross-project half, and the whole reason the default exists: B is a separate
	// project served by a separate launcher on a separate port, which has never had an
	// affix of its own. The default is written through A's store, so what B reads is a
	// file another instance wrote - never one this test handed it directly.
	await seedGlobalDefault(page, urlA, '{YYYYMM}_');
	const seen = await mockDatabricks(page);
	await openProject(page, urlB);
	await openDatabricksSection(page);

	const { yyyymm } = localToday();
	await expect(page.getByTestId('databricks-upload-prefix')).toHaveValue('{YYYYMM}_');
	await expect(page.getByTestId('databricks-upload-preview')).toHaveText(`${yyyymm}_notebook`);

	// …and it is a real default, not decoration: the upload goes out under it, expanded.
	await page.getByTestId('databricks-upload').click();
	// Polled, never read straight after the click: `click()` resolves once the event is
	// dispatched in the renderer, while the request and the route interception are two
	// further hops back into Node - so a synchronous read fails against working code.
	await expect.poll(() => seen.length).toBe(1);
	expect(seen[0].prefix).toBe(`${yyyymm}_`);
});

test('a default changed with the panel ALREADY OPEN reaches it - no reload', async ({ page }) => {
	// The Databricks section mounts lazily and is then kept mounted for the session, so
	// a one-shot read at mount left a default set afterwards invisible until a reload -
	// while the Settings copy promised it applied to every project without one of its
	// own. This is the ordinary flow: the panel is open, and Settings is opened over it.
	await seedGlobalDefault(page, urlB, '{YYYYMM}_');
	await mockDatabricks(page);
	await openProject(page, urlB);
	await openDatabricksSection(page);
	const prefixField = page.getByTestId('databricks-upload-prefix');
	await expect(prefixField).toHaveValue('{YYYYMM}_');

	await openSettings(page);
	await page.getByTestId('settings-upload-prefix').fill('GLOBAL_');
	await closeSettings(page);

	// No `page.reload()` here, deliberately: reloading is what hid this.
	await expect(prefixField).toHaveValue('GLOBAL_');
	await expect(page.getByTestId('databricks-upload-preview')).toHaveText('GLOBAL_notebook');
	// The browser's write is debounced, so ending the test here would tear the context
	// down with the PUT still queued, and the reset would then be racing it.
	await expect.poll(() => storedDefaults()[PREFIX_DEFAULT_KEY]).toBe('GLOBAL_');
});

test('a default change that MOVES the affix drops the confirm built from the old one', async ({
	page
}) => {
	// The armed replace confirm names one workspace path, resolved from the affixes as
	// they were when it armed. A default changed in Settings re-seeds the field, so
	// leaving the box up would put two disagreeing names on screen at once - the
	// preview saying `NEW_notebook` over a confirm offering to overwrite
	// `GLOBAL_notebook`. Typing already drops it; a seed has to as well, or the rule
	// holds for one writer of the affixes and not the other.
	await seedGlobalDefault(page, urlB, 'GLOBAL_');
	await mockDatabricks(page);
	await page.route(/\/api\/databricks\/upload$/, async (route) => {
		const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				ok: true,
				status: 'exists',
				path: `/Users/${USER}/${String(body.prefix ?? '')}notebook`
			})
		});
	});
	await openProject(page, urlB);
	await openDatabricksSection(page);
	await expect(page.getByTestId('databricks-upload-prefix')).toHaveValue('GLOBAL_');

	await page.getByTestId('databricks-upload').click();
	const confirm = page.getByTestId('databricks-upload-confirm-box');
	await expect(confirm).toBeVisible();
	await expect(confirm).toContainText('GLOBAL_notebook');

	await openSettings(page);
	await page.getByTestId('settings-upload-prefix').fill('NEW_');
	await closeSettings(page);
	// Confirm it REACHED the file, so the reset is not racing a debounced write still
	// queued behind a page this test is about to be finished with.
	await expect.poll(() => storedDefaults()[PREFIX_DEFAULT_KEY]).toBe('NEW_');

	await expect(page.getByTestId('databricks-upload-prefix')).toHaveValue('NEW_');
	await expect(page.getByTestId('databricks-upload-preview')).toHaveText('NEW_notebook');
	await expect(confirm).toHaveCount(0);

	// A seed that changes NOTHING must not dismiss a still-accurate box, so re-arm and
	// fold the section away and back - the other trigger, and the common one.
	await page.getByTestId('databricks-upload').click();
	await expect(confirm).toContainText('NEW_notebook');
	await page.getByTestId('section-databricks').click();
	await expect(page.getByTestId('databricks-body')).toBeHidden();
	await openDatabricksSection(page);
	await expect(confirm).toContainText('NEW_notebook');
	await page.getByTestId('databricks-upload-cancel').click();
});

test('a default changed MID-REPLACE never discards the reply, and lands once it settles', async ({
	page
}) => {
	// The other side of the rule above, and the dangerous one: clearing the feedback
	// also bumps the upload's generation guard, so a seed firing while a replace is IN
	// FLIGHT made the settled reply be dropped as superseded - the file was overwritten
	// in Databricks, the panel said nothing about it, and the box the user was watching
	// vanished mid-replace. That is exactly the silent clobber Cancel is deliberately
	// inert for. So an in-flight upload DEFERS the whole seed.
	await seedGlobalDefault(page, urlB, 'GLOBAL_');
	await mockDatabricks(page);
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	await page.route(/\/api\/databricks\/upload$/, async (route) => {
		const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
		const path = `/Users/${USER}/${String(body.prefix ?? '')}notebook`;
		if (body.overwrite !== true) {
			return route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ ok: true, status: 'exists', path, url: null, overwritten: false })
			});
		}
		await held;
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ ok: true, status: 'uploaded', path, url: null, overwritten: true })
		});
	});
	await openProject(page, urlB);
	await openDatabricksSection(page);
	await expect(page.getByTestId('databricks-upload-prefix')).toHaveValue('GLOBAL_');

	await page.getByTestId('databricks-upload').click();
	const confirm = page.getByTestId('databricks-upload-confirm-box');
	await expect(confirm).toContainText('GLOBAL_notebook');
	await page.getByTestId('databricks-upload-replace').click();
	await expect(page.getByTestId('databricks-upload-replace')).toBeDisabled();

	// The user wanders off to Settings while the big notebook uploads.
	await openSettings(page);
	await page.getByTestId('settings-upload-prefix').fill('HELD_');
	await closeSettings(page);
	// The box is still up, still naming the path being overwritten - it must not be
	// pulled out from under a replace that is happening.
	await expect(confirm).toContainText('GLOBAL_notebook');
	// Confirm it REACHED the file, so the reset is not racing a debounced write still
	// queued behind a page this test is about to be finished with.
	await expect.poll(() => storedDefaults()[PREFIX_DEFAULT_KEY]).toBe('HELD_');

	release();

	// The outcome renders: the reply was not thrown away, and it names the affixes the
	// confirm pinned rather than the one Settings has since moved to.
	const note = page.getByTestId('databricks-upload-note');
	await expect(note).toContainText('Replaced in your Databricks workspace');
	await expect(note).toContainText(`/Users/${USER}/GLOBAL_notebook`);
	await expect(confirm).toHaveCount(0);

	// …and the deferred seed then lands, WITHOUT taking the outcome with it: the note is
	// a past-tense record of what happened, the field is a promise about what is next.
	await expect(page.getByTestId('databricks-upload-prefix')).toHaveValue('HELD_');
	await expect(page.getByTestId('databricks-upload-preview')).toHaveText('HELD_notebook');
	await expect(note).toContainText(`/Users/${USER}/GLOBAL_notebook`);
});

test('a default changed mid-upload never leaves an `exists` reply with nothing on screen', async ({
	page
}) => {
	// The sibling of the test above, and the case where "keep the outcome, drop the
	// pending action" was wrong. An `exists` reply sets NEITHER the note nor an error,
	// so the confirm box is the entire outcome: dropping it left the user watching an
	// upload that appeared to have done nothing, with the file still unwritten and the
	// one control that could resolve that gone.
	await seedGlobalDefault(page, urlB, 'GLOBAL_');
	await mockDatabricks(page);
	const seen: Record<string, unknown>[] = [];
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	await page.route(/\/api\/databricks\/upload$/, async (route) => {
		const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
		seen.push(body);
		const path = `/Users/${USER}/${String(body.prefix ?? '')}notebook`;
		if (body.overwrite === true) {
			return route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ ok: true, status: 'uploaded', path, url: null, overwritten: true })
			});
		}
		// Held, so the default below really does change while THIS reply is in flight -
		// which is what makes the seed defer and land on top of the armed box.
		await held;
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ ok: true, status: 'exists', path, url: null, overwritten: false })
		});
	});
	await openProject(page, urlB);
	await openDatabricksSection(page);
	await expect(page.getByTestId('databricks-upload-prefix')).toHaveValue('GLOBAL_');

	await page.getByTestId('databricks-upload').click();
	await expect(page.getByTestId('databricks-upload')).toBeDisabled();

	await openSettings(page);
	await page.getByTestId('settings-upload-prefix').fill('HELD_');
	await closeSettings(page);
	// Confirm it REACHED the file, so the reset is not racing a debounced write still
	// queued behind a page this test is about to be finished with.
	await expect.poll(() => storedDefaults()[PREFIX_DEFAULT_KEY]).toBe('HELD_');

	release();

	// The box arms and STAYS - and still names its own path, which is what makes
	// keeping it honest rather than merely kinder.
	const confirm = page.getByTestId('databricks-upload-confirm-box');
	await expect(confirm).toBeVisible();
	await expect(confirm).toContainText(`/Users/${USER}/GLOBAL_notebook`);
	// …while the fields themselves have moved on to the new default.
	await expect(page.getByTestId('databricks-upload-prefix')).toHaveValue('HELD_');
	await expect(page.getByTestId('databricks-upload-preview')).toHaveText('HELD_notebook');

	// Replace overwrites the path the BOX named, not the one these fields would resolve
	// to now: the pinned affixes are precisely why the box was safe to keep.
	await page.getByTestId('databricks-upload-replace').click();
	await expect.poll(() => seen.length).toBe(2);
	expect(seen[1]).toMatchObject({ overwrite: true, prefix: 'GLOBAL_' });
	await expect(page.getByTestId('databricks-upload-note')).toContainText(
		`/Users/${USER}/GLOBAL_notebook`
	);
});

test('an invalid default is refused, and the last valid one survives it', async ({ page }) => {
	// Blast radius is what makes this stricter than the sidebar's own field: an unusable
	// affix there disables the upload in the one project on screen, while an unusable
	// DEFAULT disables it in every project that never set its own - under a message
	// naming a "prefix" the user never typed into there, and which clearing that
	// project's field only opts that one project out of.
	await mockDatabricks(page);
	await openProject(page, urlB);
	await openSettings(page);

	const prefix = page.getByTestId('settings-upload-prefix');
	await prefix.fill('GOOD_');
	await expect.poll(() => storedDefaults()[PREFIX_DEFAULT_KEY]).toBe('GOOD_');

	// A separator would silently redirect the upload elsewhere in the workspace tree.
	await prefix.fill('bad/name_');
	await expect(page.getByTestId('settings-upload-error')).toBeVisible();
	// Refused, never repaired: the field still shows exactly what was typed, so the
	// error explains something the user can see.
	await expect(prefix).toHaveValue('bad/name_');
	// Nothing invalid reaches the store, and the last VALID default is left standing -
	// deleting it would discard a working setting over a half-typed character. Waited
	// out rather than polled: the write is debounced, so this is a claim about what does
	// NOT happen.
	await page.waitForTimeout(1_000);
	expect(storedDefaults()[PREFIX_DEFAULT_KEY]).toBe('GOOD_');

	// Fixing it persists again - the refusal is a gate, not a latch.
	await prefix.fill('FIXED_');
	await expect(page.getByTestId('settings-upload-error')).toHaveCount(0);
	await expect.poll(() => storedDefaults()[PREFIX_DEFAULT_KEY]).toBe('FIXED_');
});

test('one invalid field never costs the OTHER field its value', async ({ page }) => {
	// The two defaults are independent keys, so the verdict has to be per FIELD. Judged
	// by the assembled PAIR, a broken prefix refused to store a perfectly good postfix,
	// and the write that ran when the prefix was fixed carried only the prefix - so the
	// postfix the user typed was lost with nothing left that would ever write it.
	await mockDatabricks(page);
	await openProject(page, urlB);
	await openSettings(page);

	const prefix = page.getByTestId('settings-upload-prefix');
	const postfix = page.getByTestId('settings-upload-postfix');

	await prefix.fill('bad/name_');
	await expect(page.getByTestId('settings-upload-error')).toBeVisible();

	// Typed while the pane is showing an error about the OTHER field. It is a usable
	// affix on its own, so it is stored on its own.
	await postfix.fill('_end');
	await expect.poll(() => storedDefaults()[POSTFIX_DEFAULT_KEY]).toBe('_end');
	// …while the prefix is still refused.
	expect(storedDefaults()[PREFIX_DEFAULT_KEY]).toBeUndefined();

	// Fixing the prefix leaves BOTH in the store - nothing typed along the way is
	// stranded, which is what the per-field rule buys.
	await prefix.fill('x_');
	await expect(page.getByTestId('settings-upload-error')).toHaveCount(0);
	await expect.poll(() => storedDefaults()[PREFIX_DEFAULT_KEY]).toBe('x_');
	expect(storedDefaults()[POSTFIX_DEFAULT_KEY]).toBe('_end');
	await expect(page.getByTestId('settings-upload-preview')).toHaveText('x_notebook_end');
});

test('CLEARING a project field is an answer, so the default does not creep back', async ({ page }) => {
	// A default has to be in force, or there would be nothing to creep back.
	await seedGlobalDefault(page, urlB, 'GLOBAL_');
	await mockDatabricks(page);
	await openProject(page, urlB);
	await openDatabricksSection(page);
	await expect(page.getByTestId('databricks-upload-prefix')).toHaveValue('GLOBAL_');

	// "No prefix on this project" - said by emptying the field, the only way to say it.
	await page.getByTestId('databricks-upload-prefix').fill('');
	await expect(page.getByTestId('databricks-upload-preview')).toHaveText('notebook');
	// The empty string, not an absent key - saying "no prefix here" is exactly what has
	// to reach the store for the reload below to be a test of the rule rather than of
	// which of the two won a race.
	await expect.poll(() => storedProjectPrefix(page, urlB)).toBe('');

	await page.reload();
	await openProject(page, urlB);
	await openDatabricksSection(page);
	// Re-seeding `GLOBAL_` here would undo the clearing the moment the page reloaded,
	// leaving no way at all to opt one project out of a default.
	await expect(page.getByTestId('databricks-upload-prefix')).toHaveValue('');
	await expect(page.getByTestId('databricks-upload-preview')).toHaveText('notebook');
});

test('the default is a FILE, not per-origin state - the reason it is not localStorage', async ({
	page
}) => {
	// A relaunch means a brand-new origin, so anything kept per-origin would be gone.
	// Restarting a launcher here would cost the suite its instance, so this asserts the
	// same thing at the layer that decides it - what is ON DISK, and what a fresh SSR
	// load hands the browser. Written through A, read back through B: two origins, one
	// file, which is the whole claim.
	await seedGlobalDefault(page, urlA, 'GLOBAL_');
	touched.add(urlB);
	expect(storedDefaults()[PREFIX_DEFAULT_KEY]).toBe('GLOBAL_');
	const res = await page.request.get(`${urlB}/api/user-settings`);
	expect((await res.json())[PREFIX_DEFAULT_KEY]).toBe('GLOBAL_');
});

test('the default field takes the same tokens - and the same not-a-token warning', async ({ page }) => {
	await mockDatabricks(page);
	await openProject(page, urlB);
	await openSettings(page);

	const prefix = page.getByTestId('settings-upload-prefix');
	const warning = page.getByTestId('settings-upload-token-warning');

	// A near-miss fails silently everywhere it is not named, and this is where the
	// pattern is written - so it is named here too.
	await prefix.fill('{YYYYMMD}_');
	await expect(warning).toBeVisible();
	await expect(warning).toContainText('{YYYYMMD}');

	// A brace SPLIT across the two fields is not a run at all - the name is
	// prefix + stem + postfix, so nothing braced can span them, and warning about a
	// `{}` that appears in neither field would be a warning about nothing.
	await prefix.fill('a{');
	await page.getByTestId('settings-upload-postfix').fill('}b');
	await expect(warning).toHaveCount(0);

	// A chip writes the exact braced form into the field last focused.
	await page.getByTestId('settings-upload-postfix').fill('');
	await prefix.fill('');
	await page.locator('[data-testid="settings-upload-token"][data-token="{YYYY-MM}"]').click();
	await expect(prefix).toHaveValue('{YYYY-MM}');
	await expect(warning).toHaveCount(0);
	const { dashed } = localToday();
	await expect(page.getByTestId('settings-upload-preview')).toHaveText(`${dashed}notebook`);
});
