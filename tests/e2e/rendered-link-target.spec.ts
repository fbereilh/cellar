import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar, removeWorkspace } from './harness';

/**
 * A link rendered from notebook content opens in a NEW browser tab, and the
 * Cellar tab keeps its live session.
 *
 * This is the level the unit test cannot reach. `rendered-link-target.test.ts`
 * pins the ATTRIBUTES the sanitize boundary writes; only a real browser can show
 * that a click on one of those links really produces a second tab, that the
 * first tab neither navigates nor loses its kernel namespace, and - the other
 * half of the rule - that a SAME-DOCUMENT anchor is left alone and still scrolls
 * in place.
 *
 * Everything stays on Cellar's own origin: the clicked link is a relative path
 * (which unloads the tab exactly like an absolute URL does, and is what the
 * policy is really about), so the test needs no network. The external-URL case
 * is asserted on the rendered attributes rather than by clicking, for the same
 * reason.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const EXTERNAL = 'https://example.com/docs';
const RELATIVE = './linked-page.html';
const ANCHOR_ID = 'anchor-target';
const EMPTY_LINK_TEXT = 'reload me';

const MD_CELL = [
	'# Links',
	'',
	`[external](${EXTERNAL})`,
	'',
	`[relative](${RELATIVE})`,
	'',
	`[jump](#${ANCHOR_ID})`,
	'',
	// markdown-it renders an empty link as `<a href="">`, which resolves to the
	// current document - so left in place a click would RELOAD this tab and take
	// the live session with it. It must open out like any other outbound link.
	`[${EMPTY_LINK_TEXT}]()`,
	'',
	'bare https://example.com/bare too'
].join('\n');

function notebookJson(): string {
	return JSON.stringify({
		nbformat: 4,
		nbformat_minor: 5,
		metadata: { kernelspec: { name: 'python3', display_name: 'python3' } },
		cells: [
			{ cell_type: 'markdown', id: 'md-links-aaaaaaaa', metadata: {}, source: [MD_CELL] },
			{
				cell_type: 'code',
				id: 'code-links-aaaaaa',
				metadata: {},
				execution_count: null,
				// The session marker: defined by the FIRST run, read back after a link
				// has opened a second tab. A navigated-away Cellar tab loses its
				// notebook, and a restarted kernel loses this name.
				source: ['session_marker = "alive"\nsession_marker'],
				outputs: []
			},
			{
				cell_type: 'code',
				id: 'code-mdout-aaaaaa',
				metadata: {},
				execution_count: null,
				source: [
					'from IPython.display import Markdown, display',
					'display(Markdown("[from the kernel](https://example.com/kernel)"))'
				].join('\n'),
				outputs: []
			}
		]
	});
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-links-'));
	writeFileSync(join(workspace, 'notebook.ipynb'), notebookJson());
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

/** Open the seeded notebook from the file tree, as a user would. */
async function openNotebook(page: Page) {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	const openBtn = page.locator('[data-testid="tree-file"][data-path="notebook.ipynb"]');
	const cell = page.getByTestId('cell').first();
	// Settle before probing: the shell paints either the tree or an already-open
	// notebook (a later test in this file inherits the restored tab session, so
	// both can be present), and clicking before either arrives is a silent no-op.
	await expect(openBtn.or(cell).first()).toBeVisible();
	if (!(await cell.isVisible()) && (await openBtn.isVisible())) await openBtn.click();
	await expect(page.getByTestId('markdown-rendered').first()).toBeVisible();
}

test('a markdown-cell link opens a new tab and the session survives', async ({ page, context }) => {
	await openNotebook(page);
	const rendered = page.getByTestId('markdown-rendered').first();

	// ---- The attributes, on every flavour of outbound link -----------------
	for (const href of [EXTERNAL, RELATIVE, 'https://example.com/bare']) {
		const a = rendered.locator(`a[href="${href}"]`);
		await expect(a).toHaveAttribute('target', '_blank');
		// Not optional: without noopener the opened page holds a handle on the
		// window running the notebook.
		await expect(a).toHaveAttribute('rel', 'noreferrer noopener');
	}

	// ---- Establish live session state before clicking anything -------------
	const markerCell = page.locator('[data-testid="cell"][data-cell-id="code-links-aaaaaa"]');
	await markerCell.getByTestId('run').click();
	await expect(markerCell.getByTestId('output')).toContainText('alive');

	const urlBefore = page.url();

	// ---- The click really opens a second tab --------------------------------
	const [popup] = await Promise.all([
		context.waitForEvent('page'),
		rendered.locator(`a[href="${RELATIVE}"]`).click()
	]);
	await popup.waitForLoadState('domcontentloaded').catch(() => {});
	expect(popup.url()).toContain('linked-page.html');
	expect(popup).not.toBe(page);
	await popup.close();

	// ---- ...and the Cellar tab is exactly where it was ---------------------
	expect(page.url()).toBe(urlBefore);
	await expect(rendered).toBeVisible();
	// The kernel namespace is intact: re-running reads back the marker set before
	// the link was clicked, which a reload or a fresh kernel would have lost.
	await markerCell.getByTestId('run').click();
	await expect(markerCell.getByTestId('output')).toContainText('alive');
});

