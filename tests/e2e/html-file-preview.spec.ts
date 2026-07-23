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

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-html-'));
	writeFileSync(join(workspace, 'report.html'), REPORT_HTML);
	writeFileSync(join(workspace, 'script.py'), PLAIN_PY);
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

	// ---- Regression: a non-HTML file is untouched ---------------------------
	// The edited `report.html` tab was promoted to permanent, so it stays mounted
	// (hidden) behind the new tab — scope these to what is actually on screen.
	await page.locator('[data-testid="tree-file"][data-path="script.py"]').click();
	await expect(page.locator('[data-testid="file-view-preview"]:visible')).toHaveCount(0);
	await expect(page.locator('[data-testid="file-view-source"]:visible')).toHaveCount(0);
	await expect(page.locator('[data-testid="html-preview"]:visible')).toHaveCount(0);
	await expect(page.locator('.cm-content').filter({ hasText: 'value = 1' })).toBeVisible();
});
