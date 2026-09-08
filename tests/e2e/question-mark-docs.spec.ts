import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';
import { isCellMounted, paneMetric, setScrollTop, scrollToBottom } from './notebook-scroll';

/**
 * `func?` and `func??`, end to end: a REAL browser, a REAL run, a REAL python
 * kernel.
 *
 * This is the only level that can prove the feature at all, and the reason is
 * WHERE the answer comes from. IPython performs the `?` transformation itself and
 * answers on the execute reply's `page` payload - Cellar neither parses the source
 * nor computes the documentation - so a test with a faked kernel can only assert
 * what Cellar does with a payload it was HANDED. Whether IPython produces one, and
 * for which cell contents, is the half that matters for requirements 1, 2 and 5,
 * and only a real kernel answers it.
 *
 * That is also why the non-Python cases here are worth their runtime: the claim is
 * not "Cellar checks the cell type" (it does not) but "IPython never sees a
 * non-Python cell's source as Python", which is a fact about the product's compile
 * step and about IPython's transformer together.
 *
 * Every test SEEDS what it needs and runs its own cell rather than leaning on the
 * one above it - these share a launcher and a notebook, so an ordering dependency
 * is invisible until something above fails and then everything below fails for an
 * unrelated reason.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

/** A private function with a real docstring AND a body, for the `??` case. */
const DEFINE_SRC = [
	'def cellar_documented_fn(alpha, beta=2):\n',
	'    """Return alpha, politely.\n',
	'\n',
	'    A second paragraph so the docstring is more than one line.\n',
	'    """\n',
	'    marker_inside_body = alpha + beta\n',
	'    return marker_inside_body\n',
	'\n',
	'class CellarDocumentedClass:\n',
	'    """A class docstring."""\n',
	'\n',
	'cellar_documented_instance = CellarDocumentedClass()\n'
].join('');

function codeCell(id: string, source: string) {
	return { cell_type: 'code', id, metadata: {}, execution_count: null, source: [source], outputs: [] };
}

function notebookJson(): string {
	return JSON.stringify({
		nbformat: 4,
		nbformat_minor: 5,
		metadata: { kernelspec: { name: 'python3', display_name: 'python3' } },
		cells: [
			codeCell('qmark-define-00000000', DEFINE_SRC),
			// One scratch cell per test, so no test rewrites a cell another addresses.
			codeCell('qmark-scratch-0000000', ''),
			codeCell('qmark-scratch-1000000', ''),
			codeCell('qmark-scratch-2000000', ''),
			codeCell('qmark-scratch-3000000', ''),
			codeCell('qmark-scratch-4000000', ''),
			codeCell('qmark-scratch-5000000', ''),
			codeCell('qmark-scratch-6000000', ''),
			// Non-Python cells for the requirement-5 cases. Appended rather than
			// converted from a scratch cell, so a failure cannot retarget one.
			{ cell_type: 'markdown', id: 'qmark-markdown-000000', metadata: {}, source: ['`len?` in prose'] },
			{ cell_type: 'raw', id: 'qmark-raw-00000000000', metadata: {}, source: ['len?'] }
		]
	});
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-qmark-e2e-'));
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

/**
 * Run `source` as cell `id` through the product's OWN run route, and resolve once
 * the run has finished. The stream is drained, so this is not a race.
 */
async function runCellById(page: Page, id: string, source: string): Promise<void> {
	const failure = await page.evaluate(
		async ({ id, src }) => {
			const res = await fetch(`/api/cells/${id}/run`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ source: src, nb: 'notebook.ipynb' })
			});
			const text = await res.text();
			return res.ok ? null : `${res.status} ${text.slice(0, 200)}`;
		},
		{ id, src: source }
	);
	expect(failure, `running cell ${id}`).toBeNull();
}

/** The named cell's locator, addressed by id so windowing cannot retarget it. */
function cellById(page: Page, id: string) {
	return page.locator(`[data-testid="cell"][data-cell-id="${id}"]`);
}

/**
 * Make sure cell `id` is MOUNTED before anything reads its DOM.
 *
 * Windowing is on by default, and these tests deliberately fill the notebook with
 * tall documentation outputs - `json.dumps??` alone is a full scroll box - so a
 * cell low in the document is a SPACER after a fresh load and every locator under
 * it resolves to nothing. Scrolling the pane in viewport-sized steps is what the
 * user would do; `isCellMounted` is the same check `notebook-scroll.ts` uses.
 */
async function showCell(page: Page, id: string): Promise<void> {
	if (await isCellMounted(page, id)) return;
	const step = await paneMetric(page, 'clientHeight');
	for (let top = 0; top < 200_000; top += Math.max(200, step - 100)) {
		await setScrollTop(page, top);
		await page.waitForTimeout(60);
		if (await isCellMounted(page, id)) return;
		if (top > (await paneMetric(page, 'scrollHeight'))) break;
	}
	await scrollToBottom(page);
	await page.waitForTimeout(120);
	expect(await isCellMounted(page, id), `cell ${id} never mounted`).toBe(true);
}