test('an empty link opens a new tab rather than reloading the session away', async ({
	page,
	context
}) => {
	await openNotebook(page);
	const rendered = page.getByTestId('markdown-rendered').first();
	const empty = rendered.locator('a[href=""]');
	await expect(empty).toHaveText(EMPTY_LINK_TEXT);
	await expect(empty).toHaveAttribute('target', '_blank');
	await expect(empty).toHaveAttribute('rel', 'noreferrer noopener');

	// Establish live session state that only survives if this tab is not unloaded.
	const markerCell = page.locator('[data-testid="cell"][data-cell-id="code-links-aaaaaa"]');
	await markerCell.getByTestId('run').click();
	await expect(markerCell.getByTestId('output')).toContainText('alive');

	const urlBefore = page.url();
	const [popup] = await Promise.all([context.waitForEvent('page'), empty.click()]);
	await popup.waitForLoadState('domcontentloaded').catch(() => {});
	expect(popup).not.toBe(page);
	await popup.close();

	// The original tab neither navigated nor reloaded: re-running reads back the
	// marker defined before the click, which a reload would have lost with the
	// kernel session it was stamped against.
	expect(page.url()).toBe(urlBefore);
	await markerCell.getByTestId('run').click();
	await expect(markerCell.getByTestId('output')).toContainText('alive');
});

test('a same-document anchor still scrolls in place', async ({ page, context }) => {
	await openNotebook(page);
	const rendered = page.getByTestId('markdown-rendered').first();
	const jump = rendered.locator(`a[href="#${ANCHOR_ID}"]`);

	// The policy must not have touched it.
	await expect(jump).not.toHaveAttribute('target', /.*/);

	// markdown-it emits no heading ids, so give the fragment something real to
	// scroll to: a tall spacer plus the target, appended to the notebook's own
	// scroll container (the element anchor navigation will actually move).
	await page.evaluate((id) => {
		const link = document.querySelector(`[data-testid="markdown-rendered"] a[href="#${id}"]`);
		let el: HTMLElement | null = link?.parentElement ?? null;
		while (el) {
			const oy = getComputedStyle(el).overflowY;
			if (oy === 'auto' || oy === 'scroll') break;
			el = el.parentElement;
		}
		const host = el ?? document.body;
		const spacer = document.createElement('div');
		spacer.style.height = '4000px';
		const target = document.createElement('div');
		target.id = id;
		target.style.height = '40px';
		target.textContent = 'anchor target';
		host.append(spacer, target);
		host.scrollTop = 0;
	}, ANCHOR_ID);

	const pagesBefore = context.pages().length;
	const urlBefore = page.url();
	await jump.click();

	// No new tab, and the Cellar document did not go anywhere: only the hash moved.
	expect(context.pages().length).toBe(pagesBefore);
	expect(page.url()).toBe(`${urlBefore.split('#')[0]}#${ANCHOR_ID}`);

	// It genuinely scrolled: the target is on screen and the container moved.
	const scrolled = await page.evaluate((id) => {
		const t = document.getElementById(id)!;
		const r = t.getBoundingClientRect();
		return { top: r.top, inView: r.top >= 0 && r.top <= window.innerHeight };
	}, ANCHOR_ID);
	expect(scrolled.inView).toBe(true);
});

test('a link in kernel markdown output opens a new tab too', async ({ page }) => {
	await openNotebook(page);
	const cell = page.locator('[data-testid="cell"][data-cell-id="code-mdout-aaaaaa"]');
	await cell.getByTestId('run').click();
	const link = cell.getByTestId('output').locator('a[href="https://example.com/kernel"]');
	await expect(link).toBeVisible();
	await expect(link).toHaveAttribute('target', '_blank');
	await expect(link).toHaveAttribute('rel', 'noreferrer noopener');
});
