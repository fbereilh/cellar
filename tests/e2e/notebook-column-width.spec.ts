import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * The notebook content column is FLUID with no upper bound: widening the window on
 * a large display must keep widening the cells.
 *
 * The reported defect was `max-w-[clamp(48rem,92%,88rem)]` on the column - past
 * ~1531px of available width the 88rem cap froze it and only the side gutters
 * grew. The rule is now `.cellar-notebook-column` in `app.css`
 * (`max-width: max(48rem, 92%)`), so this spec measures the REAL laid-out column
 * against the REAL available width in a real browser at four window sizes.
 *
 * What each assertion guards:
 *   1. no fixed cap  - the column is strictly wider at each larger window, and at
 *                      the two widest it is far past the old 88rem (1408px) cap;
 *   2. gutters kept  - above the floor the column is 92% of the available width,
 *                      so cells never run edge-to-edge, and the page never grows a
 *                      horizontal scrollbar;
 *   3. narrow/mid unchanged - the `48rem` term is a FLOOR ON THE MAX-WIDTH, not a
 *                      minimum width: where it exceeds the container the column is
 *                      unconstrained and uses the FULL available width. Dropping
 *                      that term would silently take 8% off an already-narrow
 *                      window, so the narrow case is pinned explicitly;
 *   4. one rule      - `LiveNotebook`'s pre-render (loading) state is measured too,
 *                      so a loading view cannot be laid out differently from the
 *                      notebook it becomes.
 *
 * Set `CELLAR_E2E_SHOTS=<dir>` to also drop a screenshot per width there; the
 * assertions are independent of it.
 *
 * Needs the real runtime (uv + python3 + host-venv) like the rest of the E2E
 * suite, and skips gracefully without it.
 */

/** The old upper bound, in px at the default 16px root font size. */
const OLD_CAP_PX = 88 * 16;
/** The floor term, in px. Below `FLOOR_PX / GUTTER_RATIO` of available width it wins. */
const FLOOR_PX = 48 * 16;
/** The proportional gutter the rule keeps. */
const GUTTER_RATIO = 0.92;

const WIDTHS = [900, 1440, 2560, 3440];

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

type Geom = { column: number; available: number; overflowX: number };

/**
 * Measure the laid-out column against the width actually available to it.
 *
 * `available` is the column's containing block (the notebook page plane), which
 * spans the scroll pane - so `column / available` is exactly the gutter ratio the
 * rule promises, independent of the sidebar width or the window chrome. Hidden
 * panes stay mounted, so the visible column is the one with a non-zero box.
 */
async function measure(page: Page): Promise<Geom> {
	return page.evaluate(() => {
		const col = [...document.querySelectorAll('.cellar-notebook-column')].find(
			(e) => (e as HTMLElement).getBoundingClientRect().width > 0
		) as HTMLElement | undefined;
		if (!col) throw new Error('no visible .cellar-notebook-column');
		const parent = col.parentElement as HTMLElement;
		const doc = document.documentElement;
		return {
			column: col.getBoundingClientRect().width,
			available: parent.getBoundingClientRect().width,
			overflowX: doc.scrollWidth - doc.clientWidth
		};
	});
}

/** Let the resize settle before measuring - the pane plans its window off a rAF read. */
const settle = (page: Page) =>
	page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

/** Open the seeded notebook: a first-ever visit has no persisted tabs, so it starts empty. */
async function openNotebook(page: Page): Promise<void> {
	const empty = page.getByTestId('empty-open-notebook');
	// Settle before probing: the shell paints either the empty state or an already
	// open notebook, and reading `isVisible()` before either arrives reports the
	// button invisible, turns the click into a no-op, and then times out for 30s on
	// a notebook nothing ever opened (see the openNotebook rule in AGENTS.md).
	await expect(empty.or(page.getByTestId('cell').first())).toBeVisible({ timeout: 30_000 });
	if (await empty.isVisible().catch(() => false)) await empty.click();
}