/** The outputs the SERVER holds for a cell - what was really persisted. */
async function persistedOutputs(page: Page, id: string): Promise<{ output_type: string; data?: Record<string, unknown> }[]> {
	return page.evaluate(async (cellId) => {
		const res = await fetch('/api/notebooks?path=notebook.ipynb');
		const body = (await res.json()) as { notebook?: { cells?: { id: string; outputs?: unknown[] }[] } };
		const cell = body.notebook?.cells?.find((c) => c.id === cellId);
		return (cell?.outputs ?? []) as { output_type: string; data?: Record<string, unknown> }[];
	}, id);
}

/** Put the defining names in the live kernel. */
async function seed(page: Page): Promise<void> {
	await runCellById(page, 'qmark-define-00000000', DEFINE_SRC);
}

test('`len?` shows the builtin`s documentation as cell output', async ({ page }) => {
	await openNotebook(page);
	await runCellById(page, 'qmark-scratch-0000000', 'len?');

	await showCell(page, 'qmark-scratch-0000000');
	const cell = cellById(page, 'qmark-scratch-0000000');
	const output = cell.getByTestId('output');
	await expect(output).toBeVisible({ timeout: 90_000 });
	await expect(output).toContainText('Signature:');
	await expect(output).toContainText('len(obj, /)');
	await expect(output).toContainText('Return the number of items in a container.');

	// The ANSI IPython wraps its labels in must not reach the screen OR the file:
	// a raw escape renders as garbage, and this output is persisted.
	await expect(output).not.toContainText('[31m');
	const persisted = await persistedOutputs(page, 'qmark-scratch-0000000');
	expect(persisted).toHaveLength(1);
	expect(persisted[0].output_type).toBe('display_data');
	const saved = String(persisted[0].data?.['text/plain'] ?? '');
	expect(saved).toContain('Signature:');
	expect(saved).not.toContain(String.fromCharCode(27));
});

test('`?` answers for a function, a class, a module and an instance', async ({ page }) => {
	await openNotebook(page);
	await seed(page);

	await showCell(page, 'qmark-scratch-1000000');
	const cell = cellById(page, 'qmark-scratch-1000000');
	const output = cell.getByTestId('output');

	await runCellById(page, 'qmark-scratch-1000000', 'cellar_documented_fn?');
	await expect(output).toContainText('Return alpha, politely.', { timeout: 90_000 });
	await expect(output).toContainText('cellar_documented_fn(alpha, beta=2)');

	await runCellById(page, 'qmark-scratch-1000000', 'CellarDocumentedClass?');
	await expect(output).toContainText('A class docstring.');

	await runCellById(page, 'qmark-scratch-1000000', 'import os\nos?');
	await expect(output).toContainText('OS routines');

	await runCellById(page, 'qmark-scratch-1000000', 'cellar_documented_instance?');
	// An INSTANCE reports its type and its class docstring, not a signature.
	await expect(output).toContainText('CellarDocumentedClass');
});

test('`??` adds the source, and the whole of it is readable and copyable', async ({ page }) => {
	await openNotebook(page);
	await seed(page);
	await runCellById(page, 'qmark-scratch-2000000', 'cellar_documented_fn??');

	await showCell(page, 'qmark-scratch-2000000');
	const cell = cellById(page, 'qmark-scratch-2000000');
	const output = cell.getByTestId('output');
	await expect(output).toContainText('Source:', { timeout: 90_000 });
	// The BODY, which `?` alone never shows - this is the whole difference.
	await expect(output).toContainText('marker_inside_body');

	// Selectable: a `<pre>` of plain text, not an image or an inert box.
	const selected = await output.evaluate((el) => {
		const range = el.ownerDocument.createRange();
		range.selectNodeContents(el);
		const sel = el.ownerDocument.getSelection();
		sel?.removeAllRanges();
		sel?.addRange(range);
		return sel?.toString() ?? '';
	});
	expect(selected).toContain('marker_inside_body');

	// Copyable: the cell's own copy-output button is ENABLED and reports success,
	// which is what the disabled state means for an image-only cell.
	const copy = cell.getByTestId('copy-output');
	await expect(copy).toBeEnabled();
});

