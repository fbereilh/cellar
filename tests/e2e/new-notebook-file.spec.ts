/**
 * Creating a new `.ipynb` from the file explorer produces a notebook that OPENS.
 *
 * The reported bug, reproduced exactly by the first test below: "New file" ->
 * `analysis.ipynb` wrote a ZERO-BYTE file, and opening it rendered
 * `Could not open analysis.ipynb: Unexpected end of JSON input`. The empty-state
 * "New notebook" button went through a different writer and worked, which is why
 * the failure looked route-specific.
 *
 * This is the END-USER path, so it is the one that has to be pinned: the unit
 * suite covers the writer and the reader directly, but only a real browser
 * against the real launcher shows the two ends meeting - the explorer's click
 * really reaching the route, and the tab really rendering a notebook rather than
 * a load error.
 *
 * The second test covers the reader, which stays STRICT: a blank `.ipynb` that
 * Cellar did NOT write (a `touch`, a rename or a copy of an empty file, or one an
 * older Cellar left behind) is REFUSED - but with a message that says what it is
 * and what to do about it, rather than the raw `Unexpected end of JSON input` this
 * bug was reported as. It is still the end-user path, just with the strict
 * outcome; `readNotebook` records why the leniency that was tried is not there.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { bootCellar, killCellar, runtimeAvailable, openSidebarSection } from './harness';

const REASON = 'requires the kernel runtime (uv + python3 + ~/.cellar/host-venv)';

test.describe(runtimeAvailable() ? 'new .ipynb from the file explorer' : `new .ipynb (skipped: ${REASON})`, () => {
	test.skip(!runtimeAvailable(), REASON);

	let ws: string;
	let proc: ChildProcess;
	let url: string;

	test.beforeAll(async () => {
		ws = mkdtempSync(join(tmpdir(), 'cellar-new-ipynb-'));
		({ proc, url } = await bootCellar(ws));
	});
	test.afterAll(() => proc && killCellar(proc));

	/** Create a file through the explorer's "New file" control, exactly as a user does. */
	async function newFile(page: Page, name: string): Promise<void> {
		await openSidebarSection(page, 'files', 'files-body');
		await page.getByTestId('files-new-file').click();
		const field = page.getByTestId('tree-entry-field');
		await expect(field).toBeVisible();
		await field.fill(name);
		await field.press('Enter');
		await expect(page.getByTestId('tree-file').filter({ hasText: name })).toBeVisible();
	}

	/** Open a workspace file from the tree into a permanent tab (double-click). */
	async function openFromTree(page: Page, name: string): Promise<void> {
		await page.getByTestId('tree-file').filter({ hasText: name }).dblclick();
	}

	/**
	 * The VISIBLE notebook pane. Every opened notebook stays mounted (hidden) so its
	 * editor/run state survives a tab switch, so an unscoped `getByTestId('cell')`
	 * counts the cells of every tab this workspace has ever opened.
	 */
	function pane(page: Page) {
		return page.locator('[role=tabpanel]:not(.hidden)');
	}

	test('creates a notebook that opens and runs', async ({ page }) => {
		await page.goto(url);
		await newFile(page, 'analysis.ipynb');

		// On disk: a real notebook, not the zero bytes this bug was about.
		const abs = join(ws, 'analysis.ipynb');
		expect(statSync(abs).size).toBeGreaterThan(0);
		const raw = JSON.parse(readFileSync(abs, 'utf8'));
		expect(raw.nbformat).toBe(4);
		expect(raw.cells).toHaveLength(1);

		await openFromTree(page, 'analysis.ipynb');
		// The regression assertion: no load error, and a real editable cell.
		const cells = pane(page).getByTestId('cell');
		await expect(cells).toHaveCount(1);
		await expect(page.getByTestId('notebook-load-error')).toHaveCount(0);

		// And it is a working notebook, not merely a rendered one: run a cell.
		await cells.first().click();
		await page.keyboard.type('6 * 7');
		await page.keyboard.press('Shift+Enter');
		await expect(cells.first()).toContainText('42', { timeout: 60_000 });
	});

	test('a blank .ipynb Cellar did not write says what is wrong with it', async ({ page }) => {
		// `touch blank.ipynb` (or a rename/copy of an empty file). The reader refuses
		// it - see `readNotebook` - but the message a user reads has to be the
		// actionable one, not the raw parser error this bug was reported as.
		const abs = join(ws, 'blank.ipynb');
		writeFileSync(abs, '');

		// A fresh load fetches the tree, so the file is listed with no refresh click.
		await page.goto(url);
		await openSidebarSection(page, 'files', 'files-body');
		await openFromTree(page, 'blank.ipynb');

		const err = page.getByTestId('notebook-load-error');
		await expect(err).toContainText(/file is empty/i);
		await expect(err).toContainText(/create it again from the file explorer/i);
		await expect(err).not.toContainText(/JSON input/i);
		// A refusal writes nothing - Cellar still leaves the file exactly as it was.
		expect(statSync(abs).size).toBe(0);
	});
});

