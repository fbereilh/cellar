import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, renameSync, unlinkSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * An open `.md` file staying in sync with edits made to it OUTSIDE Cellar.
 *
 * This is the only level that proves the whole chain: the directory watcher, the
 * settle debounce, the content-hash gate, the SSE hop, and the CodeMirror apply.
 * The unit suite proves the watcher against the filesystem; it cannot see the
 * wire or the editor.
 *
 * Every external write below goes through `agentWrite` - a sibling temp file
 * `rename()`d over the target - because that is what Claude Code's own
 * `Edit`/`Write` were measured doing, and it is exactly the pattern a per-file
 * `fs.watch` cannot survive. Using `writeFileSync` here would pass against an
 * implementation that is broken for the case this feature exists for.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const EDITOR_MD = '# Editor doc\n\nalpha\nbeta\ngamma\n';
const PREVIEW_MD = '# Preview doc\n\noriginal prose\n';
const CONFLICT_MD = '# Conflict doc\n\nline one\n';
const ECHO_MD = '# Echo doc\n\nsaved by cellar\n';
const DELETE_MD = '# Delete doc\n\nabout to vanish\n';
/** Tall enough that the editor really scrolls, so the scroll claim can be checked. */
const LONG_LINES = Array.from({ length: 400 }, (_, i) => `line ${String(i).padStart(3, '0')}`);
const LONG_MD = LONG_LINES.join('\n') + '\n';

/** Write a file the way an LLM edit tool does: temp file + rename over the target. */
function agentWrite(abs: string, text: string): void {
	const temp = `${abs}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
	writeFileSync(temp, text, 'utf8');
	renameSync(temp, abs);
}

test.beforeAll(async () => {
	test.skip(
		!runtimeAvailable(),
		'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only'
	);
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-mdsync-'));
	writeFileSync(join(workspace, 'editor.md'), EDITOR_MD);
	writeFileSync(join(workspace, 'preview.md'), PREVIEW_MD);
	writeFileSync(join(workspace, 'conflict.md'), CONFLICT_MD);
	writeFileSync(join(workspace, 'echo.md'), ECHO_MD);
	writeFileSync(join(workspace, 'delete.md'), DELETE_MD);
	writeFileSync(join(workspace, 'long.md'), LONG_MD);
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

async function openFile(page: Page, name: string) {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await page.locator(`[data-testid="tree-file"][data-path="${name}"]`).click();
}

test('an external temp+rename edit reaches the open editor, repeatedly', async ({ page }) => {
	await openFile(page, 'editor.md');
	const editor = page.locator('.cm-content:visible');
	await expect(editor).toContainText('alpha');

	const abs = join(workspace, 'editor.md');

	// Three edits in a row. A per-file watcher passes the FIRST of these and then
	// goes silent forever, so one round trip would not prove anything.
	for (const marker of ['EXTERNAL-ONE', 'EXTERNAL-TWO', 'EXTERNAL-THREE']) {
		agentWrite(abs, `# Editor doc\n\nalpha\n${marker}\ngamma\n`);
		await expect(editor).toContainText(marker);
	}
	// The last write won, and the earlier markers are gone - this is the file's
	// content, not an accumulation of appends.
	await expect(editor).not.toContainText('EXTERNAL-ONE');
	await expect(editor).toContainText('EXTERNAL-THREE');
	// No banner: a clean buffer syncs silently, which is the whole point.
	await expect(page.locator('[data-testid="file-disk-changed"]:visible')).toHaveCount(0);
	await expect(page.locator('[data-testid="file-save"]:visible')).toBeVisible();
});

test('a burst of external writes coalesces, and the final content wins', async ({ page }) => {
	await openFile(page, 'editor.md');
	const editor = page.locator('.cm-content:visible');
	await expect(editor).toBeVisible();

	const abs = join(workspace, 'editor.md');
	for (let i = 1; i <= 8; i++) agentWrite(abs, `# Editor doc\n\nburst-${i}\n`);

	await expect(editor).toContainText('burst-8');
	// Debounce means the intermediate states were never delivered, so the editor
	// never flashed through them - what is on screen is what is on disk.
	expect(readFileSync(abs, 'utf8')).toContain('burst-8');
	await expect(editor).not.toContainText('burst-7');
});

