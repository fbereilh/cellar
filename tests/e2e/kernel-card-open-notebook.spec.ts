import { test, expect, type Page } from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar, openSidebarSection } from './harness';

/**
 * A Kernels-sidebar card opens the notebook its kernel belongs to.
 *
 * The card set already spans BOTH shapes this has to serve: a notebook with an
 * open tab, and one whose tab was CLOSED while its kernel stayed alive holding
 * the namespace. The second is the one with no route at all before this - it
 * rendered as an inert <span> - and it is the one that must open a tab.
 *
 * What is proved here and cannot be proved anywhere else (vitest runs without
 * the SvelteKit plugin, so neither component can be mounted; the unit suite's
 * `kernel-card-open.test.ts` guards the wiring and executes the naming rule):
 *   1. a click on a CLOSED card opens its notebook, and the card names the
 *      notebook rather than its kernelspec;
 *   2. the keyboard reaches the same control and Enter activates it;
 *   3. an already-open notebook is SURFACED, never duplicated, and an already
 *      ACTIVE one is not reloaded (asserted by counting the page's own loads);
 *   4. the per-kernel controls still work and are not triggered by the open
 *      action - and opening does not disturb the kernel;
 *   5. a card whose file was moved out from under its live kernel REPORTS that,
 *      mints no tab, and names the notebook workspace-relative - never leaking
 *      the absolute server path the throw carries.
 *
 * The row's hover LAYOUT is deliberately not pinned here. Reserving room for the
 * out-of-flow control cluster was reverted: the controls sit in flow as they did
 * before this change, so the pre-existing narrow-sidebar name truncation is back
 * and is a separate task. The tests that measured that mechanism went with it.
 *
 * Boots the REAL launcher, so it SKIPS without the kernel runtime.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

/** nbformat 4.5 notebook with deterministic cell ids. */
function notebook(prefix: string, sources: string[]): string {
	const cells = sources.map((src, i) => ({
		cell_type: 'code',
		id: `${prefix}-cell-${String(i).padStart(2, '0')}`,
		metadata: {},
		execution_count: null,
		outputs: [],
		source: src.split('\n').map((l, j, a) => (j < a.length - 1 ? l + '\n' : l))
	}));
	return JSON.stringify({
		cells,
		metadata: { kernelspec: { name: 'python3', display_name: 'python3' } },
		nbformat: 4,
		nbformat_minor: 5
	});
}

/** Run a cell from the page's own fetch so the notebook's kernel boots. */
async function bootKernel(page: Page, nb: string, cellId: string, source: string): Promise<void> {
	await page.evaluate(
		async ({ nb, cellId, source }) => {
			await fetch(`/api/cells/${cellId}/run`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ nb, source })
			}).catch(() => {});
		},
		{ nb, cellId, source }
	);
	await expect
		.poll(
			async () =>
				page.evaluate(async (p) => {
					const r = await fetch('/api/kernel').then((x) => x.json());
					return (r.kernels as Array<{ path: string }>).some((k) => k.path === p);
				}, nb),
			{ timeout: 60_000 }
		)
		.toBe(true);
}

/** The Kernels row for `path` (cards are keyed by workspace-relative path). */
const card = (page: Page, path: string) => page.locator(`[data-testid="kernel-card"][data-nb-path="${path}"]`);
const tabTitles = (page: Page) => page.getByTestId('tab').allTextContents();

async function openKernels(page: Page): Promise<void> {
	await openSidebarSection(page, 'kernels', 'kernels-body');
}

/** That notebook's live kernel id / session epoch, straight from the server. */
const kernelIdFor = (page: Page, nb: string) =>
	page.evaluate(async (p) => {
		const r = await fetch('/api/kernel').then((x) => x.json());
		return (r.kernels as Array<{ path: string; id: string }>).find((k) => k.path === p)?.id ?? null;
	}, nb);
const sessionIdFor = (page: Page, nb: string) =>
	page.evaluate(async (p) => {
		const r = await fetch('/api/kernel').then((x) => x.json());
		return (
			(r.kernels as Array<{ path: string; session_id: unknown }>).find((k) => k.path === p)?.session_id ?? null
		);
	}, nb);

