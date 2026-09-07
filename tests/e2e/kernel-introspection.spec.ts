import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar, openSidebarSection } from './harness';

/**
 * Live-kernel editor introspection, end to end: a REAL browser, a REAL editor and
 * a REAL python kernel.
 *
 * Both features are keyboard-and-tooltip behaviour, so this is the only level that
 * can prove them at all - a unit test can drive the completion source but not the
 * Tab key, the merged option list, or a tooltip that is actually on screen.
 *
 * The load-bearing case is the one a FILE-ONLY completer cannot possibly answer:
 * a name that exists ONLY because a cell ran. The notebook is deliberately
 * arranged so that name is nowhere in the document by the time it is completed -
 * the defining cell's source is replaced with `pass` after it runs - so a passing
 * assertion can only mean the kernel answered. Attribute completion on a live
 * object is the second such case: `@codemirror/lang-python`'s own sources bail
 * outright after a dot (`PropertyName` is in their `dontComplete` list), so they
 * cannot offer it however the notebook is arranged.
 *
 * ONE ORDERING DEPENDENCY, and only one: the no-kernel case must run FIRST,
 * because kernels are lazy and the first RUN in this file is what starts one.
 * Every other test SEEDS the namespace it needs (`seedLiveNames`) rather than
 * leaning on the test above it - these share a launcher and a notebook, so an
 * implicit dependency is invisible until something above fails, and then every
 * test below fails for a reason unrelated to what it asserts.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

/** Defined by RUNNING, then erased from the document - see the header. */
const DEFINE_SRC = [
	'cellar_live_marker_xyz = 42\n',
	'class Thing:\n',
	'    attr_one_live = 1\n',
	'    def hello_live(self, alpha, beta=2):\n',
	'        """Greet politely."""\n',
	'        return alpha\n',
	't_live = Thing()\n'
].join('');

function notebookJson(): string {
	return JSON.stringify({
		nbformat: 4,
		nbformat_minor: 5,
		metadata: { kernelspec: { name: 'python3', display_name: 'python3' } },
		cells: [
			{
				cell_type: 'code',
				id: 'introspect-define-0000',
				metadata: {},
				execution_count: null,
				source: [DEFINE_SRC],
				outputs: []
			},
			{ cell_type: 'code', id: 'introspect-scratch-000', metadata: {}, execution_count: null, source: [''], outputs: [] },
			// A MARKDOWN cell, for the Tab-must-not-be-swallowed case. Appended rather
			// than converted from cell 0 or 1: every other test addresses those two by
			// index, so a conversion left behind by a failure would silently retarget
			// them. Empty on purpose - a markdown cell with no source opens in its edit
			// view, so `focusCell` reaches its editor without a rendered-view dance.
			{ cell_type: 'markdown', id: 'introspect-markdown-00', metadata: {}, source: [''] }
		]
	});
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-introspect-e2e-'));
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
			rmSync(workspace, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
});

/** Open the notebook, robust to whether a prior test already left a tab open. */
async function openNotebook(page: Page): Promise<void> {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	const openBtn = page.getByTestId('empty-open-notebook');
	const firstCell = page.getByTestId('cell').first();
	// SETTLE before probing: the shell paints either the empty state or an
	// already-open notebook, and reading too early turns the click into a no-op.
	await expect(openBtn.or(firstCell).first()).toBeVisible();
	if (await openBtn.isVisible()) await openBtn.click();
	await expect(firstCell).toBeVisible();
}

/** Put the caret in cell `i`'s editor, building it if this is its first use. */
async function focusCell(page: Page, i: number) {
	const cell = page.getByTestId('cell').nth(i);
	await cell.getByTestId('editor-scroll').click();
	await expect(cell.locator('.cm-content')).toBeVisible();
	return cell;
}

/** Replace cell `i`'s whole source with `text`. */
async function typeInto(page: Page, i: number, text: string) {
	const cell = await focusCell(page, i);
	await cell.locator('.cm-content').click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.type(text);
	return cell;
}

/**
 * Labels offered in CELL `i`'s completion popup.
 *
 * Scoped to the cell, never page-wide: CodeMirror puts a tooltip inside the
 * editor's own subtree, and several cells' editors are mounted at once, so a
 * page-wide locator can answer about a popup left open in a cell nobody is typing
 * in - which reads as a passing assertion for the wrong editor.
 */
function completionLabels(page: Page, i: number) {
	return page.getByTestId('cell').nth(i).locator('.cm-tooltip-autocomplete li');
}

/**
 * Close the completion popup CodeMirror opens on its own in cell `i`.
 *
 * `activateOnTyping` is on by default, so typing an identifier already runs every
 * source - including ours - and shows the result. That is the ordinary way a user
 * meets these completions, and it is asserted below on its own; closing it first is
 * what lets the NEXT press be a test of the Tab BINDING rather than of Tab
 * accepting what typing had already offered.
 */
