import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';
import { isCellMounted, setScrollTop } from './notebook-scroll';

/**
 * Cell virtualization: an agent's edit to a WINDOWED-OUT cell must reach the
 * notebook MODEL, not just a marker only a mounted Cell can consume.
 *
 * `cell:edited` hands the new source to the Cell (the editor-safety rule: apply it
 * only when the user isn't typing there), which is what writes `cell.source`. With
 * windowing on by default a far cell has no Cell instance at all, so the model
 * would keep the PRE-edit text for as long as it stays off-screen — and the model
 * is what every non-editor reader falls back to: `runCodeIds` reads it for a bulk
 * run and `/api/cells/[id]/run` PERSISTS whatever it is POSTed. So a Run all would
 * execute the stale code and write it over the agent's edit in the `.ipynb`,
 * silently. It also feeds the sidebar Search / outline, so the edit would be
 * unfindable until the cell happened to scroll back.
 *
 * The second case is the same defect reached through the STASH: a remote edit that
 * arrived while the caret was in the cell lives only on that instance, so windowing
 * the cell out has to hand it to the model too (the user never typed, so there is no
 * local text it could clobber) - otherwise the run reads the pre-stash source.
 *
 * The third case is that hand-back's own limit: a DELIBERATE local rewrite (split-cell)
 * supersedes an unresolved stash exactly as typing does. It cannot be seen by the
 * editor's update listener (a rewrite runs through the remote-apply path, which that
 * listener skips), so without an explicit drop the teardown would hand the stale marker
 * back over the rewrite and the cell would come back holding the pre-split text.
 *
 * The fixture is deliberately one lone code cell in the middle of a tall markdown
 * notebook: tall enough that the target is windowed out at the top, cheap enough
 * that "Run all" is exactly one kernel run.
 *
 * Boots the REAL launcher (Node app + Jupyter sidecar + python3 kernel), so it
 * SKIPS when that runtime is missing.
 */

const CELL_COUNT = 120;
const TARGET_INDEX = 60;
const TARGET = `c${TARGET_INDEX}`;
const NB = 'notebook.ipynb';
const STALE = 'print("STALE_ORIGINAL")';
const EDITED = 'print("REMOTE_EDIT_OK")';
const STASHED = 'print("STASH_EDIT_OK")';
const SPLIT_UPPER = 'print("SPLIT_UPPER_OK")';
const SPLIT_LOWER = 'print("SPLIT_LOWER_OK")';
const SPLIT_STASH = 'print("SPLIT_STASH_LOST")';

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

/** Tall markdown filler + ONE code cell at `TARGET_INDEX`, ids `c0`…`cN`. */
function buildNotebook(): string {
	const cells = Array.from({ length: CELL_COUNT }, (_, i) => {
		const base = { id: `c${i}`, metadata: {} };
		if (i === TARGET_INDEX) {
			return { ...base, cell_type: 'code', execution_count: null, outputs: [], source: [STALE] };
		}
		return {
			...base,
			cell_type: 'markdown',
			source: [`## Section ${i}\n`, '\n', 'Prose that gives this cell real rendered height.\n', '\n', '- one\n', '- two\n']
		};
	});
	return JSON.stringify({
		cells,
		metadata: { kernelspec: { name: 'python3', display_name: 'python3' } },
		nbformat: 4,
		nbformat_minor: 5
	});
}

/** The target cell as the SERVER holds it: its source and its flattened output text. */
async function serverCell(page: Page): Promise<{ source: string; output: string }> {
	return page.evaluate(
		async ({ nb, id }) => {
			const res = await fetch(`/api/notebooks?path=${encodeURIComponent(nb)}`);
			const body = await res.json();
			const cell = body.notebook.cells.find((c: { id: string }) => c.id === id);
			return {
				source: cell?.source ?? '',
				output: (cell?.outputs ?? [])
					.map((o: { text?: string | string[] }) => (Array.isArray(o.text) ? o.text.join('') : (o.text ?? '')))
					.join('')
			};
		},
		{ nb: NB, id: TARGET }
	);
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-virt-remote-'));
	writeFileSync(join(workspace, NB), buildNotebook());
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

/** Open the notebook windowed and settle at the top. */
async function openWindowed(page: Page): Promise<void> {
	// Windowing pinned ON explicitly (it is the default since P5, but this spec must
	// exercise the ON path regardless).
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}&virtualize=1`);
	const openButton = page.getByTestId('empty-open-notebook');
	if (await openButton.isVisible({ timeout: 10_000 }).catch(() => false)) await openButton.click();
	await expect(page.getByTestId('cell').first()).toBeVisible({ timeout: 30_000 });
	await expect
		.poll(() => page.locator('[data-testid="cell-spacer"]').count(), { timeout: 30_000 })
		.toBeGreaterThan(0);
	await setScrollTop(page, 0);
}

/** Rewrite a cell the way an agent does: out-of-band, no `originId`, so the tab gets `cell:edited`. */
async function agentEdit(page: Page, source: string): Promise<void> {
	await page.evaluate(
		({ nb, id, src }) =>
			fetch(`/api/cells/${id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ nb, source: src })
			}).then(() => undefined),
		{ nb: NB, id: TARGET, src: source }
	);
}