/** Close the tab whose title contains `name`, if it is open. */
async function closeTab(page: Page, name: string): Promise<void> {
	const tab = page.getByTestId('tab').filter({ hasText: name });
	if (await tab.count()) {
		await tab.first().getByTestId('tab-close').click();
		await expect(page.getByTestId('tab').filter({ hasText: name })).toHaveCount(0);
	}
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-kcard-'));
	writeFileSync(join(workspace, 'notebook.ipynb'), notebook('main', ['main_var = 0']));
	writeFileSync(join(workspace, 'alpha.ipynb'), notebook('alpha', ['alpha_var = 1']));
	writeFileSync(join(workspace, 'beta.ipynb'), notebook('beta', ['beta_var = 2']));
	writeFileSync(join(workspace, 'gamma.ipynb'), notebook('gamma', ['gamma_var = 3']));
	const booted = await bootCellar(workspace);
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

test('a closed card opens its notebook, by mouse and by keyboard', async ({ page }) => {
	test.setTimeout(240_000);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	// Open both, boot both kernels, then close alpha's tab so its card is the
	// tab-CLOSED shape (kernel alive, no tab) this action exists for.
	for (const nb of ['alpha.ipynb', 'beta.ipynb']) {
		await page.getByTestId('tree-file').filter({ hasText: nb }).first().dblclick();
	}
	await bootKernel(page, 'alpha.ipynb', 'alpha-cell-00', 'alpha_var = 1');
	await bootKernel(page, 'beta.ipynb', 'beta-cell-00', 'beta_var = 2');
	await closeTab(page, 'alpha.ipynb');
	await openKernels(page);

	const alpha = card(page, 'alpha.ipynb').getByTestId('kernel-notebook');
	await expect(alpha).toBeVisible({ timeout: 30_000 });
	// The card NAMES the notebook. The regression this replaced fell back to the
	// kernelspec name, so every tab-closed card read `python3`.
	await expect(alpha).toContainText('alpha.ipynb');
	await expect(alpha).not.toContainText('python3');

	// --- mouse ---
	await alpha.click();
	await expect(page.getByTestId('tab').filter({ hasText: 'alpha.ipynb' })).toHaveCount(1);
	await expect(page.locator('[data-testid="cell"]:visible')).toHaveCount(1, { timeout: 30_000 });
	await expect(page.locator('[data-testid="cell"]:visible')).toContainText('alpha_var');

	// --- keyboard: the same control, focusable, activated by Enter ---
	await closeTab(page, 'alpha.ipynb');
	await openKernels(page);
	const alpha2 = card(page, 'alpha.ipynb').getByTestId('kernel-notebook');
	await alpha2.focus();
	expect(
		await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))
	).toBe('kernel-notebook');
	// The accessible name is explicit - the visible text is only a filename.
	await expect(alpha2).toHaveAttribute('aria-label', /alpha\.ipynb/);
	await page.keyboard.press('Enter');
	await expect(page.getByTestId('tab').filter({ hasText: 'alpha.ipynb' })).toHaveCount(1);
	await expect(page.locator('[data-testid="cell"]:visible')).toContainText('alpha_var', { timeout: 30_000 });
});

