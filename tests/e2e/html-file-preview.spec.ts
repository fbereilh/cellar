import { test, expect } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * Opening an `.html` file: a SANDBOXED rendered preview by default, with a
 * Preview/Source toggle.
 *
 * The security half is the point of this spec. The previewed file is untrusted
 * workspace content, so the fixture below carries a probe that tries to reach
 * the app (`parent.document`, `localStorage`) and writes the verdict into its own
 * body — the test then reads that verdict out of the frame. A regression that
 * added `allow-same-origin` would render identically and be invisible to any
 * assertion about how the page LOOKS; it flips this probe.
 *
 * Boots the real launcher like the other specs, so it skips without the runtime.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

// A self-contained page (no external refs): a script paints the "plot", so a
// frame that shows the marker proves scripts run inside the sandbox.
const REPORT_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Quarterly report</title>
<style>body { font-family: system-ui, sans-serif; } #plot { color: #0b7285; }</style></head>
<body>
<h1>Quarterly report</h1>
<div id="plot">pending</div>
<div id="parent-probe">unset</div>
<div id="storage-probe">unset</div>
<script>
  document.getElementById('plot').textContent = 'RENDERED-BY-SCRIPT';
  try {
    document.getElementById('parent-probe').textContent = 'LEAKED:' + String(parent.document.title);
  } catch (e) {
    document.getElementById('parent-probe').textContent = 'PARENT-BLOCKED';
  }
  try {
    window.localStorage.getItem('cellar-theme');
    document.getElementById('storage-probe').textContent = 'STORAGE-REACHABLE';
  } catch (e) {
    document.getElementById('storage-probe').textContent = 'STORAGE-BLOCKED';
  }
<\/script>
</body>
</html>
`;

const PLAIN_PY = 'value = 1\nprint(value)\n';

// Saved from a rendered PREVIEW, so they get their own fixtures: the other
// specs edit `report.html`, and this one asserts on exact file contents.
const SAVE_FROM_PREVIEW_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Toggle report</title></head>
<body><h1>Toggle report</h1></body></html>
`;
const SAVE_FROM_PREVIEW_MD = '# Notes\n\nsome prose\n';