/** Open the sidebar Search section and type `needle` into it. */
async function typeSearch(page: Page, needle: string): Promise<void> {
	const searchHeader = page.getByTestId('section-search');
	await searchHeader.scrollIntoViewIfNeeded();
	const searchInput = page.getByTestId('search-input');
	if (!(await searchInput.isVisible().catch(() => false))) await searchHeader.click();
	await expect(searchInput).toBeVisible();
	await searchInput.fill(needle);
}

/**
 * How many cells the sidebar Search finds `needle` in. Search reads the notebook's
 * live cell MODEL (never the DOM), so it answers for a cell nothing has mounted -
 * which makes it the cheap observation of whether the model took a remote edit.
 * Waits for a hit, but returns the count either way so the caller can judge it.
 */
async function searchHits(page: Page, needle: string): Promise<number> {
	await typeSearch(page, needle);
	await page
		.getByTestId('search-result')
		.first()
		.waitFor({ timeout: 15_000 })
		.catch(() => {});
	return page.getByTestId('search-result').count();
}

/**
 * Assert Search finds `needle` NOWHERE. This reads the debounced COUNT line, not the
 * result rows: the query is debounced, so a row-count read right after typing would
 * still be answering for the PREVIOUS query and a stale hit would read as a match.
 */
async function expectNoSearchHits(page: Page, needle: string): Promise<void> {
	await typeSearch(page, needle);
	await expect(page.getByTestId('search-count')).toHaveText('0 matches', { timeout: 15_000 });
}

/** Empty the target's outputs so the next run's output is unambiguously the new one. */
async function clearTargetOutputs(page: Page): Promise<void> {
	await page.evaluate(
		({ nb, id }) => fetch(`/api/cells/${id}/clear?nb=${encodeURIComponent(nb)}`, { method: 'POST' }).then(() => undefined),
		{ nb: NB, id: TARGET }
	);
	await expect.poll(async () => (await serverCell(page)).output, { timeout: 10_000 }).toBe('');
}

test('an agent edit to a windowed-out cell is what Run all executes and persists', async ({ page }) => {
	test.setTimeout(180_000);

	await openWindowed(page);

	// The target is half a notebook down: no DOM node, so no Cell instance to hand a
	// remote edit to. This is the premise the whole test rests on.
	await expect.poll(() => isCellMounted(page, TARGET), { timeout: 15_000 }).toBe(false);

	await agentEdit(page, EDITED);

	// The MODEL took the edit. SOFT, so the run assertions below are still reached
	// (and still judged) when this one fails: a stale model breaks searchability AND
	// execution, and the second is the data-loss half.
	expect.soft(await searchHits(page, 'REMOTE_EDIT_OK')).toBe(1);

	// Nothing scrolled: the cell is still windowed out when the run reads its source.
	expect(await isCellMounted(page, TARGET)).toBe(false);

	// ---- Run all, without ever scrolling back to it ----
	await expect(page.getByTestId('run-all')).toBeEnabled();
	await page.getByTestId('run-all').click();
	// Poll only for the run to have PRODUCED something, so a wrong result is judged
	// rather than waited out.
	await expect.poll(async () => (await serverCell(page)).output.length, { timeout: 60_000 }).toBeGreaterThan(0);

	// The agent's edit is what RAN, and it is still what the .ipynb holds: the run
	// route persists the source it was POSTed, so a stale model would have reverted
	// the cell to its pre-edit text as a side effect of running it.
	const after = await serverCell(page);
	expect(after.output).toContain('REMOTE_EDIT_OK');
	expect(after.output).not.toContain('STALE_ORIGINAL');
	expect(after.source).toContain('REMOTE_EDIT_OK');
	expect(after.source).not.toContain('STALE_ORIGINAL');
});

