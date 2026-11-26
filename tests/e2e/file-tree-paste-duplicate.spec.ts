/**
 * Paste and Duplicate in the file explorer, in a real browser against the real
 * launcher. Every assertion reads the FILESYSTEM as well as the tree.
 *
 * A paste from another app is driven with a synthetic `paste` event carrying a
 * DataTransfer of files, because a test cannot put Finder files on a CI
 * machine's clipboard. The event is dispatched at the document body, which is
 * where Chrome itself fires it when focus is on a tree row.
 */
import { test, expect, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { bootCellar, killCellar, runtimeAvailable, openSidebarSection, removeWorkspace } from './harness';

const REASON = 'requires the kernel runtime (uv + python3 + ~/.cellar/host-venv)';

test.describe(runtimeAvailable() ? 'file tree: paste and duplicate' : `file tree paste (skipped: ${REASON})`, () => {
	test.skip(!runtimeAvailable(), REASON);

	let ws: string;
	let proc: ChildProcess;
	let url: string;

	test.beforeAll(async () => {
		ws = mkdtempSync(join(tmpdir(), 'cellar-tree-paste-'));
		({ proc, url } = await bootCellar(ws));
	});
	test.afterAll(() => {
		if (proc) killCellar(proc);
		removeWorkspace(ws);
	});

	test.beforeEach(() => {
		for (const name of ['src', 'notes.md', 'notes copy.md', 'notes copy 2.md', 'shot.png']) {
			rmSync(join(ws, name), { recursive: true, force: true });
		}
		mkdirSync(join(ws, 'src/pkg'), { recursive: true });
		writeFileSync(join(ws, 'src/utils.py'), 'x = 1\n');
		writeFileSync(join(ws, 'src/pkg/a.py'), 'a\n');
		writeFileSync(join(ws, 'notes.md'), '# notes\n');
	});

	const fileRow = (page: Page, path: string) => page.locator(`[data-testid=tree-file][data-path="${path}"]`);
	const dirRow = (page: Page, path: string) => page.locator(`[data-testid=tree-dir][data-path="${path}"]`);

	async function openTree(page: Page): Promise<void> {
		await page.goto(url);
		await openSidebarSection(page, 'files', 'files-body');
		await expect(fileRow(page, 'notes.md')).toBeVisible();
		await dirRow(page, 'src').click();
		await expect(fileRow(page, 'src/utils.py')).toBeVisible();
	}

	async function menu(page: Page, row: ReturnType<typeof fileRow>, item: string): Promise<void> {
		await row.click({ button: 'right' });
		await page.getByTestId(item).click();
	}

	/** Fire a `paste` carrying `files` while focus sits on `row`, the way Chrome fires one. */
	async function pasteFiles(
		page: Page,
		row: ReturnType<typeof fileRow>,
		files: Array<{ name: string; type: string; size: number }>
	) {
		await row.focus();
		await page.evaluate((specs) => {
			const dt = new DataTransfer();
			for (const s of specs) {
				const bytes = new Uint8Array(s.size);
				for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
				dt.items.add(new File([bytes], s.name, { type: s.type }));
			}
			document.body.dispatchEvent(
				new ClipboardEvent('paste', {
					clipboardData: dt,
					bubbles: true,
					cancelable: true
				})
			);
		}, files);
	}

	test('Paste is always in the menu, disabled with a reason until something is copied', async ({ page }) => {
		await openTree(page);
		await fileRow(page, 'notes.md').click({ button: 'right' });
		const paste = page.getByTestId('ctx-paste');
		await expect(paste).toHaveAttribute('aria-disabled', 'true');
		await expect(paste).toHaveAttribute('title', /Nothing copied in Files/);
		await paste.dispatchEvent('click');
		await expect(page.getByTestId('tree-context-menu')).toBeVisible(); // a disabled item does nothing

		await page.getByTestId('ctx-copy').click();
		await menu(page, fileRow(page, 'src/utils.py'), 'ctx-paste');
		// Paste on a FILE lands in that file's folder.
		await expect(fileRow(page, 'src/notes.md')).toBeVisible();
		expect(readFileSync(join(ws, 'src/notes.md'), 'utf8')).toBe('# notes\n');
		await expect(fileRow(page, 'src/notes.md')).toHaveAttribute('data-selected', 'true');
	});

	test('Cmd/Ctrl+V on a selected file pastes into its folder', async ({ page }) => {
		await openTree(page);
		await menu(page, fileRow(page, 'notes.md'), 'ctx-copy');
		await fileRow(page, 'src/utils.py').click();
		await page.keyboard.press('ControlOrMeta+V');
		await expect.poll(() => existsSync(join(ws, 'src/notes.md'))).toBe(true);
		await expect(fileRow(page, 'src/notes.md')).toBeVisible();
		expect(existsSync(join(ws, 'notes.md'))).toBe(true); // a copy, not a move
	});

	test('Duplicate copies beside the entry with the next free name and selects it', async ({ page }) => {
		await openTree(page);
		await menu(page, fileRow(page, 'notes.md'), 'ctx-duplicate');
		await expect(fileRow(page, 'notes copy.md')).toBeVisible();
		await expect(fileRow(page, 'notes copy.md')).toHaveAttribute('data-selected', 'true');
		await expect(fileRow(page, 'notes copy.md')).toBeFocused();

		await menu(page, fileRow(page, 'notes.md'), 'ctx-duplicate');
		await expect(fileRow(page, 'notes copy 2.md')).toBeVisible();
		expect(readFileSync(join(ws, 'notes copy 2.md'), 'utf8')).toBe('# notes\n');

		await menu(page, dirRow(page, 'src/pkg'), 'ctx-duplicate');
		await expect(dirRow(page, 'src/pkg copy')).toBeVisible();
		expect(readFileSync(join(ws, 'src/pkg copy/a.py'), 'utf8')).toBe('a\n');
	});

	test('a paste of files from another app writes them into the folder', async ({ page }) => {
		await openTree(page);
		// Bigger than one upload chunk, so it travels in several requests.
		const size = 700 * 1024;
		await pasteFiles(page, fileRow(page, 'src/utils.py'), [{ name: 'shot.png', type: 'image/png', size }]);
		await expect(fileRow(page, 'src/shot.png')).toBeVisible();
		await expect(fileRow(page, 'src/shot.png')).toHaveAttribute('data-selected', 'true');
		const bytes = readFileSync(join(ws, 'src/shot.png'));
		expect(bytes.length).toBe(size);
		expect(bytes.every((b, i) => b === i % 251)).toBe(true);

		// A second paste of the same name follows the ` copy` rule.
		await pasteFiles(page, fileRow(page, 'src/shot.png'), [{ name: 'shot.png', type: 'image/png', size: 10 }]);
		await expect(fileRow(page, 'src/shot copy.png')).toBeVisible();
	});

	test('a paste with no files and nothing copied says so', async ({ page }) => {
		await openTree(page);
		await pasteFiles(page, fileRow(page, 'notes.md'), []);
		await expect(page.getByTestId('files-op-error')).toHaveText(/Nothing to paste/);
	});
});