/**
 * The CANONICAL notebook is the one file whose unreadability used to take the whole
 * shell down: SSR seeds itself from it, so a blank `notebook.ipynb` threw during
 * `load()` and the user never reached the file explorer the refusal names as the
 * repair (and, in a production build, was not even shown the reason). It must cost
 * one tab's worth of information, not the page - so this boots its OWN workspace,
 * blank before the first request, because the canonical document is materialised in
 * memory on the first load and would otherwise already be cached.
 */
test.describe(
	runtimeAvailable() ? 'a blank canonical notebook.ipynb' : `blank canonical notebook (skipped: ${REASON})`,
	() => {
		test.skip(!runtimeAvailable(), REASON);

		let ws: string;
		let proc: ChildProcess;
		let url: string;

		test.beforeAll(async () => {
			ws = mkdtempSync(join(tmpdir(), 'cellar-blank-canonical-'));
			writeFileSync(join(ws, 'notebook.ipynb'), '');
			({ proc, url } = await bootCellar(ws));
		});
		test.afterAll(() => proc && killCellar(proc));

		test('renders the shell, says why, and leaves the explorer usable', async ({ page }) => {
			await page.goto(url);

			// The shell rendered at all - the regression is that this page 500s.
			const reason = page.getByTestId('canonical-notebook-error');
			await expect(reason).toBeVisible();
			await expect(reason).toContainText(/file is empty/i);
			await expect(reason).not.toContainText(/JSON input/i);

			// And the remedy the message names is actually reachable: the explorer
			// works, so the file can be deleted and created again.
			await openSidebarSection(page, 'files', 'files-body');
			await expect(page.getByTestId('tree-file').filter({ hasText: 'notebook.ipynb' })).toBeVisible();
			await page.getByTestId('files-new-file').click();
			const field = page.getByTestId('tree-entry-field');
			await expect(field).toBeVisible();
			await field.fill('fresh.ipynb');
			await field.press('Enter');
			await expect(page.getByTestId('tree-file').filter({ hasText: 'fresh.ipynb' })).toBeVisible();

			// The unreadable file is left exactly as it was.
			expect(statSync(join(ws, 'notebook.ipynb')).size).toBe(0);

			// The delete advice belongs to THIS reason and only this one: the file
			// holds nothing, so nothing can be lost by acting on it.
			await expect(page.getByTestId('canonical-notebook-guidance')).toContainText(/delete this file/i);
		});
	}
);

/**
 * The CORRUPT canonical notebook is the case where the guidance itself is the data
 * hazard: those bytes are the user's, which is exactly why the strict reader
 * refuses to overwrite them - so the shell must not turn round and tell them to
 * delete the file. Cellar refusing to destroy it and then advising the user to
 * destroy it are the same loss by another hand.
 */
test.describe(
	runtimeAvailable() ? 'a corrupt canonical notebook.ipynb' : `corrupt canonical notebook (skipped: ${REASON})`,
	() => {
		test.skip(!runtimeAvailable(), REASON);

		// A renamed `.js` file: present, plainly the user's content, and not JSON.
		const CORRUPT = '// analysis notes\nconst kept = 1;\n';

		let ws: string;
		let proc: ChildProcess;
		let url: string;

		test.beforeAll(async () => {
			ws = mkdtempSync(join(tmpdir(), 'cellar-corrupt-canonical-'));
			writeFileSync(join(ws, 'notebook.ipynb'), CORRUPT);
			({ proc, url } = await bootCellar(ws));
		});
		test.afterAll(() => proc && killCellar(proc));

		test('never advises deleting it, and leaves the bytes alone', async ({ page }) => {
			await page.goto(url);

			const reason = page.getByTestId('canonical-notebook-error');
			await expect(reason).toBeVisible();
			await expect(reason).toContainText(/not valid JSON/i);

			const guidance = page.getByTestId('canonical-notebook-guidance');
			await expect(guidance).toBeVisible();
			await expect(guidance).toContainText(/cannot parse/i);
			// The headline assertion: no branch of this page may advise destroying it.
			await expect(guidance).not.toContainText(/delete/i);
			await expect(guidance).toContainText(/reload/i);

			// And the claim that actually matters: the user's bytes are untouched.
			expect(readFileSync(join(ws, 'notebook.ipynb'), 'utf8')).toBe(CORRUPT);
		});
	}
);