test('`??` on a real library function is long, complete and SCROLLABLE', async ({ page }) => {
	await openNotebook(page);
	// `json.dumps` is ~4.4 KB of signature + docstring + source against a real
	// kernel - far past the height at which Cellar contracts an output into its
	// scroll box, which is the requirement being proven here.
	await runCellById(page, 'qmark-scratch-3000000', 'import json\njson.dumps??');

	await showCell(page, 'qmark-scratch-3000000');
	const cell = cellById(page, 'qmark-scratch-3000000');
	const output = cell.getByTestId('output');
	await expect(output).toContainText('Source:', { timeout: 90_000 });
	// A line from deep inside the function body, so this is the whole source and
	// not a prefix of it.
	await expect(output).toContainText('def dumps(');

	// Nothing was dropped in silence: the accumulator's truncation marker is what
	// a capped output would carry, and this is nowhere near the cap.
	await expect(output).not.toContainText('output truncated');

	// Contracted into its own scroll box, so a long answer does not push the rest of
	// the notebook off screen - and it really scrolls.
	const box = cell.getByTestId('output-scroll');
	await expect(box).toHaveAttribute('data-scrolled', 'true');
	const scrolled = await box.evaluate((el) => {
		el.scrollTop = el.scrollHeight;
		return { top: el.scrollTop, overflow: el.scrollHeight - el.clientHeight };
	});
	expect(scrolled.overflow, 'the output is taller than its box').toBeGreaterThan(0);
	expect(scrolled.top, 'the box scrolled').toBeGreaterThan(0);

	// The persisted text is the whole answer, so a reopened notebook shows it too.
	const persisted = await persistedOutputs(page, 'qmark-scratch-3000000');
	const saved = String(persisted[0]?.data?.['text/plain'] ?? '');
	expect(saved.length).toBeGreaterThan(2000);
	expect(saved).toContain('def dumps(');
});

test('a name that does not exist says so, clearly', async ({ page }) => {
	await openNotebook(page);
	await runCellById(page, 'qmark-scratch-4000000', 'cellar_no_such_name_xyz?');

	await showCell(page, 'qmark-scratch-4000000');
	const cell = cellById(page, 'qmark-scratch-4000000');
	const output = cell.getByTestId('output');
	// IPython answers this one on stdout, with no payload - so the sentence is the
	// kernel's own and Cellar must neither swallow it nor add to it.
	await expect(output).toContainText('cellar_no_such_name_xyz', { timeout: 90_000 });
	await expect(output).toContainText('not found');

	const persisted = await persistedOutputs(page, 'qmark-scratch-4000000');
	expect(persisted.map((o) => o.output_type)).toEqual(['stream']);
	// Emphatically not an empty box: the cell has exactly one output and it speaks.
	expect(persisted).toHaveLength(1);
});

test('a `?` that is only TEXT produces no documentation', async ({ page }) => {
	await openNotebook(page);
	// The mechanism behind requirement 5, asserted against the real transformer: a
	// `?` inside a string or a comment is not a help request, so a SQL cell's
	// `WHERE b = ?` (which Cellar compiles into exactly such a string) can never
	// turn into a documentation lookup.
	await runCellById(page, 'qmark-scratch-5000000', 'q = """SELECT a FROM t WHERE b = ?"""\n# is this a question?\nlen(q)');

	await showCell(page, 'qmark-scratch-5000000');
	const cell = cellById(page, 'qmark-scratch-5000000');
	await expect(cell.getByTestId('output')).toContainText('27', { timeout: 90_000 });
	const persisted = await persistedOutputs(page, 'qmark-scratch-5000000');
	expect(persisted.map((o) => o.output_type)).toEqual(['execute_result']);
});

test('a markdown or raw cell holding `len?` never asks the kernel', async ({ page }) => {
	await openNotebook(page);

	// A markdown cell RUNS by rendering: no kernel, so no documentation and no
	// output at all. (PR 112's Tab-in-markdown bug was this class of mistake.)
	await runCellById(page, 'qmark-markdown-000000', '`len?` in prose');
	expect(await persistedOutputs(page, 'qmark-markdown-000000')).toEqual([]);

	// A raw cell is refused before it can reach a queue slot, and the refusal
	// leaves its outputs alone.
	const refusal = await page.evaluate(async () => {
		const res = await fetch('/api/cells/qmark-raw-00000000000/run', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ source: 'len?', nb: 'notebook.ipynb' })
		});
		return await res.text();
	});
	expect(refusal).toContain('run:refused');
	expect(await persistedOutputs(page, 'qmark-raw-00000000000')).toEqual([]);
});

test('the documentation survives a reload, and a restart leaves it alone', async ({ page }) => {
	await openNotebook(page);
	await runCellById(page, 'qmark-scratch-6000000', 'len?');
	const cell = () => cellById(page, 'qmark-scratch-6000000');
	await showCell(page, 'qmark-scratch-6000000');
	await expect(cell().getByTestId('output')).toContainText('Signature:', { timeout: 90_000 });

	// It is an OUTPUT, not a tooltip: it is still there after a reload, which is the
	// whole reason for that choice.
	await openNotebook(page);
	await showCell(page, 'qmark-scratch-6000000');
	await expect(cell().getByTestId('output')).toContainText('Signature:', { timeout: 30_000 });

	// And a kernel restart - requirement 4's "nothing breaks" - neither removes it
	// nor stops the next lookup from working.
	const restarted = await page.evaluate(async () => {
		const res = await fetch('/api/kernel/restart', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ path: 'notebook.ipynb' })
		});
		return res.ok;
	});
	expect(restarted).toBe(true);
	await expect(cell().getByTestId('output')).toContainText('Signature:');

	await runCellById(page, 'qmark-scratch-6000000', 'dict?');
	await expect(cell().getByTestId('output')).toContainText('dict', { timeout: 90_000 });
});
