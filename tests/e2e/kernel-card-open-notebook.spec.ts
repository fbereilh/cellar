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
 *      move at any sidebar width, it and the controls are never both on screen,
 *      the name still gets the whole row at rest, and the control cluster sits
 *      exactly where it did;
 *   7. AT REST the control cluster does not hit-test at all, so a click over the
 *      right-hand region reaches the notebook name and never a kernel control.
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

/**
 * Drag the sidebar to `width` - the resizer is the only surface that sets it, and
 * it clamps to its own 180-560px range, so this exercises the real bounds.
 */
async function setSidebarWidth(page: Page, width: number): Promise<void> {
	const handle = page.getByTestId('sidebar-resizer');
	const shown = () =>
		handle.evaluate((el) => Math.round(el.previousElementSibling!.getBoundingClientRect().width));
	// The width is PERSISTED, so a previous test in this workspace decides where
	// the drag starts - measure it rather than assuming the 256px default.
	const from = await shown();
	const box = (await handle.boundingBox())!;
	const y = box.y + box.height / 2;
	await page.mouse.move(box.x + box.width / 2, y);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width / 2 + (width - from), y, { steps: 6 });
	await page.mouse.up();
	await expect.poll(shown).toBe(width);
	await page.mouse.move(0, 0);
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
	// Own fixtures for the layout/hit-test specs: the rename spec moves `beta.ipynb`
	// out of the tree, and these run after it.
	writeFileSync(join(workspace, 'delta.ipynb'), notebook('delta', ['delta_var = 4']));
	writeFileSync(join(workspace, 'epsilon.ipynb'), notebook('epsilon', ['epsilon_var = 5']));
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

/**
 * AT REST the control cluster must not participate in hit-testing.
 *
 * It is `absolute ... opacity-0`, and `opacity: 0` hides a box without stopping
 * it receiving pointer events - and being a positioned later sibling it is
 * hit-tested ABOVE the name button it is drawn over. At rest the name button
 * spans the whole row, so its tail, the `closed` chip and the entire RSS figure
 * sat under an invisible overlay of four buttons, two of which (Restart, Shut
 * down) act immediately with no confirmation. This asks the BROWSER what a click
 * would hit, which is the only thing that can tell an invisible-but-live overlay
 * from an inert one: `elementFromPoint` with the pointer parked off the row.
 */
