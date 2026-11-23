import { test, expect, type Page } from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar, openSidebarSection, removeWorkspace } from './harness';

/**
 * The Kernels-sidebar card at narrow sidebar widths.
 *
 * One line could not hold dot + name + `closed` chip + RSS + four 24px controls:
 * at the 180px minimum the row overflowed into a horizontal scrollbar with the
 * chip painted over the RSS figure, and even at the 256px default the name got
 * 0-7px. The card is now two lines - the name owns line 1, everything else wraps
 * on line 2 - and its controls are ALWAYS VISIBLE rather than revealed on hover.
 *
 * What is proved here, at 180, 200 and 256px:
 *   1. the notebook name is readable (a short name is not truncated at all; a
 *      long one gets the row);
 *   2. nothing overflows: no horizontal scroll under the list, no card wider
 *      than its box, and no two pieces of a card painted over each other;
 *   3. THE INVARIANT, in BOTH directions, at rest, under hover and with keyboard
 *      focus inside the card: every control is hit-testable EXACTLY when it is
 *      visible. "Visible" is computed (effective opacity of the element and its
 *      ancestors, `visibility`, a non-empty box); "hit-testable" is what the
 *      browser's own `elementFromPoint` answers. Direction A asks every control
 *      whether visible => hit-testable and hit-testable => visible at its centre;
 *      direction B sweeps a grid over the whole card and asks every control the
 *      browser actually hits there whether it is visible. The reverted
 *      hover-reveal failed direction B (an opacity-0 button answered clicks at
 *      rest); a `pointer-events-none` on a visible control fails direction A;
 *   4. the name is still a real, focusable <button> carrying its path tooltip.
 *
 * Boots the REAL launcher, so it SKIPS without the kernel runtime.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const SHORT = 'analysis.ipynb';
const LONG = 'customer_churn_quarterly_model.ipynb';
const FRESH = 'gamma.ipynb';
const WIDTHS = [180, 200, 256];

function notebook(prefix: string, src: string): string {
	return JSON.stringify({
		cells: [{ cell_type: 'code', id: `${prefix}-cell-00`, metadata: {}, execution_count: null, outputs: [], source: [src] }],
		metadata: { kernelspec: { name: 'python3', display_name: 'python3' } },
		nbformat: 4,
		nbformat_minor: 5
	});
}

/** Run a cell so the notebook's kernel boots; return once its list entry has an id. */
async function bootKernel(page: Page, nb: string, cellId: string): Promise<void> {
	await page.evaluate(
		async ({ nb, cellId }) => {
			await fetch(`/api/cells/${cellId}/run`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ nb, source: 'x = 1' })
			})
				.then((r) => r.text())
				.catch(() => {});
		},
		{ nb, cellId }
	);
	await expect
		.poll(
			async () =>
				page.evaluate(async (p) => {
					const r = await fetch('/api/kernel').then((x) => x.json());
					return (r.kernels as Array<{ path: string; id: string | null }>).some((k) => k.path === p && !!k.id);
				}, nb),
			{ timeout: 60_000 }
		)
		.toBe(true);
}

const card = (page: Page, path: string) => page.locator(`[data-testid="kernel-card"][data-nb-path="${path}"]`);

/** Set the persisted sidebar width and reload so the shell restores it. */
async function atWidth(page: Page, w: number): Promise<void> {
	await page.request.put(`${baseURL}/api/ui-state`, { data: { 'cellar-sidebar-width': w } });
	await page.reload();
	await openSidebarSection(page, 'kernels', 'kernels-body');
	const aside = page.getByTestId('sidebar');
	await expect.poll(async () => Math.round((await aside.boundingBox())?.width ?? 0)).toBeLessThanOrEqual(w);
	await page.getByTestId('kernels-body').scrollIntoViewIfNeeded();
}

