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
 *   5. a card whose file was moved out from under its live kernel REPORTS that
 *      and mints no tab;
 *   6. the row's LAYOUT holds while the controls reveal - the RSS chip does not
 *      move, it and the controls are never both on screen, the name still gets
 *      the whole row at rest, and the control cluster sits exactly where it did.
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

	const kernelId = async () =>
		page.evaluate(async () => {
			const r = await fetch('/api/kernel').then((x) => x.json());
			return (r.kernels as Array<{ path: string; id: string }>).find((k) => k.path === 'gamma.ipynb')?.id ?? null;
		});
	const sessionId = async () =>
		page.evaluate(async () => {
			const r = await fetch('/api/kernel').then((x) => x.json());
			return (
				(r.kernels as Array<{ path: string; session_id: unknown }>).find((k) => k.path === 'gamma.ipynb')
					?.session_id ?? null
			);
		});
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
	// …and leaves no tab behind - not even one rendering a load error.
	expect((await tabTitles(page)).length).toBe(tabsBefore);
	await expect(page.getByTestId('notebook-load-error')).toHaveCount(0);
});

/**
 * The row's right slot is SHARED: the RSS chip holds it at rest, the four
 * controls take it on hover. Both of the ways that can go wrong were real
 * defects here, one of them shipped in this very change:
 *   - the controls IN FLOW reserved 102px of a 239px row permanently, so a
 *     closed card's name got about one character at the default sidebar width;
 *   - taking them out of flow and reserving the gutter on the name+memory
 *     WRAPPER shifted the chip ~108px on every hover, and since the padding
 *     change is instant while the controls fade, the chip slid back under the
 *     still-fading icons on the way out.
 * So the invariants are measured, not asserted in prose. Geometry here is
 * theme-independent by design, which is exactly why both themes are checked - a
 * token that quietly carried a size would show up as a difference.
 */
for (const theme of ['dim', 'cellar-light'] as const) {
	test(`the row's layout holds while the controls reveal (${theme})`, async ({ page }) => {
		test.setTimeout(240_000);
		await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
		await page.getByTestId('tree-file').filter({ hasText: 'alpha.ipynb' }).first().dblclick();
		await bootKernel(page, 'alpha.ipynb', 'alpha-cell-00', 'alpha_var = 1');
		await closeTab(page, 'alpha.ipynb');
		await openKernels(page);
		await page.evaluate((t) => {
			document.documentElement.dataset.theme = t;
		}, theme);

		const row = card(page, 'alpha.ipynb');
		const chip = row.getByTestId('kernel-memory');
		const controls = row.getByTestId('kernel-controls');
		const name = row.getByTestId('kernel-notebook');
		const opacity = (l: typeof chip) => l.evaluate((el) => getComputedStyle(el).opacity);
		// The name button's CONTENT edge - what the text is actually allowed to reach.
		// Its border box is `flex-1` and so cannot move; the gutter lives inside it.
		const nameContentRight = () =>
			name.evaluate((el) => el.getBoundingClientRect().right - parseFloat(getComputedStyle(el).paddingRight));
		await expect(chip).toBeVisible({ timeout: 30_000 });

		// Park the pointer and the caret off the row, so "at rest" really is: the
		// controls reveal on `:focus-within` as well as `:hover`.
		await page.mouse.move(0, 0);
		await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
		await expect.poll(() => opacity(controls)).toBe('0');
		const restRow = (await row.boundingBox())!;
		const restChip = (await chip.boundingBox())!;
		const restName = (await name.boundingBox())!;
		const restNameRight = await nameContentRight();
		expect(await opacity(chip)).toBe('1');
		// At rest the name owns the row - nothing invisible reserves a slot in front
		// of it. (In flow the control cluster left it ~20px at this sidebar width.)
		expect(restName.width).toBeGreaterThan(120);
		expect(await name.evaluate((el) => getComputedStyle(el).paddingRight)).toBe('0px');
		expect(restNameRight).toBeCloseTo(restChip.x - 8, 0);

		// --- revealed ---
		await row.hover();
		await expect.poll(() => opacity(controls)).toBe('1');
		const hotChip = (await chip.boundingBox())!;
		// THE headline invariant: the chip's box is identical across the reveal.
		expect(hotChip.x).toBeCloseTo(restChip.x, 1);
		expect(hotChip.y).toBeCloseTo(restChip.y, 1);
		expect(hotChip.width).toBeCloseTo(restChip.width, 1);
		// …and it is not merely un-moved but OUT of the way, never drawn under the
		// icons that have taken its slot.
		expect(await opacity(chip)).toBe('0');

		// The row does not grow, the name button's own box does not move (the gutter
		// is inside it, which is what keeps the chip still), and the controls sit
		// exactly where they did: right edge 8px in, vertically centred.
		const hotRow = (await row.boundingBox())!;
		expect(hotRow.height).toBeCloseTo(restRow.height, 1);
		const hotName = (await name.boundingBox())!;
		expect(hotName.x).toBeCloseTo(restName.x, 1);
		expect(hotName.width).toBeCloseTo(restName.width, 1);
		const ctrl = (await controls.boundingBox())!;
		expect(hotRow.x + hotRow.width - (ctrl.x + ctrl.width)).toBeCloseTo(8, 0);
		expect(ctrl.y + ctrl.height / 2).toBeCloseTo(hotRow.y + hotRow.height / 2, 0);
		// What DOES yield is the name's text, which re-truncates clear of the icons.
		expect(await nameContentRight()).toBeLessThanOrEqual(ctrl.x + 1);
		expect(restNameRight - (await nameContentRight())).toBeGreaterThan(90);

		// The handoff is SEQUENCED, so the two are never both on screen mid-fade -
		// each waits out the other's transition. Read off the browser's own resolved
		// timing rather than sampled frames, which would be a race.
		const ms = (v: string) => (v.endsWith('ms') ? parseFloat(v) : parseFloat(v) * 1000);
		const hot = await row.evaluate((el) => {
			const cs = (sel: string) => getComputedStyle(el.querySelector(`[data-testid="${sel}"]`)!);
			return {
				chipDelay: cs('kernel-memory').transitionDelay,
				chipDuration: cs('kernel-memory').transitionDuration,
				controlsDelay: cs('kernel-controls').transitionDelay
			};
		});
		// Hovered: the controls wait at least as long as the chip takes to leave.
		expect(ms(hot.chipDelay)).toBe(0);
		expect(ms(hot.controlsDelay)).toBeGreaterThanOrEqual(ms(hot.chipDuration));

		// --- back to rest ---
		await page.mouse.move(0, 0);
		await expect.poll(() => opacity(controls)).toBe('0');
		const cold = await row.evaluate((el) => {
			const cs = (sel: string) => getComputedStyle(el.querySelector(`[data-testid="${sel}"]`)!);
			return {
				chipDelay: cs('kernel-memory').transitionDelay,
				controlsDuration: cs('kernel-controls').transitionDuration
			};
		});
		// At rest: the chip waits at least as long as the controls take to leave.
		expect(ms(cold.chipDelay)).toBeGreaterThanOrEqual(ms(cold.controlsDuration));
		// …and it comes all the way back, in the same place.
		await expect.poll(() => opacity(chip)).toBe('1');
		const backChip = (await chip.boundingBox())!;
		expect(backChip.x).toBeCloseTo(restChip.x, 1);
		expect(backChip.width).toBeCloseTo(restChip.width, 1);
	});
}