for (const theme of ['dim', 'cellar-light'] as const) {
	test(`at rest the controls do not steal clicks over the row (${theme})`, async ({ page }) => {
		test.setTimeout(240_000);
		await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
		// Both card shapes: an OPEN one, and a tab-CLOSED one (which also carries the
		// `closed` chip, so its name region is the tighter of the two).
		for (const nb of ['delta.ipynb', 'epsilon.ipynb']) {
			await page.getByTestId('tree-file').filter({ hasText: nb }).first().dblclick();
		}
		await bootKernel(page, 'delta.ipynb', 'delta-cell-00', 'delta_var = 4');
		await bootKernel(page, 'epsilon.ipynb', 'epsilon-cell-00', 'epsilon_var = 5');
		await closeTab(page, 'delta.ipynb');
		await openKernels(page);
		await page.evaluate((t) => {
			document.documentElement.dataset.theme = t;
		}, theme);

		for (const nb of ['delta.ipynb', 'epsilon.ipynb']) {
			const row = card(page, nb);
			await expect(row.getByTestId('kernel-memory')).toBeVisible({ timeout: 30_000 });
			await page.mouse.move(0, 0);
			await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
			await expect
				.poll(() => row.getByTestId('kernel-controls').evaluate((el) => getComputedStyle(el).opacity))
				.toBe('0');

			// Sweep the right-hand region the cluster covers, plus the RSS figure's own
			// centre. Nothing there may resolve to a control.
			const probe = await row.evaluate((el) => {
				const r = el.getBoundingClientRect();
				const chip = el.querySelector('[data-testid="kernel-memory"]')!.getBoundingClientRect();
				const y = r.top + r.height / 2;
				const xs = [chip.left + chip.width / 2, r.right - 12, r.right - 40, r.right - 70, r.right - 100];
				const hits = xs.map((x) => {
					const hit = document.elementFromPoint(x, y) as HTMLElement | null;
					return hit?.closest<HTMLElement>('[data-testid]')?.dataset.testid ?? null;
				});
				return { hits, xs, y };
			});
			for (const hit of probe.hits) {
				expect(hit, `${nb}: an at-rest hit-test resolved to ${hit}`).not.toMatch(
					/^kernel-(interrupt|wipe-vars|restart|shutdown|controls)$/
				);
			}
			// …and it is the row's own content that answers instead. Which point lands
			// on what depends on the name's length and the figure's digits, so what is
			// pinned is that the RSS figure answers for itself and that the name is
			// reachable somewhere in the region the cluster covers.
			expect(probe.hits[0], `${nb}: the RSS figure did not answer for itself`).toBe('kernel-memory');
			expect(probe.hits, `${nb}: the name was unreachable in the cluster's region`).toContain(
				'kernel-notebook'
			);

			// ACTIVATING what is there does what that thing does, and nothing else.
			// Driven with the pointer still parked off the row - a tap, or any
			// programmatic activation, sees exactly this state, whereas a real mouse
			// click hovers first and so asks a different question (covered below).
			const before = await kernelIdFor(page, nb);
			const beforeSession = await sessionIdFor(page, nb);
			// The RSS figure is a plain <span>: clicking it must do nothing at all -
			// above all it must not reach Shut down, which is drawn over it.
			await row.evaluate((_el, { x, y }) => {
				(document.elementFromPoint(x, y) as HTMLElement).click();
			}, { x: probe.xs[0], y: probe.y });
			expect(await kernelIdFor(page, nb)).toBe(before);
			expect(await sessionIdFor(page, nb)).toBe(beforeSession);

			// A point over the name's own region opens the notebook, kernel untouched.
			const nameX = probe.xs[probe.hits.indexOf('kernel-notebook')];
			expect(nameX, `${nb}: no probe point resolved to the name`).toBeGreaterThan(0);
			await row.evaluate((_el, { x, y }) => {
				(document.elementFromPoint(x, y) as HTMLElement).click();
			}, { x: nameX, y: probe.y });
			await expect(page.getByTestId('tab').filter({ hasText: nb })).toHaveCount(1, { timeout: 30_000 });
			expect(await kernelIdFor(page, nb)).toBe(before);
			expect(await sessionIdFor(page, nb)).toBe(beforeSession);
			await openKernels(page);
		}

		// The reveal is untouched: hovering makes every control hit-testable, and one
		// of them really acts. (`group-hover` keys off the ROW, which a child
		// declining pointer events cannot affect.)
		const row = card(page, 'epsilon.ipynb');
		await row.hover();
		await expect
			.poll(() => row.getByTestId('kernel-controls').evaluate((el) => getComputedStyle(el).opacity))
			.toBe('1');
		await expect
			.poll(() => row.getByTestId('kernel-controls').evaluate((el) => getComputedStyle(el).pointerEvents))
			.toBe('auto');
		const revealed = await row.evaluate((el) => {
			const ids = ['kernel-interrupt', 'kernel-wipe-vars', 'kernel-restart', 'kernel-shutdown'];
			return ids.map((id) => {
				const b = el.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect();
				const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) as HTMLElement | null;
				return hit?.closest<HTMLElement>('[data-testid]')?.dataset.testid ?? null;
			});
		});
		expect(revealed).toEqual(['kernel-interrupt', 'kernel-wipe-vars', 'kernel-restart', 'kernel-shutdown']);
		const session = await sessionIdFor(page, 'epsilon.ipynb');
		await row.getByTestId('kernel-restart').click();
		await expect.poll(() => sessionIdFor(page, 'epsilon.ipynb'), { timeout: 60_000 }).not.toBe(session);
	});
}

/**
 * A control is clickable THE INSTANT the pointer lands on the row.
 *
 * The regression this pins is the mirror of the at-rest one above. Putting
 * `pointer-events` on the opacity transition made it flip at the transition's
 * MIDPOINT, so the icons were drawn from 75ms and inert until 150ms; a click in
 * that window fell through to the name button under them and OPENED THE NOTEBOOK
 * instead of restarting the kernel. Nothing about the CSS is read here - the
 * pointer is driven for real with no settle time, and what is asserted is which
 * action happened: the kernel's session epoch moved, and no tab appeared.
 */