test('the RENDERED preview updates too, not only the editor', async ({ page }) => {
	await openFile(page, 'preview.md');
	// Markdown opens in Source; switch to the rendered view and stay there.
	await page.locator('[data-testid="file-view-preview"]:visible').click();
	const rendered = page.locator('[data-testid="markdown-preview"]:visible');
	await expect(rendered).toContainText('original prose');

	agentWrite(join(workspace, 'preview.md'), '# Preview doc\n\n## Rewritten by an agent\n\nnew prose\n');

	// `liveSource` is sampled on entering a preview, never mirrored per keystroke,
	// so a sync that only touched the hidden editor would leave this stale.
	await expect(rendered).toContainText('new prose');
	await expect(rendered.locator('h2')).toHaveText('Rewritten by an agent');
	await expect(rendered).not.toContainText('original prose');
});

test('an external change never clobbers unsaved local edits', async ({ page }) => {
	await openFile(page, 'conflict.md');
	const editor = page.locator('.cm-content:visible');
	await expect(editor).toContainText('line one');

	// Make the buffer dirty.
	await editor.click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.press('ArrowRight');
	await page.keyboard.type('\nMY-LOCAL-EDIT');
	await expect(editor).toContainText('MY-LOCAL-EDIT');

	const abs = join(workspace, 'conflict.md');
	agentWrite(abs, '# Conflict doc\n\nAGENT-REWROTE-THIS\n');

	// The banner appears and the buffer is UNTOUCHED - no silent overwrite.
	const banner = page.locator('[data-testid="file-disk-changed"]:visible');
	await expect(banner).toBeVisible();
	await expect(banner).toHaveAttribute('data-disk-state', 'changed');
	await expect(editor).toContainText('MY-LOCAL-EDIT');
	await expect(editor).not.toContainText('AGENT-REWROTE-THIS');

	// "Keep mine" dismisses without touching either side…
	await page.locator('[data-testid="file-disk-dismiss"]:visible').click();
	await expect(page.locator('[data-testid="file-disk-changed"]:visible')).toHaveCount(0);
	await expect(editor).toContainText('MY-LOCAL-EDIT');
	expect(readFileSync(abs, 'utf8')).toContain('AGENT-REWROTE-THIS');

	// …and the local version is still saveable afterwards.
	await page.locator('[data-testid="file-save"]:visible').click();
	await expect(async () => {
		expect(readFileSync(abs, 'utf8')).toContain('MY-LOCAL-EDIT');
	}).toPass();

	// Now the other branch: dirty again, external change, and Reload takes disk.
	await editor.click();
	await page.keyboard.type('SECOND-LOCAL-EDIT');
	agentWrite(abs, '# Conflict doc\n\nDISK-VERSION-WINS\n');
	await expect(page.locator('[data-testid="file-disk-changed"]:visible')).toBeVisible();
	await page.locator('[data-testid="file-disk-reload"]:visible').click();

	await expect(editor).toContainText('DISK-VERSION-WINS');
	await expect(editor).not.toContainText('SECOND-LOCAL-EDIT');
	// Reloading resolves the conflict: banner gone, buffer clean (no dirty dot).
	await expect(page.locator('[data-testid="file-disk-changed"]:visible')).toHaveCount(0);
});

test("Cellar's own save does not bounce back as a phantom external change", async ({ page }) => {
	await openFile(page, 'echo.md');
	const editor = page.locator('.cm-content:visible');
	await expect(editor).toContainText('saved by cellar');

	await editor.click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.press('ArrowRight');
	await page.keyboard.type('\nWRITTEN-FROM-CELLAR');
	await page.locator('[data-testid="file-save"]:visible').click();

	const abs = join(workspace, 'echo.md');
	await expect(async () => {
		expect(readFileSync(abs, 'utf8')).toContain('WRITTEN-FROM-CELLAR');
	}).toPass();

	// The write produced real watcher events; the content hash is what stops them
	// reaching the tab that caused them. Wait past the settle window before
	// concluding nothing arrived.
	await page.waitForTimeout(1200);
	await expect(page.locator('[data-testid="file-disk-changed"]:visible')).toHaveCount(0);
	await expect(editor).toContainText('WRITTEN-FROM-CELLAR');

	// A touch that changes nothing is likewise silent (the hash gate, not the
	// event, is what decides).
	agentWrite(abs, readFileSync(abs, 'utf8'));
	await page.waitForTimeout(1200);
	await expect(page.locator('[data-testid="file-disk-changed"]:visible')).toHaveCount(0);
});

