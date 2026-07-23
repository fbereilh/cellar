import { test, expect, type Page, type Locator } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * E2E for the imports-cell staleness scope, driven through the real UI: the amber
 * "stale" chip a user actually looks at, over a real kernel and the real dataflow
 * probe.
 *
 * THE BUG THIS GUARDS. The imports cell defines a name almost every cell below it
 * uses, and the staleness rule transmitted along every edge out of a touched cell,
 * so any edit of it lit up the ENTIRE notebook amber - with agent import routing
 * rewriting that cell constantly, "stale" stopped carrying information. Now only a
 * cell reading a name whose import statement actually changed goes stale.
 *
 * Both directions are asserted from the same notebook, because they fail in
 * opposite ways: adding an unrelated import must light up NOTHING downstream,
 * while REBINDING a name must still light up its reader (and that reader's own
 * dependents). A fix that only quiets the notebook is not a fix.
 *
 * Boots the REAL launcher against a throwaway workspace (see ./harness); SKIPS
 * when the kernel runtime is absent (local-only, like smoke.spec).
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const EVIDENCE = process.env.CELLAR_EVIDENCE_DIR || '';

// `json` and `re` are stdlib, so the notebook needs no packages beyond ipykernel.
const IMPORTS_SRC = 'import json\nimport re';
const USES_JSON_SRC = "blob = json.dumps({'a': 1})\nprint('blob ->', blob)";
const USES_RE_SRC = "hit = re.search('a', 'abc').group(0)\nprint('hit ->', hit)";
const JOINS_SRC = "print('joined ->', blob + hit)";

function cell(id: string, source: string) {
	return {
		id,
		cell_type: 'code',
		metadata: id === 'c-imports' ? { cellar: { role: 'imports' } } : {},
		execution_count: null,
		outputs: [],
		source: source.split('\n').map((l, i, a) => (i === a.length - 1 ? l : l + '\n'))
	};
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available - E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-imports-stale-'));

	const venv = join(workspace, '.venv');
	expect(spawnSync('uv', ['venv', venv], { stdio: 'inherit' }).status).toBe(0);
	expect(
		spawnSync('uv', ['pip', 'install', '--python', join(venv, 'bin', 'python'), 'ipykernel'], { stdio: 'inherit' })
			.status
	).toBe(0);

	mkdirSync(workspace, { recursive: true });
	writeFileSync(
		join(workspace, 'notebook.ipynb'),
		JSON.stringify(
			{
				cells: [
					cell('c-imports', IMPORTS_SRC),
					cell('c-json', USES_JSON_SRC),
					cell('c-re', USES_RE_SRC),
					cell('c-joins', JOINS_SRC)
				],
				metadata: { kernelspec: { name: 'python3', display_name: 'python3', language: 'python' } },
				nbformat: 4,
				nbformat_minor: 5
			},
			null,
			1
		)
	);

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

async function openNotebook(page: Page): Promise<void> {
	const openBtn = page.getByTestId('empty-open-notebook');
	if (await openBtn.isVisible().catch(() => false)) await openBtn.click();
	await expect(page.getByTestId('cell').first()).toBeVisible();
}

async function runCell(page: Page, c: Locator): Promise<void> {
	await c.getByTestId('run').click();
	await expect(c.getByTestId('running-indicator')).toHaveCount(0, { timeout: 90_000 });
}

/** Build the lazy editor (click) and replace cell `c`'s source with `text`. */
async function typeInto(page: Page, c: Locator, text: string): Promise<void> {
	await c.getByTestId('editor-scroll').click();
	const editor = c.locator('.cm-content');
	await expect(editor).toBeVisible();
	await editor.click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.type(text);
	// Typing leaves CodeMirror's completion tooltip open over the cells below, which
	// would hide the very badges (or absence of them) the assertions - and the
	// evidence screenshots - are about. Escape is CM's first, so this closes the
	// popup without leaving edit mode.
	await page.keyboard.press('Escape');
	await expect(c.locator('.cm-tooltip-autocomplete')).toHaveCount(0);
}

async function shot(page: Page, name: string): Promise<void> {
	if (!EVIDENCE) return;
	mkdirSync(EVIDENCE, { recursive: true });
	await page.screenshot({ path: join(EVIDENCE, name), fullPage: true });
}

test('an imports-cell edit stales only the cells reading an import that actually changed', async ({ page }) => {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);

	const cells = page.getByTestId('cell');
	await expect(cells).toHaveCount(4);
	const imports = cells.nth(0);
	const usesJson = cells.nth(1);
	const usesRe = cells.nth(2);
	const joins = cells.nth(3);

	// 1. Run the whole notebook against a real kernel: everything is fresh.
	for (const c of [imports, usesJson, usesRe, joins]) await runCell(page, c);
	await expect(joins.getByTestId('output-scroll')).toContainText('joined ->', { timeout: 90_000 });
	await expect(page.getByTestId('stale-badge')).toHaveCount(0);

	// 2. ADD an unrelated import. Every cell below reads a name this cell defines,
	//    so the old rule lit up all three. None of their bindings moved.
	await typeInto(page, imports, 'import json\nimport re\nimport math');
	// The imports cell itself IS stale - it was edited after it ran.
	await expect(imports.getByTestId('stale-badge')).toBeVisible({ timeout: 30_000 });
	await shot(page, 'imports-staleness-add-unused.png');
	await expect(page.getByTestId('stale-badge')).toHaveCount(1);
	for (const c of [usesJson, usesRe, joins]) await expect(c.getByTestId('stale-badge')).toHaveCount(0);

	// 3. Re-run the imports cell. A plain re-run rebinds the same modules, so it
	//    must not stale anything downstream either.
	await runCell(page, imports);
	await expect(page.getByTestId('stale-badge')).toHaveCount(0, { timeout: 30_000 });

	// 4. REBIND one name. `re` now resolves to something else entirely, so the cell
	//    that reads it - and the cell that reads ITS result - must go stale, while
	//    the `json` reader stays fresh. This is the direction a fix must not lose.
	await typeInto(page, imports, 'import json\nimport math\nimport string as re');
	await expect(usesRe.getByTestId('stale-badge')).toBeVisible({ timeout: 30_000 });
	await expect(joins.getByTestId('stale-badge')).toBeVisible({ timeout: 30_000 });
	await shot(page, 'imports-staleness-rebind.png');
	await expect(usesJson.getByTestId('stale-badge')).toHaveCount(0);
});