test('an open notebook is surfaced, never duplicated; an active one is not reloaded', async ({ page }) => {
	test.setTimeout(240_000);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	for (const nb of ['alpha.ipynb', 'beta.ipynb']) {
		await page.getByTestId('tree-file').filter({ hasText: nb }).first().dblclick();
	}
	await bootKernel(page, 'alpha.ipynb', 'alpha-cell-00', 'alpha_var = 1');
	await bootKernel(page, 'beta.ipynb', 'beta-cell-00', 'beta_var = 2');
	await openKernels(page);

	// Make alpha the active tab, so beta is open-but-not-active.
	await page.getByTestId('tab').filter({ hasText: 'alpha.ipynb' }).first().click();
	await expect(page.locator('[data-testid="cell"]:visible')).toContainText('alpha_var', { timeout: 30_000 });
	const before = (await tabTitles(page)).length;

	// --- open but NOT active → activates it, opens no second tab ---
	await card(page, 'beta.ipynb').getByTestId('kernel-notebook').click();
	await expect(page.locator('[data-testid="cell"]:visible')).toContainText('beta_var', { timeout: 30_000 });
	expect((await tabTitles(page)).length).toBe(before);
	expect((await tabTitles(page)).filter((t) => t.includes('beta.ipynb')).length).toBe(1);

	// --- already ACTIVE → a no-op: no new tab, and the notebook is not reloaded.
	// Counted on the wire, because "it still looks right" cannot tell a no-op from
	// a reload that landed on the same content.
	const loads: string[] = [];
	page.on('request', (r) => {
		const u = new URL(r.url());
		if (u.pathname === '/api/notebooks') loads.push(u.search);
	});
	await page.waitForTimeout(1_000);
	loads.length = 0;
	await card(page, 'beta.ipynb').getByTestId('kernel-notebook').click();
	await page.waitForTimeout(1_500);
	expect(loads.filter((s) => s.includes('beta.ipynb'))).toEqual([]);
	expect((await tabTitles(page)).length).toBe(before);
	await expect(page.locator('[data-testid="cell"]:visible')).toContainText('beta_var');
});

test('the per-kernel controls are unaffected: opening does not act on the kernel, and Restart still does', async ({
	page
}) => {
	test.setTimeout(240_000);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await page.getByTestId('tree-file').filter({ hasText: 'gamma.ipynb' }).first().dblclick();
	await bootKernel(page, 'gamma.ipynb', 'gamma-cell-00', 'gamma_var = 3');
	await openKernels(page);

	const kernelId = () => kernelIdFor(page, 'gamma.ipynb');
	const sessionId = () => sessionIdFor(page, 'gamma.ipynb');
	const before = await kernelId();
	const beforeSession = await sessionId();
	expect(before).toBeTruthy();

	// Opening must not interrupt / restart / shut down anything.
	await closeTab(page, 'gamma.ipynb');
	await openKernels(page);
	await card(page, 'gamma.ipynb').getByTestId('kernel-notebook').click();
	await expect(page.locator('[data-testid="cell"]:visible')).toContainText('gamma_var', { timeout: 30_000 });
	expect(await kernelId()).toBe(before);
	expect(await sessionId()).toBe(beforeSession);

	// And the control beside it still restarts that kernel - hovering the row is
	// what reveals the controls, exactly as before.
	const tabsBefore = (await tabTitles(page)).length;
	const row = card(page, 'gamma.ipynb');
	await row.hover();
	await row.getByTestId('kernel-restart').click();
	await expect.poll(async () => sessionId(), { timeout: 60_000 }).not.toBe(beforeSession);
	// A control click is not an open: no tab was added by it.
	expect((await tabTitles(page)).length).toBe(tabsBefore);
});