async function closePopup(page: Page, i: number) {
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('cell').nth(i).locator('.cm-tooltip-autocomplete')).toHaveCount(0);
}

const docTooltip = (page: Page) => page.getByTestId('kernel-doc-tooltip');

/** How many kernels the server reports live right now. */
function liveKernelCount(page: Page): Promise<number> {
	return page.evaluate(async () => {
		const res = await fetch('/api/kernel');
		const body = (await res.json()) as { kernels?: unknown[] };
		return body.kernels?.length ?? 0;
	});
}

/**
 * Put the marker names in the kernel, by RUNNING the definitions through the
 * product's own run route.
 *
 * Every test that needs a live namespace seeds it for itself rather than leaning on
 * the one that ran the cell earlier in the file. These tests share a launcher and a
 * notebook, so an ordering dependency is invisible until a test above them fails -
 * and then every test below fails for a reason that has nothing to do with what it
 * asserts, which is exactly the flake shape AGENTS.md names for the upload-affix
 * specs. The stream is drained, so this resolves only once the run has finished.
 */
async function seedLiveNames(page: Page): Promise<void> {
	const failure = await page.evaluate(async (src) => {
		const res = await fetch('/api/cells/introspect-define-0000/run', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ source: src, nb: 'notebook.ipynb' })
		});
		const text = await res.text();
		return res.ok ? null : `${res.status} ${text.slice(0, 200)}`;
	}, DEFINE_SRC);
	expect(failure, 'seeding the kernel namespace').toBeNull();
}

test('with NO kernel, completion still works exactly as it did before', async ({ page }) => {
	// FIRST test in the file on purpose: kernels are lazy, so nothing has started
	// one yet. This is the "existing behaviour is untouched" guarantee - the kernel
	// source refuses `no_kernel` and CodeMirror's own file-local + builtin sources
	// answer alone.
	await openNotebook(page);
	await typeInto(page, 1, 'pri');
	await closePopup(page, 1);
	await page.keyboard.press('Tab');
	await expect(completionLabels(page, 1).filter({ hasText: 'print' }).first()).toBeVisible();
	await closePopup(page, 1);
});

test('Tab completes a name that exists ONLY in the live kernel', async ({ page }) => {
	await openNotebook(page);

	// Run the defining cell, then ERASE it: after this the marker name is nowhere in
	// the document, so nothing but the kernel can know it.
	const define = page.getByTestId('cell').nth(0);
	await define.getByTestId('run').click();
	await expect(define.getByTestId('run-meta')).toContainText('ran', { timeout: 90_000 });
	await typeInto(page, 0, 'pass');
	await expect(page.getByTestId('cell').nth(0).locator('.cm-content')).not.toContainText('cellar_live_marker_xyz');

	await typeInto(page, 1, 'cellar_live_mark');
	// Typing alone offers it - the ordinary way a user meets this.
	await expect(completionLabels(page, 1).filter({ hasText: 'cellar_live_marker_xyz' }).first()).toBeVisible({
		timeout: 20_000
	});

	// And Tab OPENS it after a dismissal, which is what tests the binding itself
	// rather than CodeMirror's activate-on-typing.
	await closePopup(page, 1);
	await page.keyboard.press('Tab');
	await expect(completionLabels(page, 1).filter({ hasText: 'cellar_live_marker_xyz' }).first()).toBeVisible({
		timeout: 20_000
	});

	// A second Tab ACCEPTS the selected suggestion - Jupyter's feel, and what makes
	// Tab-Tab a complete gesture rather than only a lookup. CodeMirror ignores an
	// accept within `interactionDelay` (75ms) of the popup opening, deliberately, so
	// this waits that out rather than racing a guard that exists to stop mis-clicks.
	await page.waitForTimeout(200);
	await page.keyboard.press('Tab');
	await expect(page.getByTestId('cell').nth(1).locator('.cm-content')).toContainText('cellar_live_marker_xyz');
});

test('Tab completes attributes on a LIVE object - which a file-only completer cannot do at all', async ({ page }) => {
	await openNotebook(page);
	await seedLiveNames(page);
	await typeInto(page, 1, 't_live.');
	// `@codemirror/lang-python` bails after a dot, so every one of these can only
	// have come from the kernel introspecting the real instance.
	await expect(completionLabels(page, 1).filter({ hasText: 'attr_one_live' }).first()).toBeVisible({ timeout: 20_000 });
	await expect(completionLabels(page, 1).filter({ hasText: 'hello_live' }).first()).toBeVisible();
	await closePopup(page, 1);
	// Tab brings the same live-object attributes back.
	await page.keyboard.press('Tab');
	await expect(completionLabels(page, 1).filter({ hasText: 'attr_one_live' }).first()).toBeVisible({ timeout: 20_000 });
	await closePopup(page, 1);
});