test('a silent sync keeps the caret and the scroll position where they were', async ({ page }) => {
	// The reason the sync is expressed as a MINIMAL edit rather than a whole-document
	// replace: a replace throws the caret to the end and scrolls the view, which
	// would make the sync more disruptive than the staleness it fixes.
	await openFile(page, 'long.md');
	const editor = page.locator('.cm-content:visible');
	const scroller = page.locator('.cm-scroller:visible');
	await expect(editor).toContainText('line 000');

	// Park the caret at the end of line 061, well down the document. Walking it
	// there with the keyboard is what makes the editor scroll to follow, so the
	// scroll position under test is one CodeMirror chose, not one forced on it.
	await editor.click();
	await page.keyboard.press('ControlOrMeta+Home');
	for (let i = 0; i < 60; i++) await page.keyboard.press('ArrowDown');
	await page.keyboard.press('End');
	const scrollBefore = await scroller.evaluate((el) => el.scrollTop);
	expect(scrollBefore).toBeGreaterThan(0);

	// Rewrite ONE line ABOVE the caret, leaving the line count alone. It has to be
	// a line CodeMirror is currently rendering: the editor windows its document,
	// so a marker written near the top of a 400-line file would be absent from the
	// DOM whether or not the sync worked, and the assertion would prove nothing.
	const rewritten = LONG_LINES.slice();
	rewritten[30] = 'line 030 REWRITTEN-BY-AGENT';
	agentWrite(join(workspace, 'long.md'), rewritten.join('\n') + '\n');
	await expect(editor).toContainText('REWRITTEN-BY-AGENT');

	// The view did not jump. A re-measure may nudge it by a pixel; a whole-document
	// replace moves it by hundreds.
	expect(await scroller.evaluate((el) => el.scrollTop)).toBeCloseTo(scrollBefore, -1);
	// …and the caret is still where it was: typing lands at the end of line 061,
	// which a whole-document replace would have moved to the end of the file.
	await page.keyboard.type('-CARET-KEPT');
	await page.locator('[data-testid="file-save"]:visible').click();
	await expect(async () => {
		expect(readFileSync(join(workspace, 'long.md'), 'utf8')).toContain('line 060-CARET-KEPT');
	}).toPass();
	// The agent's rewrite survived the save - the tab saved the SYNCED document,
	// not the snapshot it opened with (which is the silent-clobber this closes).
	expect(readFileSync(join(workspace, 'long.md'), 'utf8')).toContain('REWRITTEN-BY-AGENT');
});

test('a file deleted on disk says so and keeps the buffer', async ({ page }) => {
	await openFile(page, 'delete.md');
	const editor = page.locator('.cm-content:visible');
	await expect(editor).toContainText('about to vanish');

	unlinkSync(join(workspace, 'delete.md'));

	const banner = page.locator('[data-testid="file-disk-changed"]:visible');
	await expect(banner).toBeVisible();
	await expect(banner).toHaveAttribute('data-disk-state', 'deleted');
	// There is nothing to reload, and the editor must never be cleared - that
	// would destroy work in response to something the user did not do here.
	await expect(page.locator('[data-testid="file-disk-reload"]:visible')).toHaveCount(0);
	await expect(editor).toContainText('about to vanish');

	// Saving recreates the file from the still-open buffer.
	await page.locator('[data-testid="file-save"]:visible').click();
	await expect(async () => {
		expect(readFileSync(join(workspace, 'delete.md'), 'utf8')).toContain('about to vanish');
	}).toPass();
});