/** Park the pointer far from the sidebar and drop focus: the "at rest" state. */
async function atRest(page: Page): Promise<void> {
	await page.mouse.move(1150, 750);
	await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
}

/**
 * Both directions of the invariant over every card currently rendered. Returns a
 * list of human-readable violations (empty = holds), so a failure names the
 * control, the state and the direction.
 */
async function invariantViolations(page: Page, state: string): Promise<string[]> {
	return page.evaluate((state) => {
		const out: string[] = [];
		const CONTROL = 'button, a[href], input, select, textarea, [role="button"]';
		const effOpacity = (el: Element | null) => {
			let o = 1;
			for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
				o *= Number(getComputedStyle(e).opacity);
			}
			return o;
		};
		const visible = (el: Element) => {
			const r = el.getBoundingClientRect();
			return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility === 'visible' && effOpacity(el) > 0.99;
		};
		const name = (el: Element) => el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? el.tagName;
		const cards = [...document.querySelectorAll('[data-testid="kernel-card"]')];
		if (cards.length === 0) out.push(`${state}: no kernel cards rendered`);
		for (const c of cards) {
			const nb = c.getAttribute('data-nb-path');
			// Direction A: per control, at its centre, visible <=> hit-testable.
			for (const ctl of c.querySelectorAll(CONTROL)) {
				const r = ctl.getBoundingClientRect();
				const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
				const hittable = !!hit && (hit === ctl || ctl.contains(hit));
				const vis = visible(ctl);
				if (vis && !hittable) out.push(`${state}: ${nb} ${name(ctl)} is VISIBLE but not clickable (hit ${hit && name(hit)})`);
				if (!vis && hittable) out.push(`${state}: ${nb} ${name(ctl)} is CLICKABLE but not visible (opacity ${effOpacity(ctl).toFixed(2)})`);
			}
			// Direction B: sweep the card; whatever control the browser hits must be visible.
			const box = c.getBoundingClientRect();
			for (let y = box.top + 1; y < box.bottom - 1; y += 3) {
				for (let x = box.left + 1; x < box.right - 1; x += 3) {
					const hit = document.elementFromPoint(x, y);
					const ctl = hit?.closest(CONTROL);
					if (ctl && c.contains(ctl) && !visible(ctl)) {
						out.push(`${state}: ${nb} ${name(ctl)} answers a click at (${Math.round(x)},${Math.round(y)}) while invisible`);
					}
				}
			}
			// An opacity transition is a window where the two directions disagree.
			for (const el of [c, ...c.querySelectorAll('*')]) {
				const tp = getComputedStyle(el).transitionProperty;
				if (/(^|,\s*)(opacity|visibility|all)(\s*,|$)/.test(tp) && Number.parseFloat(getComputedStyle(el).transitionDuration) > 0 && el.closest(CONTROL)) {
					out.push(`${state}: ${nb} ${name(el)} transitions ${tp}`);
				}
			}
		}
		return [...new Set(out)];
	}, state);
}