test('a card whose file moved out from under its kernel reports it and mints no tab', async ({ page }) => {
	test.setTimeout(240_000);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await page.getByTestId('tree-file').filter({ hasText: 'beta.ipynb' }).first().dblclick();
	await bootKernel(page, 'beta.ipynb', 'beta-cell-00', 'beta_var = 2');
	await closeTab(page, 'beta.ipynb');
	await openKernels(page);
	await expect(card(page, 'beta.ipynb')).toBeVisible({ timeout: 30_000 });

	// Rename it. `POST /api/fs/op` shuts a kernel down only on DELETE, so a rename
	// rekeys the live document and leaves the kernel registered under the OLD path
	// - a card naming a notebook that can no longer be loaded.
	await page.evaluate(async () => {
		await fetch('/api/fs/op', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ op: 'rename', path: 'beta.ipynb', name: 'beta-moved.ipynb' })
		});
	});
	await openKernels(page);
	const stale = card(page, 'beta.ipynb').getByTestId('kernel-notebook');
	await expect(stale).toBeVisible({ timeout: 30_000 });

	const tabsBefore = (await tabTitles(page)).length;
	await stale.click();
	// It SAYS so, on the shell's transient status line - and says WHY, which is the
	// server's own reason rather than a bare status code (the path alone would pass
	// against a message that told the user nothing).
	await expect(page.getByTestId('app-notice')).toBeVisible({ timeout: 15_000 });
	await expect(page.getByTestId('app-notice')).toContainText('beta.ipynb');
	await expect(page.getByTestId('app-notice')).toContainText('not found');
	// …addressing the notebook the way every other surface here does. `loadDoc`
	// throws `'notebook not found: ' + abs`, so forwarding it verbatim put the
	// machine's own layout in front of the user. Asserted against the REAL
	// workspace path rather than a pattern, so it fails on the exact leak.
	const notice = (await page.getByTestId('app-notice').textContent()) ?? '';
	expect(notice).not.toContain(workspace);
	expect(notice).not.toMatch(/(?:^|\s)\//);
	// …and leaves no tab behind - not even one rendering a load error.
	expect((await tabTitles(page)).length).toBe(tabsBefore);
	await expect(page.getByTestId('notebook-load-error')).toHaveCount(0);
});

/**
 * The CANONICAL notebook's stale card is refused like any other - and the reason
 * it needs its own test is that it is the one path where the pre-flight's chosen
 * predicate is too generous.
 *
 * `loadDoc` MATERIALISES a starter document for the canonical path when the file
 * is missing (that is what lets an empty workspace render a shell), so a plain
 * "can the server load this?" answers YES for a canonical notebook that has been
 * renamed away. What that produced was not merely a confusing tab: it held one
 * empty cell under the old name, and running a cell in it wrote `notebook.ipynb`
 * back to disk under exactly the name the user had renamed. So the file is
 * asserted on the REAL FILESYSTEM here, not through the UI - the UI is what was
 * lying.
 */
test('the canonical notebook, renamed out from under its kernel, is refused and re-creates no file', async ({
	page
}) => {
	test.setTimeout(240_000);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await page.getByTestId('tree-file').filter({ hasText: 'notebook.ipynb' }).first().dblclick();
	await bootKernel(page, 'notebook.ipynb', 'main-cell-00', 'main_var = 0');
	await closeTab(page, 'notebook.ipynb');
	await openKernels(page);
	await expect(card(page, 'notebook.ipynb')).toBeVisible({ timeout: 30_000 });

	// Same rename path as the non-canonical case above: it rekeys the live
	// document and leaves the kernel registered under the OLD path.
	await page.evaluate(async () => {
		await fetch('/api/fs/op', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ op: 'rename', path: 'notebook.ipynb', name: 'main-moved.ipynb' })
		});
	});
	await expect.poll(() => existsSync(join(workspace, 'notebook.ipynb')), { timeout: 15_000 }).toBe(false);
	await openKernels(page);
	const stale = card(page, 'notebook.ipynb').getByTestId('kernel-notebook');
	await expect(stale).toBeVisible({ timeout: 30_000 });

	const tabsBefore = (await tabTitles(page)).length;
	// Counted as a DELTA, not against zero: this spec shares one workspace and one
	// restored tab session, so an earlier test's renamed-away notebook can already
	// be rendering one.
	const errorsBefore = await page.getByTestId('notebook-load-error').count();
	await stale.click();
	// The harm first: a tab minted here would hold one empty starter cell under a
	// name the user renamed away, and the first run in it writes the file back.
	await page.waitForTimeout(1_000);
	expect((await tabTitles(page)).length).toBe(tabsBefore);
	expect(await page.getByTestId('notebook-load-error').count()).toBe(errorsBefore);
	expect(existsSync(join(workspace, 'notebook.ipynb'))).toBe(false);
	// …and it SAYS so rather than failing silently.
	await expect(page.getByTestId('app-notice')).toBeVisible({ timeout: 15_000 });
	await expect(page.getByTestId('app-notice')).toContainText('notebook.ipynb');
});