test('a builtin both sources know is offered ONCE - the merged list dedupes', async ({ page }) => {
	await openNotebook(page);
	await seedLiveNames(page);
	// With a live kernel `print` comes from BOTH the kernel and
	// `@codemirror/lang-python`'s builtin list, which is exactly the case the option
	// shape is built for: CodeMirror drops a duplicate only when label, `detail`,
	// `apply`, `boost` AND `type` all agree, so a `detail: 'kernel'` or a `boost` to
	// rank kernel matches first would show it twice. The no-kernel test above cannot
	// make this assertion - there is only one source there for it to pass vacuously.
	await typeInto(page, 1, 'pri');
	await expect(completionLabels(page, 1).filter({ hasText: /^print$/ }).first()).toBeVisible({ timeout: 20_000 });
	await expect(completionLabels(page, 1).filter({ hasText: /^print$/ })).toHaveCount(1);
	await closePopup(page, 1);
});

test('Shift+Tab inside a call shows the kernel’s docs, expands, and dismisses', async ({ page }) => {
	await openNotebook(page);
	await seedLiveNames(page);
	// The caret sits INSIDE the argument list, not on the name: IPython's own
	// `token_at_cursor` is what resolves the callable from there. (CodeMirror's
	// `closeBrackets` auto-inserts the `)`, so the caret really is between the
	// arguments and the closing paren - exactly the everyday shape.)
	await typeInto(page, 1, 't_live.hello_live(1, ');

	await page.keyboard.press('Shift+Tab');
	await expect(docTooltip(page)).toBeVisible({ timeout: 20_000 });
	const tip = docTooltip(page);
	await expect(tip).toContainText('hello_live(alpha, beta=2)', { timeout: 20_000 });
	await expect(tip).toContainText('Greet politely.');
	// No ANSI escapes reach the browser - IPython colours these section headers.
	await expect(tip).not.toContainText('[');
	// Level 0 has more to offer, and says so.
	await expect(page.getByTestId('kernel-doc-more')).toBeVisible();
	await expect(tip).not.toContainText('Source:');

	// Second press: the SAME reply one detail level higher, which is what adds the source.
	await page.keyboard.press('Shift+Tab');
	await expect(tip).toContainText('Source:', { timeout: 20_000 });
	await expect(tip).toContainText('def hello_live');
	await expect(page.getByTestId('kernel-doc-more')).toHaveCount(0);

	// Escape dismisses it - and only then leaves for command mode, exactly as it
	// does for the completion popup.
	await page.keyboard.press('Escape');
	await expect(tip).toHaveCount(0);
	await expect(page.getByTestId('cell').nth(1)).toHaveAttribute('data-active', /.*/);
});

test('the tooltip closes on a caret move and on an edit, like the editor’s other overlays', async ({ page }) => {
	await openNotebook(page);
	await seedLiveNames(page);
	await typeInto(page, 1, 't_live.hello_live(1, ');
	await page.keyboard.press('Shift+Tab');
	await expect(docTooltip(page)).toBeVisible({ timeout: 20_000 });
	await page.keyboard.press('ArrowLeft');
	await expect(docTooltip(page)).toHaveCount(0);

	await page.keyboard.press('Shift+Tab');
	await expect(docTooltip(page)).toBeVisible({ timeout: 20_000 });
	await page.keyboard.type('2');
	await expect(docTooltip(page)).toHaveCount(0);
});

test('Tab with nothing to complete still leaves the editor - the keyboard way out', async ({ page }) => {
	await openNotebook(page);
	// Binding Tab must not trap a keyboard user in the editor. Where completion does
	// not apply the action reports NOT HANDLED, so the keystroke keeps its default.
	await typeInto(page, 1, '   ');
	await expect(page.evaluate(() => document.activeElement?.className ?? '')).resolves.toContain('cm-content');
	await page.keyboard.press('Tab');
	await expect
		.poll(() => page.evaluate(() => document.activeElement?.className ?? ''))
		.not.toContain('cm-content');
});