/** Layout of every card: overflow, overlapping pieces, and name widths. */
async function layout(page: Page) {
	return page.getByTestId('kernels-body').evaluate((body) => {
		const overlaps: string[] = [];
		const cards = [...body.querySelectorAll('[data-testid="kernel-card"]')].map((c) => {
			const nameEl = c.querySelector('[data-testid="kernel-notebook"] span') as HTMLElement;
			// The pieces of the card that must never be painted over one another: every
			// button, and every leaf that carries text. Structure-independent on
			// purpose, so it answers for any markup the row is given.
			const pieces = [...c.querySelectorAll('span, button')].filter(
				(e) => e.tagName === 'BUTTON' || (!e.querySelector('span, button') && (e.textContent ?? '').trim() !== '')
			);
			const boxes = pieces.map((e) => [e, e.getBoundingClientRect()] as const).filter(([, r]) => r.width > 0);
			for (let i = 0; i < boxes.length; i++) {
				for (let j = i + 1; j < boxes.length; j++) {
					const [a, ra] = boxes[i];
					const [b, rb] = boxes[j];
					if (a.contains(b) || b.contains(a)) continue;
					const ix = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
					const iy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
					if (ix > 0.5 && iy > 0.5) overlaps.push(`${c.getAttribute('data-nb-path')}: "${a.textContent?.trim()}" overlaps "${b.textContent?.trim()}"`);
				}
			}
			const cb = c.getBoundingClientRect();
			const outside = boxes
				.filter(([, r]) => r.right > cb.right + 0.5 || r.left < cb.left - 0.5)
				.map(([e]) => (e.getAttribute('data-testid') ?? e.textContent?.trim()) || e.tagName);
			return {
				path: c.getAttribute('data-nb-path'),
				nameClient: nameEl.clientWidth,
				nameScroll: nameEl.scrollWidth,
				cardClient: c.clientWidth,
				cardScroll: c.scrollWidth,
				outside
			};
		});
		return { bodyClient: body.clientWidth, bodyScroll: body.scrollWidth, cards, overlaps };
	});
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-kcard-narrow-'));
	writeFileSync(join(workspace, 'notebook.ipynb'), notebook('main', 'main_var = 0'));
	writeFileSync(join(workspace, SHORT), notebook('ana', 'x = 1'));
	writeFileSync(join(workspace, LONG), notebook('long', 'x = 1'));
	writeFileSync(join(workspace, FRESH), notebook('gam', 'x = 1'));
	const booted = await bootCellar(workspace);
	launcher = booted.proc;
	baseURL = booted.url;
});

test.afterAll(async () => {
	if (launcher) killCellar(launcher);
	launcher = null;
	if (workspace && existsSync(workspace)) {
		try {
			removeWorkspace(workspace);
		} catch {
			/* best effort */
		}
	}
});