for (const theme of ['dim', 'cellar-light'] as const) {
	test(`a control clicked the moment the row is hovered acts on the kernel (${theme})`, async ({
		page
	}) => {
		test.setTimeout(240_000);
		await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
		await page.getByTestId('tree-file').filter({ hasText: 'epsilon.ipynb' }).first().dblclick();
		await bootKernel(page, 'epsilon.ipynb', 'epsilon-cell-00', 'epsilon_var = 5');
		await openKernels(page);
		await page.evaluate((t) => {
			document.documentElement.dataset.theme = t;
		}, theme);

		const row = card(page, 'epsilon.ipynb');
		const restart = row.getByTestId('kernel-restart');
		await expect(row.getByTestId('kernel-memory')).toBeVisible({ timeout: 30_000 });

		// Measure the target while the row is at REST and the pointer is elsewhere,
		// so the click below is one uninterrupted move-and-press - exactly what a
		// user does, and what the dead window swallowed.
		await page.mouse.move(0, 0);
		await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
		await expect
			.poll(() => row.getByTestId('kernel-controls').evaluate((el) => getComputedStyle(el).opacity))
			.toBe('0');
		const target = (await restart.boundingBox())!;

		const session = await sessionIdFor(page, 'epsilon.ipynb');
		const tabsBefore = (await tabTitles(page)).length;
		await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
		await page.mouse.down();
		await page.mouse.up();

		// The CONTROL acted…
		await expect.poll(() => sessionIdFor(page, 'epsilon.ipynb'), { timeout: 60_000 }).not.toBe(session);
		// …and the name button under it did not: no tab was opened by that click.
		expect((await tabTitles(page)).length).toBe(tabsBefore);
	});
}

/**
 * The row's right slot is SHARED: the RSS chip holds it at rest, the four
 * controls take it on hover. Both of the ways that can go wrong were real
 * defects here, and both shipped in this change:
 *   - the controls IN FLOW reserved 102px of a 239px row permanently, so a
 *     closed card's name got about one character at the default sidebar width;
 *   - taking them out of flow and reserving the room as PADDING shifted the RSS
 *     chip - by 108px at every width when the padding was on the name+memory
 *     wrapper, and, once it moved onto the name button, by whatever the button
 *     overflowed once `box-sizing: border-box` floored it at the gutter width
 *     (below a sidebar of roughly 210px, inside the resizer's own 180-560px
 *     range). Hence a `::after` spacer in the button's own content layout, which
 *     has no such floor.
 * So the invariants are measured, not asserted in prose, and measured across the
 * resizer's whole range rather than at the default width alone. Geometry here is
 * theme-independent by design, which is exactly why both themes are checked - a
 * token that quietly carried a size would show up as a difference.
 */