test('Tab is not swallowed in a cell the kernel cannot answer about', async ({ page }) => {
	await openNotebook(page);
	// A LIVE kernel throughout, so this is the scoping rule and not merely "there is
	// nothing to complete": the same key, in the same notebook, at the same moment,
	// completes in the Python cell below and declines in the markdown one.
	await seedLiveNames(page);

	// Markdown: `basicSetup` installs `autocompletion()` for EVERY cell, so a Tab
	// that reported handled here would be swallowed for nothing - markdown brings no
	// completion source at all - and would take with it the keyboard user's only way
	// out of the editor.
	await typeInto(page, 2, 'cellar_live_mark');
	await expect(page.evaluate(() => document.activeElement?.className ?? '')).resolves.toContain('cm-content');
	await page.keyboard.press('Tab');
	await expect
		.poll(() => page.evaluate(() => document.activeElement?.className ?? ''))
		.not.toContain('cm-content');
	// And no Python names were offered for prose on the way out.
	await expect(page.getByTestId('cell').nth(2).locator('.cm-tooltip-autocomplete')).toHaveCount(0);

	// The control: the identical text in a PYTHON code cell still completes from the
	// live kernel, so the decline above is the cell type and not a dead binding.
	await typeInto(page, 1, 'cellar_live_mark');
	await closePopup(page, 1);
	await page.keyboard.press('Tab');
	await expect(completionLabels(page, 1).filter({ hasText: 'cellar_live_marker_xyz' }).first()).toBeVisible({
		timeout: 20_000
	});
	await closePopup(page, 1);
});

test('neither feature blocks or breaks while a cell is running', async ({ page }) => {
	await openNotebook(page);
	await seedLiveNames(page);
	// A long cell in the SAME notebook, so it holds this notebook's one kernel.
	await typeInto(page, 0, 'import time; time.sleep(12); slept_marker = 1');
	await page.getByTestId('cell').nth(0).getByTestId('run').click();
	await expect(page.getByTestId('cell').nth(0).getByTestId('running-bar')).toBeVisible({ timeout: 30_000 });

	// Shift+Tab answers PROMPTLY and honestly: it says the kernel was not asked
	// rather than queueing behind the cell for its whole life (an execute-probe
	// design would also have parked the next RUN behind it).
	await typeInto(page, 1, 't_live.hello_live(1, ');
	await page.keyboard.press('Shift+Tab');
	const tip = docTooltip(page);
	await expect(tip).toBeVisible({ timeout: 5_000 });
	await expect(tip).toContainText('busy');

	// Completion falls back silently to the file-local sources; nothing hangs.
	await page.keyboard.press('Escape');
	await typeInto(page, 1, 'pri');
	await expect(completionLabels(page, 1).filter({ hasText: /^print$/ }).first()).toBeVisible({ timeout: 10_000 });
	await closePopup(page, 1);

	// The run was never disturbed by any of it, and the kernel answers again after.
	await expect(page.getByTestId('cell').nth(0).getByTestId('run-meta')).toContainText('ran', { timeout: 60_000 });
	await typeInto(page, 1, 'slept_mark');
	await expect(completionLabels(page, 1).filter({ hasText: 'slept_marker' }).first()).toBeVisible({ timeout: 20_000 });
	await closePopup(page, 1);
});

test('a kernel that is gone is reported, not wedged - and the editor keeps working', async ({ page }) => {
	await openNotebook(page);
	// Deliberately NOT self-seeding: this test needs a kernel to exist so it can take
	// it away, and `seedLiveNames` would leave it running.
	await expect.poll(() => liveKernelCount(page), { timeout: 60_000 }).toBeGreaterThan(0);
	await openSidebarSection(page, 'kernels', 'kernels-body');
	await page.getByTestId('kernel-shutdown').first().click();
	// Wait for the shutdown to LAND, read from the server rather than from the card:
	// the sidebar is a view of `kernel:status`, so asserting on it would be asserting
	// on the thing under test's own plumbing.
	await expect.poll(() => liveKernelCount(page), { timeout: 60_000 }).toBe(0);

	await typeInto(page, 1, 't_live.hello_live(1, ');
	await page.keyboard.press('Shift+Tab');
	const tip = docTooltip(page);
	await expect(tip).toBeVisible({ timeout: 20_000 });
	// It says a kernel has to be started, and NEVER starts one itself: a keystroke
	// must not boot a Python process.
	await expect(tip).toContainText('run a cell to start one');
	await page.keyboard.press('Escape');

	// Completion still works from the file-local sources with the kernel gone.
	await typeInto(page, 1, 'pri');
	await expect(completionLabels(page, 1).filter({ hasText: /^print$/ }).first()).toBeVisible({ timeout: 10_000 });
	await closePopup(page, 1);
});

test('both shortcuts are listed in Settings, so they can be rebound like any other', async ({ page }) => {
	await openNotebook(page);
	await page.getByTestId('app-menu').click();
	await page.getByTestId('open-settings').click();
	const modal = page.getByTestId('settings-modal');
	await expect(modal).toBeVisible();
	await expect(modal).toContainText('Complete at the cursor');
	await expect(modal).toContainText('Show documentation for the object at the cursor');
});