test('the card fits, keeps its name readable, and every control is clickable exactly when visible', async ({ page }) => {
	test.setTimeout(300_000);
	await page.setViewportSize({ width: 1200, height: 800 });
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	// Three card shapes: an OPEN notebook with a kernel, a long-named one whose
	// tab is CLOSED (kernel alive, `closed` chip), and the ACTIVE notebook with no
	// kernel yet (`not started`, no controls).
	for (const nb of [SHORT, LONG, FRESH]) {
		await page.getByTestId('tree-file').filter({ hasText: nb }).first().dblclick();
	}
	await bootKernel(page, SHORT, 'ana-cell-00');
	await bootKernel(page, LONG, 'long-cell-00');
	const longTab = page.getByTestId('tab').filter({ hasText: LONG });
	await longTab.first().getByTestId('tab-close').click();
	await expect(longTab).toHaveCount(0);
	await page.getByTestId('tab').filter({ hasText: FRESH }).first().click();

	for (const w of WIDTHS) {
		await atWidth(page, w);
		for (const p of [SHORT, LONG, FRESH]) await expect(card(page, p)).toBeVisible({ timeout: 30_000 });
		await expect(card(page, LONG)).toContainText('closed');
		await expect(card(page, FRESH).getByTestId('kernel-not-started')).toBeVisible();
		// Let the RSS poll land so the widest meta line is the one measured.
		await expect(card(page, SHORT).getByTestId('kernel-memory')).toBeVisible({ timeout: 30_000 });

		// --- 1 + 2: readable name, no overflow, nothing painted over anything ---
		await atRest(page);
		const l = await layout(page);
		expect(l.bodyScroll, `${w}px: horizontal scroll under the kernel list`).toBeLessThanOrEqual(l.bodyClient);
		expect(l.overlaps, `${w}px: overlapping pieces`).toEqual([]);
		for (const c of l.cards) {
			expect(c.cardScroll, `${w}px: ${c.path} overflows its card`).toBeLessThanOrEqual(c.cardClient);
			expect(c.outside, `${w}px: ${c.path} paints outside its card`).toEqual([]);
		}
		const short = l.cards.find((c) => c.path === SHORT)!;
		expect(short.nameScroll, `${w}px: "${SHORT}" is truncated`).toBeLessThanOrEqual(short.nameClient);
		// A long name gets the row: all of it but the status dot and padding.
		const long = l.cards.find((c) => c.path === LONG)!;
		expect(long.nameClient, `${w}px: the long name is squeezed`).toBeGreaterThanOrEqual(long.cardClient - 40);

		// --- 3: the invariant, both directions, in every interaction state ---
		await atRest(page);
		expect(await invariantViolations(page, `${w}px at rest`)).toEqual([]);
		// This design's choice on top of the invariant: the controls are SHOWN at
		// rest - so a click at rest lands on a control the user can see.
		for (const id of ['kernel-interrupt', 'kernel-wipe-vars', 'kernel-restart', 'kernel-shutdown']) {
			await expect(card(page, SHORT).getByTestId(id)).toBeVisible();
			await expect(card(page, SHORT).getByTestId(id)).toHaveCSS('opacity', '1');
		}
		for (const p of [SHORT, LONG]) {
			await card(page, p).hover();
			expect(await invariantViolations(page, `${w}px hovering ${p}`)).toEqual([]);
			// Hover-out: back to rest, still consistent.
			await atRest(page);
			expect(await invariantViolations(page, `${w}px after leaving ${p}`)).toEqual([]);
		}
		await atRest(page);
		await card(page, SHORT).getByTestId('kernel-restart').focus();
		expect(await invariantViolations(page, `${w}px keyboard focus in ${SHORT}`)).toEqual([]);

		// The armed wipe confirm is the row's widest state: it must fit and keep the
		// invariant too.
		await card(page, SHORT).getByTestId('kernel-wipe-vars').click();
		await expect(card(page, SHORT).getByTestId('kernel-wipe-confirm')).toBeVisible();
		await atRest(page);
		const lc = await layout(page);
		expect(lc.bodyScroll, `${w}px: overflow with the wipe confirm armed`).toBeLessThanOrEqual(lc.bodyClient);
		expect(lc.overlaps, `${w}px: overlaps with the wipe confirm armed`).toEqual([]);
		expect(await invariantViolations(page, `${w}px wipe confirm armed`)).toEqual([]);
		await card(page, SHORT).getByTestId('kernel-wipe-vars-cancel').click();
		await expect(card(page, SHORT).getByTestId('kernel-controls')).toBeVisible();

		// --- 4: the name is still a real, focusable button with its path tooltip ---
		const nameBtn = card(page, LONG).getByTestId('kernel-notebook');
		expect(await nameBtn.evaluate((e) => e.tagName)).toBe('BUTTON');
		await expect(nameBtn).toHaveAttribute('title', new RegExp(LONG.replace('.', '\\.')));
		await expect(nameBtn).toHaveAttribute('aria-label', new RegExp(LONG.replace('.', '\\.')));
		await nameBtn.focus();
		expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('kernel-notebook');
	}

	// The controls still act: Restart from a 180px card really restarts the kernel.
	await atWidth(page, 180);
	const before = await page.evaluate(async (p) => {
		const r = await fetch('/api/kernel').then((x) => x.json());
		return (r.kernels as Array<{ path: string; session_id: unknown }>).find((k) => k.path === p)?.session_id ?? null;
	}, SHORT);
	await card(page, SHORT).getByTestId('kernel-restart').click();
	await expect
		.poll(
			async () =>
				page.evaluate(async (p) => {
					const r = await fetch('/api/kernel').then((x) => x.json());
					return (r.kernels as Array<{ path: string; session_id: unknown }>).find((k) => k.path === p)?.session_id ?? null;
				}, SHORT),
			{ timeout: 60_000 }
		)
		.not.toBe(before);
});
