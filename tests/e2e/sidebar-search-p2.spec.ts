import { test, expect, type Page, type Locator } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * E2E for the P2 Search-coverage change (scope: 'all' + Source/All toggle).
 * Proves the END-USER experience the feature promises: Search now finds what a
 * user actually SEES on the page - a cell's OUTPUT text and a markdown cell's
 * RENDERED words - not just raw source, with a Source/All toggle to narrow back
 * to the P1 source-only behavior.
 *
 * The distinguishing evidence: a query that exists ONLY in a cell's output (never
 * in its source) matches under the default 'All' scope and DISAPPEARS under
 * 'Source' - so the toggle demonstrably changes what is found.
 *
 * Boots the REAL launcher against a throwaway workspace (see ./harness); SKIPS
 * when the kernel runtime is absent (local-only, like the other specs).
 */

const EVIDENCE_DIR =
	process.env.CELLAR_EVIDENCE_DIR ||
	'/var/folders/ds/m71hq5ln637g23x6xmrwqg080000gn/T/no-mistakes-evidence/01KY4MQMAFXFWQV3ATY0E1H4QK';

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-search-p2-'));
	const booted = await bootCellar(workspace);
	launcher = booted.proc;
	baseURL = booted.url;
	try {
		mkdirSync(EVIDENCE_DIR, { recursive: true });
	} catch {
		/* best effort */
	}
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

async function openNotebook(page: Page): Promise<void> {
	const openBtn = page.getByTestId('empty-open-notebook');
	if (await openBtn.isVisible().catch(() => false)) await openBtn.click();
	await expect(page.getByTestId('cell').first()).toBeVisible();
}

async function typeInto(page: Page, cell: Locator, text: string): Promise<void> {
	await cell.getByTestId('editor-scroll').click();
	const editor = cell.locator('.cm-content');
	await expect(editor).toBeVisible();
	await editor.click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.type(text);
	await expect(editor).toContainText(text.split('\n')[0]);
	// Blur to flush the debounced edit up to the notebook model the sidebar reads.
	await page.keyboard.press('Escape');
}

test('sidebar Search P2: All finds output + rendered markdown; Source toggle narrows to source only', async ({
	page
}) => {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);

	const cells = page.getByTestId('cell');

	// Cell 0: a code cell whose OUTPUT contains a string that is NOT in its source.
	//   source: `print(6 * 7)`  (no "42" anywhere in the source)
	//   output: `42`            (only visible in the output area)
	await typeInto(page, cells.nth(0), 'print(6 * 7)');
	await cells.nth(0).getByTestId('run').click();
	await expect(cells.nth(0).getByTestId('output-scroll')).toContainText('42', { timeout: 90_000 });

	// Cell 1: a MARKDOWN cell whose rendered heading shows a distinctive word.
	await page.getByTestId('add-markdown').click();
	await expect(cells).toHaveCount(2);
	await typeInto(page, cells.nth(1), '## Zephyr analysis notes');
	// Render it (Escape leaves edit mode; a markdown cell renders its source).
	await cells.nth(1).getByTestId('run').click().catch(() => {});
	await page.keyboard.press('Escape');

	// Open the Search sidebar section (it may start collapsed).
	const searchHeader = page.getByTestId('section-search');
	await searchHeader.scrollIntoViewIfNeeded();
	const searchInput = page.getByTestId('search-input');
	if (!(await searchInput.isVisible().catch(() => false))) {
		await searchHeader.click();
	}
	await expect(searchInput).toBeVisible();

	// The Source/All toggle exists; 'All' is the default (pressed).
	const scopeAll = page.getByTestId('search-scope-all');
	const scopeSource = page.getByTestId('search-scope-source');
	await expect(scopeAll).toBeVisible();
	await expect(scopeSource).toBeVisible();
	await expect(scopeAll).toHaveAttribute('aria-pressed', 'true');
	await expect(scopeSource).toHaveAttribute('aria-pressed', 'false');

	const count = page.getByTestId('search-count');
	const results = page.getByTestId('search-result');

	// ---- OUTPUT COVERAGE: "42" lives only in cell 0's OUTPUT ----
	// Under the default All scope it is found (1 match, in cell 0).
	await searchInput.click();
	await searchInput.fill('42');
	await expect(count).toHaveText('1 match in 1 cell', { timeout: 5_000 });
	await expect(results).toHaveCount(1);
	// The matched row's snippet is drawn from the OUTPUT text (where "42" lives),
	// not the source - direct proof the match came from output coverage.
	await expect(results.nth(0)).toContainText('42');

	// Evidence: All scope finds an output-only match.
	await page.screenshot({ path: join(EVIDENCE_DIR, 'search-p2-all-finds-output.png'), fullPage: false });

	// Toggle to Source scope: "42" is NOT in any source, so it disappears.
	await scopeSource.click();
	await expect(scopeSource).toHaveAttribute('aria-pressed', 'true');
	await expect(count).toHaveText('0 matches', { timeout: 5_000 });
	await expect(results).toHaveCount(0);

	// Evidence: Source scope narrows away the output-only match.
	await page.screenshot({ path: join(EVIDENCE_DIR, 'search-p2-source-no-output.png'), fullPage: false });

	// ---- RENDERED-MARKDOWN COVERAGE: a heading word matches under All ----
	// Back to All; "Zephyr" is a rendered markdown heading word.
	await scopeAll.click();
	await expect(scopeAll).toHaveAttribute('aria-pressed', 'true');
	await searchInput.fill('Zephyr');
	await expect(count).toHaveText('1 match in 1 cell', { timeout: 5_000 });
	await expect(results).toHaveCount(1);
	await expect(results.nth(0)).toContainText('Zephyr analysis notes');

	// Evidence: All scope finds a rendered-markdown heading word (dedup keeps ONE
	// visible occurrence even though it is scanned in both source + rendered text).
	await page.screenshot({ path: join(EVIDENCE_DIR, 'search-p2-all-finds-markdown.png'), fullPage: false });

	// Clearing the query removes the count + results instantly (both scopes).
	await searchInput.fill('');
	await expect(count).toHaveCount(0);
	await expect(results).toHaveCount(0);
});