test('an unresolved "changed on server" stash survives the cell windowing out', async ({ page }) => {
	test.setTimeout(180_000);

	await openWindowed(page);

	// Jump to the target through the sidebar Search (a supported jump path: it mounts
	// the cell first), then put the caret in its editor - the state that makes a
	// remote edit STASH behind the "changed on server" banner instead of applying.
	expect(await searchHits(page, 'REMOTE_EDIT_OK')).toBe(1);
	await page.getByTestId('search-result').first().click();
	await expect.poll(() => isCellMounted(page, TARGET), { timeout: 15_000 }).toBe(true);
	const cell = page.locator(`[data-cell-id="${TARGET}"]`);
	await cell.getByTestId('editor-scroll').click();
	await expect(cell.locator('.cm-content')).toBeVisible({ timeout: 10_000 });
	await cell.locator('.cm-content').click();

	// ---- The agent edits it WHILE the user holds the caret there ----
	await agentEdit(page, STASHED);
	await expect(cell.getByTestId('remote-changed')).toBeVisible({ timeout: 15_000 });

	// The user resolves nothing: they click away (so the cell is no longer pinned)
	// and scroll off, destroying the instance the stash lived on.
	const other = await page.evaluate(
		(target: string) =>
			Array.from(document.querySelectorAll('[data-cell-id]'))
				.map((el) => (el as HTMLElement).dataset.cellId as string)
				.find((id) => id !== target) ?? null,
		TARGET
	);
	expect(other).not.toBeNull();
	await page.locator(`[data-cell-id="${other}"]`).click({ position: { x: 5, y: 5 } });
	await setScrollTop(page, 0);
	await expect.poll(() => isCellMounted(page, TARGET), { timeout: 15_000 }).toBe(false);

	// Nothing owns the cell now, so the stash has to have reached the model: the user
	// never typed, so there is no local text it could be clobbering.
	expect.soft(await searchHits(page, 'STASH_EDIT_OK')).toBe(1);

	// …and a run must execute and persist it, not the pre-stash source.
	await clearTargetOutputs(page);
	await page.getByTestId('run-all').click();
	await expect.poll(async () => (await serverCell(page)).output.length, { timeout: 60_000 }).toBeGreaterThan(0);
	const after = await serverCell(page);
	expect(after.output).toContain('STASH_EDIT_OK');
	expect(after.source).toContain('STASH_EDIT_OK');
	expect(after.source).not.toContain('REMOTE_EDIT_OK');
});

test('a split over an unresolved stash supersedes it, and windowing out keeps the split', async ({ page }) => {
	test.setTimeout(180_000);

	await openWindowed(page);
	// Two lines, so the split has a distinguishable upper and lower half.
	await agentEdit(page, `${SPLIT_UPPER}\n${SPLIT_LOWER}`);

	// Jump to the target and put the caret at the START of its second line, so the
	// split point is deterministic: doc start (Home from the top line), then down.
	expect(await searchHits(page, 'SPLIT_UPPER_OK')).toBe(1);
	await page.getByTestId('search-result').first().click();
	await expect.poll(() => isCellMounted(page, TARGET), { timeout: 15_000 }).toBe(true);
	const cell = page.locator(`[data-cell-id="${TARGET}"]`);
	await cell.getByTestId('editor-scroll').click();
	await expect(cell.locator('.cm-content')).toBeVisible({ timeout: 10_000 });
	await cell.locator('.cm-content').click();
	for (const key of ['ArrowUp', 'ArrowUp', 'Home', 'ArrowDown', 'Home']) await page.keyboard.press(key);

	// ---- The agent edits it while the caret sits there: the edit STASHES ----
	await agentEdit(page, SPLIT_STASH);
	await expect(cell.getByTestId('remote-changed')).toBeVisible({ timeout: 15_000 });

	// The user resolves the banner neither way - they split the cell instead. That is
	// a deliberate local rewrite, so it supersedes the stash (`Ctrl Shift -` names the
	// physical Ctrl key on every platform, JupyterLab's spelling).
	await page.keyboard.press('Control+Shift+Minus');
	await expect.poll(async () => (await serverCell(page)).source, { timeout: 15_000 }).toBe(`${SPLIT_UPPER}\n`);

	// The split lands the caret in the created lower half, and that jump scrolls -
	// so wait for it before scrolling away, and re-apply the scroll each poll so a
	// late-settling jump can't quietly put the target back on screen.
	await expect(page.locator('.cm-editor.cm-focused')).toHaveCount(1, { timeout: 15_000 });

	// Scroll off, destroying the instance: the superseded stash must NOT be handed back.
	await expect
		.poll(
			async () => {
				await setScrollTop(page, 0);
				return isCellMounted(page, TARGET);
			},
			{ timeout: 20_000 }
		)
		.toBe(false);

	// The model holds the split half, not the stale remote source (search reads the
	// live cell model, so it answers for a cell nothing has mounted).
	await expectNoSearchHits(page, 'SPLIT_STASH_LOST');

	// …and a run executes and persists the split half, so the rewrite is not reverted.
	await clearTargetOutputs(page);
	await page.getByTestId('run-all').click();
	await expect.poll(async () => (await serverCell(page)).output.length, { timeout: 60_000 }).toBeGreaterThan(0);
	const after = await serverCell(page);
	expect(after.output).toContain('SPLIT_UPPER_OK');
	expect(after.output).not.toContain('SPLIT_STASH_LOST');
	expect(after.source).toBe(`${SPLIT_UPPER}\n`);
});