/** A notebook with wide content, so a screenshot shows cells really using the width. */
function seedNotebook(dir: string): void {
	const wide = Array.from({ length: 14 }, (_, i) => `column_${i}`).join('   ');
	const nb = {
		cells: [
			{
				cell_type: 'markdown',
				id: 'aaaaaaaa-0000-4000-8000-000000000001',
				metadata: {},
				source: ['# Fluid width\n', '\n', 'These cells should keep growing with the window.']
			},
			{
				cell_type: 'code',
				id: 'aaaaaaaa-0000-4000-8000-000000000002',
				execution_count: null,
				metadata: {},
				outputs: [
					{
						output_type: 'stream',
						name: 'stdout',
						text: [`${wide}\n`, `${wide.replace(/column_/g, 'value__')}\n`]
					}
				],
				source: ['print("   ".join(f"column_{i}" for i in range(14)))']
			},
			{
				cell_type: 'code',
				id: 'aaaaaaaa-0000-4000-8000-000000000003',
				execution_count: null,
				metadata: {},
				outputs: [],
				source: ['x = 1  # a second cell, so the column is visible below the output too']
			}
		],
		metadata: { kernelspec: { name: 'python3' } },
		nbformat: 4,
		nbformat_minor: 5
	};
	writeFileSync(join(dir, 'notebook.ipynb'), JSON.stringify(nb, null, 1));
}

test.beforeAll(async () => {
	test.skip(
		!runtimeAvailable(),
		'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only'
	);
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-width-'));
	seedNotebook(workspace);
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

test('the column keeps growing with the window, keeping proportional gutters', async ({ page }) => {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await expect(page.getByTestId('notebook')).toBeVisible();
	await expect(page.getByTestId('cell').first()).toBeVisible();

	const shots = process.env.CELLAR_E2E_SHOTS;
	if (shots) mkdirSync(shots, { recursive: true });

	const seen: Record<number, Geom> = {};
	for (const width of WIDTHS) {
		await page.setViewportSize({ width, height: 900 });
		await settle(page);
		const geom = await measure(page);
		seen[width] = geom;
		console.log(
			`[column-width] window=${width} available=${Math.round(geom.available)} column=${Math.round(
				geom.column
			)} ratio=${(geom.column / geom.available).toFixed(3)} gutter=${Math.round(
				(geom.available - geom.column) / 2
			)}px/side overflowX=${geom.overflowX}`
		);
		if (shots) await page.screenshot({ path: join(shots, `notebook-${width}px.png`) });

		// (2) A wider window never pushes the page into a horizontal scrollbar.
		expect(geom.overflowX).toBeLessThanOrEqual(0);

		if (geom.available >= FLOOR_PX / GUTTER_RATIO) {
			// Above the floor the proportional gutter applies, unchanged from before.
			expect(geom.column).toBeCloseTo(geom.available * GUTTER_RATIO, 0);
			expect(geom.available - geom.column).toBeGreaterThan(0);
		} else {
			// (3) Below it the max-width exceeds the container, so the column is
			// unconstrained and takes the FULL available width - the narrow-window
			// behaviour the floor term exists to preserve.
			expect(geom.column).toBeCloseTo(geom.available, 0);
		}
	}

	// (1) No fixed upper width: each larger window yields a strictly wider column…
	expect(seen[2560].column).toBeGreaterThan(seen[1440].column + 100);
	expect(seen[3440].column).toBeGreaterThan(seen[2560].column + 100);
	// …and the two widest are far past the cap that used to freeze it.
	expect(seen[2560].column).toBeGreaterThan(OLD_CAP_PX);
	expect(seen[3440].column).toBeGreaterThan(OLD_CAP_PX);

	// (3) The narrow window is the floor case, pinned so it stays full-bleed.
	expect(seen[900].available).toBeLessThan(FLOOR_PX / GUTTER_RATIO);
});

test('the pre-render loading state is laid out like the notebook it becomes', async ({ page }) => {
	// Hold the notebook load open so the `fetching` branch is on screen long enough
	// to measure - it carries the same shared rule, so a loading view can never be
	// a different width from the notebook that replaces it.
	let release = () => {};
	const held = new Promise<void>((r) => (release = r));
	await page.route('**/api/notebooks?path=**', async (route) => {
		await held;
		await route.continue();
	});

	await page.setViewportSize({ width: 2560, height: 900 });
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);

	await expect(page.getByText('loading…')).toBeVisible();
	await settle(page);
	const pre = await measure(page);

	release();
	await expect(page.getByTestId('notebook')).toBeVisible();
	await settle(page);
	const post = await measure(page);

	expect(pre.available).toBeCloseTo(post.available, 0);
	expect(pre.column).toBeCloseTo(post.column, 0);
	expect(post.column).toBeGreaterThan(OLD_CAP_PX);
});
