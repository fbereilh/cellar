/**
 * Move a file or folder by DRAGGING it onto a folder in the explorer.
 *
 * The gesture is the thing being pinned. Cellar drags cells, tabs and sidebar
 * sections, so a user who has learned the gesture tries it here too - and until
 * this landed it silently did nothing. Drag behaviour rots quietly (nothing
 * throws when a handler stops firing), so the contract has to be executable:
 * `tests/unit/file-drag.test.ts` proves the rules, and this proves the wiring -
 * a real pointer really producing a drag, the confirmation really gating the
 * move, and Cancel really leaving the tree alone.
 *
 * Every assertion reads the FILESYSTEM as well as the tree, because the tree is
 * a view that a stale refresh could make agree with a move that never happened.
 */
import { test, expect, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { bootCellar, killCellar, runtimeAvailable, openSidebarSection, removeWorkspace } from './harness';

const REASON = 'requires the kernel runtime (uv + python3 + ~/.cellar/host-venv)';

test.describe(runtimeAvailable() ? 'file tree: move by drag' : `file tree drag (skipped: ${REASON})`, () => {
	test.skip(!runtimeAvailable(), REASON);

	let ws: string;
	let proc: ChildProcess;
	let url: string;

	test.beforeAll(async () => {
		ws = mkdtempSync(join(tmpdir(), 'cellar-tree-drag-'));
		({ proc, url } = await bootCellar(ws));
	});
	test.afterAll(() => {
		if (proc) killCellar(proc);
		removeWorkspace(ws);
	});

	/**
	 * Rebuild the workspace tree from scratch. Every test drives the same handful
	 * of entries, and a test that MOVED one would otherwise re-point the next
	 * test's locator at something else - so each one starts from a known tree
	 * rather than from whatever its predecessor left.
	 */
	function seed(): void {
		for (const name of ['docs', 'archive', 'notes.md', 'report.md', 'nested', 'deep.md']) {
			rmSync(join(ws, name), { recursive: true, force: true });
		}
		mkdirSync(join(ws, 'docs'));
		mkdirSync(join(ws, 'archive'));
		mkdirSync(join(ws, 'nested/inner'), { recursive: true });
		writeFileSync(join(ws, 'notes.md'), '# notes\n');
		writeFileSync(join(ws, 'report.md'), '# report\n');
	}

	async function openTree(page: Page): Promise<void> {
		await page.goto(url);
		await openSidebarSection(page, 'files', 'files-body');
		await expect(page.locator('[data-testid=tree-file][data-path="notes.md"]')).toBeVisible();
	}

	const fileRow = (page: Page, path: string) => page.locator(`[data-testid=tree-file][data-path="${path}"]`);
	const dirRow = (page: Page, path: string) => page.locator(`[data-testid=tree-dir][data-path="${path}"]`);

	/**
	 * Drag `source` onto `target` with a real pointer - `dragTo` drives the
	 * browser's own drag machinery, so what is exercised is the gesture rather
	 * than a hand-dispatched event our handlers would accept either way.
	 */
	async function drag(page: Page, source: ReturnType<typeof fileRow>, target: ReturnType<typeof fileRow>) {
		await source.dragTo(target);
	}

	// The workspace is rebuilt before every test and the tree is fetched on mount,
	// so each test SEEDS and then LOADS - a test needing an extra entry writes it
	// between the two rather than reaching for a refresh afterwards.
	/**
	 * Hold a drag mid-gesture so what is on SCREEN can be read, then release where
	 * told. `dragTo` completes atomically, so it can prove the outcome but never
	 * the feedback the user steers by.
	 */
	async function dragHold(page: Page, source: ReturnType<typeof fileRow>, over: ReturnType<typeof fileRow>) {
		const a = (await source.boundingBox())!;
		const b = (await over.boundingBox())!;
		await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
		await page.mouse.down();
		await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
	}

	test.beforeEach(() => seed());

	test('drag a file onto a folder, confirm, and it moves', async ({ page }) => {
		await openTree(page);
		await drag(page, fileRow(page, 'notes.md'), dirRow(page, 'docs'));

		// It ASKS - nothing has moved yet.
		const modal = page.getByTestId('move-modal');
		await expect(modal).toBeVisible();
		await expect(page.getByTestId('move-from')).toHaveText('notes.md');
		await expect(page.getByTestId('move-dest')).toHaveText('docs');
		expect(existsSync(join(ws, 'notes.md'))).toBe(true);
		expect(existsSync(join(ws, 'docs/notes.md'))).toBe(false);

		await page.getByTestId('move-confirm').click();
		await expect(modal).toBeHidden();

		// On DISK, which is what a move means.
		await expect.poll(() => existsSync(join(ws, 'docs/notes.md'))).toBe(true);
		expect(existsSync(join(ws, 'notes.md'))).toBe(false);

		// And the tree refreshed: the row is gone from the root level.
		await expect(fileRow(page, 'notes.md')).toHaveCount(0);
		await dirRow(page, 'docs').click();
		await expect(fileRow(page, 'docs/notes.md')).toBeVisible();
	});

	test('cancelling leaves the file exactly where it was', async ({ page }) => {
		await openTree(page);
		await drag(page, fileRow(page, 'notes.md'), dirRow(page, 'docs'));
		await expect(page.getByTestId('move-modal')).toBeVisible();

		await page.getByTestId('move-cancel').click();
		await expect(page.getByTestId('move-modal')).toBeHidden();

		// Untouched in both places, and still in the tree where it started.
		expect(existsSync(join(ws, 'notes.md'))).toBe(true);
		expect(existsSync(join(ws, 'docs/notes.md'))).toBe(false);
		await expect(fileRow(page, 'notes.md')).toBeVisible();
	});

	test('a folder drags too, carrying its contents', async ({ page }) => {
		await openTree(page);
		await drag(page, dirRow(page, 'nested'), dirRow(page, 'archive'));
		await expect(page.getByTestId('move-from')).toHaveText('nested');
		await expect(page.getByTestId('move-dest')).toHaveText('archive');
		await page.getByTestId('move-confirm').click();

		await expect.poll(() => existsSync(join(ws, 'archive/nested/inner'))).toBe(true);
		expect(existsSync(join(ws, 'nested'))).toBe(false);
	});

	test('a name collision produces the " copy" variant, never an overwrite', async ({ page }) => {
		// An occupied destination name. The server de-duplicates rather than
		// clobbering; the drag must not have weakened that.
		writeFileSync(join(ws, 'docs/notes.md'), '# the one already there\n');
		await openTree(page);

		await drag(page, fileRow(page, 'notes.md'), dirRow(page, 'docs'));
		await page.getByTestId('move-confirm').click();

		await expect.poll(() => existsSync(join(ws, 'docs/notes copy.md'))).toBe(true);
		// The existing file survived, with its own bytes.
		expect(readFileSync(join(ws, 'docs/notes.md'), 'utf8')).toContain('already there');
		expect(readFileSync(join(ws, 'docs/notes copy.md'), 'utf8')).toContain('# notes');
	});

	test('dropping on a FILE is refused, and says why', async ({ page }) => {
		await openTree(page);
		await drag(page, fileRow(page, 'notes.md'), fileRow(page, 'report.md'));

		await expect(page.getByTestId('move-modal')).toHaveCount(0);
		await expect(page.getByTestId('files-op-error')).toContainText('folder');
		// Nothing moved, in either direction.
		expect(existsSync(join(ws, 'notes.md'))).toBe(true);
		expect(existsSync(join(ws, 'report.md'))).toBe(true);
	});

	test('dropping a folder into its own descendant is refused', async ({ page }) => {
		await openTree(page);
		await dirRow(page, 'nested').click(); // reveal `nested/inner`
		await expect(dirRow(page, 'nested/inner')).toBeVisible();

		await drag(page, dirRow(page, 'nested'), dirRow(page, 'nested/inner'));

		await expect(page.getByTestId('move-modal')).toHaveCount(0);
		await expect(page.getByTestId('files-op-error')).toContainText('inside itself');
		expect(existsSync(join(ws, 'nested/inner'))).toBe(true);
		expect(existsSync(join(ws, 'nested/inner/nested'))).toBe(false);
	});

	test('releasing back on the dragged row itself says nothing', async ({ page }) => {
		await openTree(page);
		// Pick up, change your mind, let go where you are: an abort, not a mistake.
		await dragHold(page, fileRow(page, 'notes.md'), fileRow(page, 'report.md'));
		const own = (await fileRow(page, 'notes.md').boundingBox())!;
		await page.mouse.move(own.x + own.width / 2, own.y + own.height / 2, { steps: 8 });
		await page.mouse.up();
		await expect(page.locator('[data-dragging]')).toHaveCount(0);
		await expect(page.getByTestId('files-op-error')).toHaveCount(0);
		await expect(page.getByTestId('move-modal')).toHaveCount(0);

		// A folder released on itself: the same silence.
		await dragHold(page, dirRow(page, 'nested'), fileRow(page, 'report.md'));
		const nb = (await dirRow(page, 'nested').boundingBox())!;
		await page.mouse.move(nb.x + nb.width / 2, nb.y + nb.height / 2, { steps: 8 });
		await page.mouse.up();
		await expect(page.locator('[data-dragging]')).toHaveCount(0);
		await expect(page.getByTestId('files-op-error')).toHaveCount(0);
		expect(existsSync(join(ws, 'notes.md'))).toBe(true);
		expect(existsSync(join(ws, 'nested/inner'))).toBe(true);

		// CONTROL: the same gesture released over a DIFFERENT file still reports,
		// so the silence above is about the self-release and nothing wider.
		await dragHold(page, fileRow(page, 'notes.md'), fileRow(page, 'report.md'));
		await page.mouse.up();
		await expect(page.getByTestId('files-op-error')).toContainText('folder');
		expect(existsSync(join(ws, 'notes.md'))).toBe(true);
	});

	test('Escape abandons a drag without reporting a refusal', async ({ page }) => {
		await openTree(page);
		await dragHold(page, fileRow(page, 'notes.md'), fileRow(page, 'report.md'));
		await page.keyboard.press('Escape');
		await page.mouse.up();
		await expect(page.locator('[data-dragging]')).toHaveCount(0);
		await expect(page.getByTestId('files-op-error')).toHaveCount(0);
		await expect(page.getByTestId('move-modal')).toHaveCount(0);
		expect(existsSync(join(ws, 'notes.md'))).toBe(true);
		expect(existsSync(join(ws, 'report.md'))).toBe(true);

		// CONTROL: without the Escape, the identical hold reports why.
		await dragHold(page, fileRow(page, 'notes.md'), fileRow(page, 'report.md'));
		await page.mouse.up();
		await expect(page.getByTestId('files-op-error')).toContainText('folder');
	});

	test('a nested entry dragged to the root drop area moves to the workspace root', async ({ page }) => {
		writeFileSync(join(ws, 'nested/deep.md'), '# deep\n');
		await openTree(page);
		// The strip appears only while dragging, so the tree's resting layout is unchanged.
		await expect(page.getByTestId('files-root-drop')).toHaveCount(0);
		await dirRow(page, 'nested').click();
		await expect(fileRow(page, 'nested/deep.md')).toBeVisible();

		await dragHold(page, fileRow(page, 'nested/deep.md'), fileRow(page, 'report.md'));
		const strip = page.getByTestId('files-root-drop');
		await expect(strip).toBeVisible();
		const sb = (await strip.boundingBox())!;
		await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2, { steps: 8 });
		await expect(page.getByTestId('files-body')).toHaveAttribute('data-drop-target', 'true');
		await page.mouse.up();

		await expect(page.getByTestId('move-modal')).toBeVisible();
		await expect(page.getByTestId('move-from')).toHaveText('deep.md');
		await page.getByTestId('move-confirm').click();

		// On DISK: at the workspace root, gone from the folder.
		await expect.poll(() => existsSync(join(ws, 'deep.md'))).toBe(true);
		expect(existsSync(join(ws, 'nested/deep.md'))).toBe(false);
		await expect(fileRow(page, 'deep.md')).toBeVisible();
		await expect(strip).toHaveCount(0);
	});

	test('dropping into the folder it is already in asks nothing and says nothing', async ({ page }) => {
		await openTree(page);
		await dirRow(page, 'nested').click();
		await expect(dirRow(page, 'nested/inner')).toBeVisible();

		// `inner` is already in `nested`: the server would treat this as a no-op, so
		// a confirmation would be a dialog about nothing - and an ERROR would be
		// worse, since nothing was done wrong.
		await drag(page, dirRow(page, 'nested/inner'), dirRow(page, 'nested'));

		await expect(page.getByTestId('move-modal')).toHaveCount(0);
		await expect(page.getByTestId('files-op-error')).toHaveCount(0);
		expect(existsSync(join(ws, 'nested/inner'))).toBe(true);

		// CONTROL, and it is what stops the silence above being vacuous: "nothing
		// happened" is equally true of a page where dragging does nothing at all.
		// The same row, dragged somewhere it MAY go, must still ask.
		await drag(page, dirRow(page, 'nested/inner'), dirRow(page, 'archive'));
		await expect(page.getByTestId('move-modal')).toBeVisible();
		await page.getByTestId('move-cancel').click();
	});

	test('a drag does not toggle the folder it started on', async ({ page }) => {
		await openTree(page);
		// The row is a button whose click toggles the folder open. A drag must not
		// also be read as that click - a control inside a tree row stays a control.
		const nested = dirRow(page, 'nested');
		await expect(dirRow(page, 'nested/inner')).toHaveCount(0); // collapsed

		await drag(page, nested, dirRow(page, 'archive'));
		await page.getByTestId('move-cancel').click();

		await expect(dirRow(page, 'nested/inner')).toHaveCount(0); // still collapsed
	});

	test('the ordinary click still opens a file after the drag feature exists', async ({ page }) => {
		await openTree(page);
		// `draggable` on a row must not cost it its click.
		await fileRow(page, 'report.md').click();
		await expect(page.locator('[data-testid=tab]').filter({ hasText: 'report.md' })).toBeVisible();
	});

	test('a valid target is visibly distinct mid-drag; an invalid one is not', async ({ page }) => {
		await openTree(page);
		const docs = dirRow(page, 'docs');
		const report = fileRow(page, 'report.md');

		const bg = (l: ReturnType<typeof fileRow>) =>
			l.evaluate((el) => getComputedStyle(el).backgroundColor);
		const resting = await bg(docs);

		// Over a folder that accepts it: the row marks itself as the drop target -
		// and really REPAINTS. The attribute alone would still be there if the
		// styling were dropped, and "visibly distinct" is a claim about pixels.
		await dragHold(page, fileRow(page, 'notes.md'), docs);
		await expect(docs).toHaveAttribute('data-drop-target', 'true');
		expect(await bg(docs)).not.toBe(resting);
		// And the row being dragged says so too, so the gesture reads as in flight.
		await expect(fileRow(page, 'notes.md')).toHaveAttribute('data-dragging', 'true');

		// Moving on to a FILE: the mark follows the pointer off the folder and the
		// file never takes it - an invalid target must not read as droppable.
		const rb = (await report.boundingBox())!;
		await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2, { steps: 8 });
		await expect(report).not.toHaveAttribute('data-drop-target', 'true');
		await expect(docs).not.toHaveAttribute('data-drop-target', 'true');
		expect(await bg(docs)).toBe(resting);

		await page.mouse.up();
		// Nothing was marked once the drag ended.
		await expect(page.locator('[data-drop-target]')).toHaveCount(0);
		await expect(page.locator('[data-dragging]')).toHaveCount(0);
	});

	test('cut/paste still moves, unchanged', async ({ page }) => {
		await openTree(page);
		// The drag shares ONE move commit with cut/paste; this is the regression
		// guard on the path that already existed.
		await fileRow(page, 'report.md').click({ button: 'right' });
		await page.getByTestId('ctx-cut').click();
		await dirRow(page, 'archive').click({ button: 'right' });
		await page.getByTestId('ctx-paste').click();

		await expect.poll(() => existsSync(join(ws, 'archive/report.md'))).toBe(true);
		expect(existsSync(join(ws, 'report.md'))).toBe(false);
		// Cut/paste is deliberately NOT gated by the confirmation.
		await expect(page.getByTestId('move-modal')).toHaveCount(0);
	});
});