// Past adapter-node's 512 K request-body ceiling, which is app-wide and
// deliberately not raised: this one still OPENS and PREVIEWS (a read is a GET
// response, not a request body) but must not offer an edit its PUT would 413 on.
const BIG_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Big report</title></head>
<body><h1>Big report</h1><div id="pad">${'x'.repeat(700 * 1024)}</div></body></html>
`;

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-html-'));
	writeFileSync(join(workspace, 'report.html'), REPORT_HTML);
	writeFileSync(join(workspace, 'big.html'), BIG_HTML);
	writeFileSync(join(workspace, 'script.py'), PLAIN_PY);
	writeFileSync(join(workspace, 'toggle.html'), SAVE_FROM_PREVIEW_HTML);
	writeFileSync(join(workspace, 'notes.md'), SAVE_FROM_PREVIEW_MD);
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

/**
 * Records whether the app called `preventDefault()` on the next Cmd/Ctrl+S -
 * which is what keeps the browser's own "Save page as…" dialog from opening.
 * The shell's handler is a window CAPTURE listener that `stopPropagation()`s;
 * that stops other TARGETS, not other listeners on window itself, so this one
 * still runs (registered later ⇒ it runs after) and sees the verdict.
 */
async function watchSaveKey(page: import('@playwright/test').Page) {
	await page.evaluate(() => {
		const w = window as unknown as { __saveKeyPrevented?: boolean | null };
		w.__saveKeyPrevented = null;
		window.addEventListener(
			'keydown',
			(e) => {
				if (e.key.toLowerCase() === 's' && (e.metaKey || e.ctrlKey)) {
					w.__saveKeyPrevented = e.defaultPrevented;
				}
			},
			true
		);
	});
}
function saveKeyWasHandled(page: import('@playwright/test').Page) {
	return page.evaluate(
		() => (window as unknown as { __saveKeyPrevented?: boolean | null }).__saveKeyPrevented
	);
}

test('an .html file opens as a sandboxed preview, toggles to an editable source view, and leaves other files alone', async ({
	page
}) => {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);

	// ---- Preview is the default view ---------------------------------------
	await page.locator('[data-testid="tree-file"][data-path="report.html"]').click();

	const iframe = page.getByTestId('html-preview');
	await expect(iframe).toBeVisible();
	// The toggle reflects it, and the editor is not the visible surface.
	await expect(page.getByTestId('file-view-preview')).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByTestId('file-view-source')).toHaveAttribute('aria-pressed', 'false');

	// The page rendered, and its scripts ran (the marker is painted by JS).
	const frame = page.frameLocator('[data-testid="html-preview"]');
	await expect(frame.locator('h1')).toHaveText('Quarterly report');
	await expect(frame.locator('#plot')).toHaveText('RENDERED-BY-SCRIPT');

	// ---- …and it is sandboxed away from the app -----------------------------
	// The attribute states the intent: scripts yes, downloads yes (an export's own
	// "save as PNG" affordance, which grants no origin access), app origin no.
	await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts allow-popups allow-downloads');
	const sandbox = (await iframe.getAttribute('sandbox')) ?? '';
	expect(sandbox).not.toContain('allow-same-origin');
	// The frame's own verdict: it could reach neither the app's DOM nor its storage.
	await expect(frame.locator('#parent-probe')).toHaveText('PARENT-BLOCKED');
	await expect(frame.locator('#storage-probe')).toHaveText('STORAGE-BLOCKED');

	// ---- Source mode: raw HTML, highlighted, editable, saveable -------------
	await page.getByTestId('file-view-source').click();
	await expect(page.getByTestId('html-preview')).toHaveCount(0);

	const editor = page.locator('.cm-content');
	await expect(editor).toBeVisible();
	await expect(editor).toContainText('<h1>Quarterly report</h1>');
	// Syntax highlighting: an HTML-aware editor emits token spans inside the
	// lines; a plain-text editor emits none.
	await expect(page.locator('.cm-line span').first()).toBeVisible();

	// Append a marker at the end of the document and save it to disk. Plain text,
	// deliberately: `html()` auto-closes typed tags, so typing markup through the
	// keyboard would test CodeMirror's auto-close, not the save path.
	await editor.click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.press('ArrowRight'); // collapse the selection to the doc end
	await page.keyboard.type('\nEDITED-IN-SOURCE-MODE');
	await page.getByTestId('file-save').click();

	const onDisk = join(workspace, 'report.html');
	await expect(async () => {
		expect(readFileSync(onDisk, 'utf8')).toContain('EDITED-IN-SOURCE-MODE');
	}).toPass();
	// The original markup survived the round trip — this was an edit, not a rewrite.
	expect(readFileSync(onDisk, 'utf8')).toContain('<h1>Quarterly report</h1>');

	// ---- Toggling back re-renders from the current content ------------------
	await page.getByTestId('file-view-preview').click();
	const frame2 = page.frameLocator('[data-testid="html-preview"]');
	await expect(frame2.locator('body')).toContainText('EDITED-IN-SOURCE-MODE');
	await expect(frame2.locator('#plot')).toHaveText('RENDERED-BY-SCRIPT');

	// ---- A refused save is VISIBLE, and does not become a load error ---------
	// The real trigger is an oversize body, which the server front-end rejects
	// with 413 before the route runs; a 15 MB fixture would cost far more than it
	// proves, so the response is what is faked here, not the mechanism.
	await page.getByTestId('file-view-source').click();
	await page.route('**/api/fs/file', async (route) => {
		if (route.request().method() !== 'PUT') return route.fallback();
		await route.fulfill({ status: 413, contentType: 'text/plain', body: 'Payload Too Large' });
	});
	await editor.click();
	await page.keyboard.type('x');
	await page.getByTestId('file-save').click();

	await expect(page.getByTestId('file-save-error')).toHaveText('file too large to save');
	// The document is still open and editable — a failed save is not a failed load.
	await expect(page.getByTestId('file-error')).toHaveCount(0);
	await expect(editor).toBeVisible();
	// …and it stops asserting itself the moment the document it described changes.
	await editor.click();
	await page.keyboard.type('y');
	await expect(page.getByTestId('file-save-error')).toHaveCount(0);
	await page.unroute('**/api/fs/file');

	// ---- Regression: a non-HTML file is untouched ---------------------------
	// The edited `report.html` tab was promoted to permanent, so it stays mounted
	// (hidden) behind the new tab — scope these to what is actually on screen.
	await page.locator('[data-testid="tree-file"][data-path="script.py"]').click();
	await expect(page.locator('[data-testid="file-view-preview"]:visible')).toHaveCount(0);
	await expect(page.locator('[data-testid="file-view-source"]:visible')).toHaveCount(0);
	await expect(page.locator('[data-testid="html-preview"]:visible')).toHaveCount(0);
	await expect(page.locator('.cm-content').filter({ hasText: 'value = 1' })).toBeVisible();
});

/**
 * A file too big for a save request body still opens and previews - reading is a
 * GET response, and the app-wide `BODY_SIZE_LIMIT` only governs requests - but it
 * opens VIEW-ONLY, so the tab never offers an edit whose PUT the server front-end
 * would reject before any handler ran.
 */
test('an HTML file past the save-transport limit previews but opens read-only', async ({ page }) => {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);

	await page.locator('[data-testid="tree-file"][data-path="big.html"]').click();

	// Tabs are session memory, so a previous test's file may still be mounted
	// (hidden) behind this one — scope to what is actually on screen.
	const preview = page.locator('[data-testid="html-preview"]:visible');
	// Reading is untouched: the preview renders as it would for any export.
	await expect(preview).toBeVisible();
	await expect(page.frameLocator('[data-testid="html-preview"]:visible').locator('h1')).toHaveText(
		'Big report'
	);

	// Cmd/Ctrl+S from the PREVIEW (this file's default view, where the editor is
	// `display:none` and can hold no keymap): still handled — the browser's save
	// dialog is suppressed — and it surfaces the reason instead of pretending.
	await watchSaveKey(page);
	const previewChip = page.locator('[data-testid="file-view-only"]:visible');
	await expect(previewChip).toHaveAttribute('data-flash', 'false');
	await page.keyboard.press('ControlOrMeta+s');
	await expect(previewChip).toHaveAttribute('data-flash', 'true');
	expect(await saveKeyWasHandled(page)).toBe(true);

	// Source mode: readable, but not editable, and it says why.
	await page.locator('[data-testid="file-view-source"]:visible').click();
	await expect(page.locator('[data-testid="file-view-only"]:visible')).toBeVisible();
	await expect(page.locator('[data-testid="file-save"]:visible')).toHaveCount(0);
	const editor = page.locator('.cm-content:visible');
	await expect(editor).toBeVisible();
	await expect(editor).toHaveAttribute('contenteditable', 'false');
	// …but it still takes keyboard focus. `contenteditable="false"` alone is not
	// focusable, and CodeMirror's key handlers live on this element - so without
	// the explicit tabindex the document is unselectable, unsearchable, and
	// Cmd/Ctrl+S falls through to the browser's own save dialog.
	await expect(editor).toHaveAttribute('tabindex', '0');

	// Typing changes nothing on screen and leaves the file alone.
	const before = readFileSync(join(workspace, 'big.html'), 'utf8');
	await editor.click();
	await expect(editor).toBeFocused();
	await page.keyboard.type('MUST-NOT-APPEAR');
	await expect(editor).not.toContainText('MUST-NOT-APPEAR');
	// Cmd/Ctrl+S is HANDLED (so no browser dialog) but says why nothing was saved,
	// by pulsing the chip that already carries the reason.
	const chip = page.locator('[data-testid="file-view-only"]:visible');
	await expect(chip).toHaveAttribute('data-flash', 'false');
	await page.keyboard.press('ControlOrMeta+s');
	await expect(chip).toHaveAttribute('data-flash', 'true');
	await expect(page.locator('[data-testid="file-save-error"]:visible')).toHaveCount(0);
	expect(readFileSync(join(workspace, 'big.html'), 'utf8')).toBe(before);

	// An ordinary-sized file in the same session keeps its Save button.
	await page.locator('[data-testid="tree-file"][data-path="report.html"]').click();
	await expect(page.locator('[data-testid="file-save"]:visible')).toHaveCount(1);
	await expect(page.locator('[data-testid="file-view-only"]:visible')).toHaveCount(0);
});

/**
 * The save shortcut belongs to the TAB, not to whichever surface happens to be
 * showing. Bound on the editor's keymap it could only fire while `.cm-content`
 * held focus - and a rendered preview hides the editor with `display:none`, a
 * subtree that can hold no focus at all - so Cmd/Ctrl+S in Preview reached the
 * browser's "Save page as…" dialog and the dirty document was never written.
 */
test('Cmd/Ctrl+S saves a file tab from the rendered preview, not just from Source', async ({
	page
}) => {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);

	// ---- HTML: edit in Source, toggle to Preview, save ----------------------
	await page.locator('[data-testid="tree-file"][data-path="toggle.html"]').click();
	await page.locator('[data-testid="file-view-source"]:visible').click();
	const editor = page.locator('.cm-content:visible');
	await editor.click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.press('ArrowRight');
	await page.keyboard.type('\nSAVED-FROM-PREVIEW');

	// Toggle to the rendered view while dirty — the work-loss path.
	await page.locator('[data-testid="file-view-preview"]:visible').click();
	await expect(page.locator('[data-testid="html-preview"]:visible')).toBeVisible();

	await watchSaveKey(page);
	await page.keyboard.press('ControlOrMeta+s');
	// The browser's own dialog is suppressed…
	expect(await saveKeyWasHandled(page)).toBe(true);
	// …because the tab really saved.
	const htmlOnDisk = join(workspace, 'toggle.html');
	await expect(async () => {
		expect(readFileSync(htmlOnDisk, 'utf8')).toContain('SAVED-FROM-PREVIEW');
	}).toPass();
	expect(readFileSync(htmlOnDisk, 'utf8')).toContain('<h1>Toggle report</h1>');

	// ---- Markdown has the same shape (it just defaults to Source) -----------
	await page.locator('[data-testid="tree-file"][data-path="notes.md"]').click();
	const mdEditor = page.locator('.cm-content:visible');
	await mdEditor.click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.press('ArrowRight');
	await page.keyboard.type('\nSAVED-FROM-MD-PREVIEW');
	await page.locator('[data-testid="file-view-preview"]:visible').click();

	await watchSaveKey(page);
	await page.keyboard.press('ControlOrMeta+s');
	expect(await saveKeyWasHandled(page)).toBe(true);
	const mdOnDisk = join(workspace, 'notes.md');
	await expect(async () => {
		expect(readFileSync(mdOnDisk, 'utf8')).toContain('SAVED-FROM-MD-PREVIEW');
	}).toPass();

	// ---- Source mode still saves exactly once (one owner, no double write) --
	await page.locator('[data-testid="file-view-source"]:visible').click();
	let puts = 0;
	await page.route('**/api/fs/file', async (route) => {
		if (route.request().method() === 'PUT') puts += 1;
		await route.fallback();
	});
	await mdEditor.click();
	await page.keyboard.type('\nONE-WRITE');
	await page.keyboard.press('ControlOrMeta+s');
	await expect(async () => {
		expect(readFileSync(mdOnDisk, 'utf8')).toContain('ONE-WRITE');
	}).toPass();
	await page.waitForTimeout(300);
	expect(puts).toBe(1);
	await page.unroute('**/api/fs/file');
});
