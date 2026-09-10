/**
 * When kernel completion gives up waiting, the user is TOLD - in the popup.
 *
 * This is the user-visible half of a real, silent defect. Kernel completion waits
 * out Cellar's OWN brief internal work (the `onRunEnd` variables probe holds the
 * same shell channel at exactly the moment a user types a name the run just
 * defined). That wait used to be bounded by a wall-clock guess at how long the
 * probe takes - 500ms, chosen on a 15-core M5 Pro - and on a machine measured
 * 2.3-3x slower the probe outlived it. The completion was refused, the refusal was
 * swallowed as an expected state, and the user simply got no kernel names with no
 * way to tell that from "nothing matched". Deterministic:
 * `kernel-introspection.spec.ts:217` failed 5 of 5 Linux CI runs.
 *
 * The bound is now a UX limit on one keystroke rather than an estimate of the
 * probe, and hitting it is its own outcome (`busy_timeout`) that the completion
 * source STATES. What is left to prove HERE is only that CodeMirror renders that
 * row and that accepting it types nothing - the parts a unit test cannot see.
 *
 * The refusal is therefore INJECTED at the route rather than provoked by timing.
 * Provoking it needs Cellar's own probe to hold the kernel at the exact instant of
 * the keystroke, which is a race in both directions: an attempt that booted with
 * the bound at 1ms still passed whenever the probe had already finished. A racy
 * test for a fix about flakiness would be the wrong thing to ship, and the server
 * half is pinned deterministically (and mutation-checked) in
 * `tests/unit/kernel-introspect.test.ts`. `kernel-introspection.spec.ts` remains
 * the end-to-end regression at the shipped default.
 */
import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar, removeWorkspace } from './harness';

let workspace = '';
let launcher: ChildProcess | null = null;
let baseURL = '';

const DEFINE_SRC = 'cellar_wait_notice_marker = 1\n';

function notebookJson(): string {
	return JSON.stringify({
		nbformat: 4,
		nbformat_minor: 5,
		metadata: { kernelspec: { name: 'python3', display_name: 'python3' } },
		cells: [
			{
				cell_type: 'code',
				id: 'waitnotice-define-000',
				metadata: {},
				execution_count: null,
				source: [DEFINE_SRC],
				outputs: []
			},
			{
				cell_type: 'code',
				id: 'waitnotice-scratch-00',
				metadata: {},
				execution_count: null,
				source: [''],
				outputs: []
			}
		]
	});
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-wait-notice-e2e-'));
	writeFileSync(join(workspace, 'notebook.ipynb'), notebookJson());
	const booted = await bootCellar(workspace);
	launcher = booted.proc;
	baseURL = booted.url;
});

test.afterAll(() => {
	if (launcher) killCellar(launcher);
	removeWorkspace(workspace);
});

async function openNotebook(page: Page): Promise<void> {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	const openBtn = page.getByTestId('empty-open-notebook');
	const firstCell = page.getByTestId('cell').first();
	await expect(openBtn.or(firstCell).first()).toBeVisible();
	if (await openBtn.isVisible()) await openBtn.click();
	await expect(firstCell).toBeVisible();
}

function completionLabels(page: Page, i: number) {
	// Scoped to the cell: several editors are mounted at once, so a page-wide
	// locator can answer about a popup left open somewhere nobody is typing.
	return page.getByTestId('cell').nth(i).locator('.cm-tooltip-autocomplete li');
}

test('a completion that gave up waiting SAYS so, and inserts nothing if accepted', async ({ page }) => {
	// The server's own give-up, injected: this is the exact body the route returns
	// when `waitForIntrospectable` hits its bound (see kernel.ts), so what is under
	// test is the client's handling of it and nothing else.
	await page.route('**/api/kernel/complete', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ ok: false, reason: 'busy_timeout' })
		})
	);
	await openNotebook(page);

	// Run the defining cell so there is genuinely a kernel and a namespace: the
	// point is that the user gets no KERNEL names, not that there is no kernel.
	const define = page.getByTestId('cell').nth(0);
	await define.getByTestId('run').click();
	await expect(define.getByTestId('run-meta')).toContainText('ran', { timeout: 90_000 });

	const scratch = page.getByTestId('cell').nth(1);
	await scratch.getByTestId('editor-scroll').click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.type('cellar_wait_notice_mark');

	// The popup says WHY there are no kernel names. Before this, the user saw
	// nothing at all here and could not tell it from "nothing matched".
	const notice = completionLabels(page, 1).filter({ hasText: /kernel names unavailable/i });
	await expect(notice.first()).toBeVisible({ timeout: 20_000 });

	// And accepting it by reflex must not type a message into the user's cell -
	// that would be worse than the silence it replaces.
	const before = await scratch.locator('.cm-content').innerText();
	await notice.first().click();
	await expect(scratch.locator('.cm-content')).toHaveText(before);
	await expect(scratch.locator('.cm-content')).not.toContainText('kernel names unavailable');
});