for (const theme of ['dim', 'cellar-light'] as const) {
	test(`the row's layout holds while the controls reveal (${theme})`, async ({ page }) => {
		test.setTimeout(240_000);
		await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
		for (const nb of ['delta.ipynb', 'epsilon.ipynb']) {
			await page.getByTestId('tree-file').filter({ hasText: nb }).first().dblclick();
		}
		await bootKernel(page, 'delta.ipynb', 'delta-cell-00', 'delta_var = 4');
		await bootKernel(page, 'epsilon.ipynb', 'epsilon-cell-00', 'epsilon_var = 5');
		// delta is the tab-CLOSED shape (tighter: it also carries the `closed`
		// chip); epsilon stays OPEN.
		await closeTab(page, 'delta.ipynb');
		await openKernels(page);
		await page.evaluate((t) => {
			document.documentElement.dataset.theme = t;
		}, theme);

		// The resizer's own bounds and the default, so the invariant is measured
		// across the range a user can actually drag to - not at one width.
		for (const width of [180, 256, 560] as const) {
			await setSidebarWidth(page, width);

			for (const nb of ['delta.ipynb', 'epsilon.ipynb']) {
				const row = card(page, nb);
				const chip = row.getByTestId('kernel-memory');
				const controls = row.getByTestId('kernel-controls');
				const name = row.getByTestId('kernel-notebook');
				const opacity = (l: typeof chip) => l.evaluate((el) => getComputedStyle(el).opacity);
				await expect(chip).toBeVisible({ timeout: 30_000 });

				// Park the pointer and the caret off the row, so "at rest" really is: the
				// controls reveal on `:focus-within` as well as `:hover`.
				await page.mouse.move(0, 0);
				await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
				await expect.poll(() => opacity(controls)).toBe('0');
				const restRow = (await row.boundingBox())!;
				const restChip = (await chip.boundingBox())!;
				const restName = (await name.boundingBox())!;
				expect(await opacity(chip)).toBe('1');
				// At rest the name owns the row - nothing invisible reserves a slot in
				// front of it, so its box runs to the row's own right edge less the
				// figure beside it. (In flow the control cluster left it ~20px at the
				// default width.)
				expect(restName.x + restName.width + 8 + restChip.width).toBeCloseTo(
					restRow.x + restRow.width - 8,
					0
				);

				// --- revealed ---
				await row.hover();
				await expect.poll(() => opacity(controls)).toBe('1');
				const hotChip = (await chip.boundingBox())!;
				// THE headline invariant, at EVERY width in the resizer's range: the
				// chip does not shift across the reveal. Anchored on its RIGHT edge,
				// because the figure itself re-renders on the ~4s kernel-status poll
				// and a digit more or less legitimately moves its left edge - which is
				// content changing, not the row reflowing under a hover.
				expect(hotChip.x + hotChip.width, `${nb} @${width}px: chip moved`).toBeCloseTo(
					restChip.x + restChip.width,
					1
				);
				expect(hotChip.y).toBeCloseTo(restChip.y, 1);
				// …and it is not merely un-moved but OUT of the way, never drawn under
				// the icons that have taken its slot.
				expect(await opacity(chip)).toBe('0');

				// The row does not grow, the name button's own box does not move (the
				// reserved room lives INSIDE it, which is what keeps the chip still), and
				// the controls sit where they did: right edge 8px in, vertically centred.
				const hotRow = (await row.boundingBox())!;
				expect(hotRow.height).toBeCloseTo(restRow.height, 1);
				const hotName = (await name.boundingBox())!;
				expect(hotName.x).toBeCloseTo(restName.x, 1);
				expect(hotName.width).toBeCloseTo(restName.width, 1);
				const ctrl = (await controls.boundingBox())!;
				expect(hotRow.x + hotRow.width - (ctrl.x + ctrl.width)).toBeCloseTo(8, 0);
				expect(ctrl.y + ctrl.height / 2).toBeCloseTo(hotRow.y + hotRow.height / 2, 0);

				// --- back to rest ---
				await page.mouse.move(0, 0);
				await expect.poll(() => opacity(controls)).toBe('0');
				await expect.poll(() => opacity(chip)).toBe('1');
				const backChip = (await chip.boundingBox())!;
				expect(backChip.x + backChip.width).toBeCloseTo(restChip.x + restChip.width, 1);
			}

		}

		// The handoff is SEQUENCED, so the two are never both on screen mid-fade -
		// each waits out the other's transition. Read off the browser's own resolved
		// timing rather than sampled frames, which would be a race.
		const row = card(page, 'epsilon.ipynb');
		const ms = (v: string) => (v.endsWith('ms') ? parseFloat(v) : parseFloat(v) * 1000);
		await row.hover();
		await expect
			.poll(() => row.getByTestId('kernel-controls').evaluate((el) => getComputedStyle(el).opacity))
			.toBe('1');
		const hot = await row.evaluate((el) => {
			const cs = (sel: string) => getComputedStyle(el.querySelector(`[data-testid="${sel}"]`)!);
			return {
				chipDelay: cs('kernel-memory').transitionDelay,
				chipDuration: cs('kernel-memory').transitionDuration,
				controlsDelay: cs('kernel-controls').transitionDelay
			};
		});
		expect(ms(hot.chipDelay)).toBe(0);
		expect(ms(hot.controlsDelay)).toBeGreaterThanOrEqual(ms(hot.chipDuration));

		await page.mouse.move(0, 0);
		await expect
			.poll(() => row.getByTestId('kernel-controls').evaluate((el) => getComputedStyle(el).opacity))
			.toBe('0');
		const cold = await row.evaluate((el) => {
			const cs = (sel: string) => getComputedStyle(el.querySelector(`[data-testid="${sel}"]`)!);
			return {
				chipDelay: cs('kernel-memory').transitionDelay,
				controlsDuration: cs('kernel-controls').transitionDuration
			};
		});
		expect(ms(cold.chipDelay)).toBeGreaterThanOrEqual(ms(cold.controlsDuration));
	});
}
