import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * Cut / copy / paste / undo must carry a cell's WHOLE identity, not just its
 * source and nbformat type.
 *
 * The bug this pins: the clipboard entry carried `cell_type`, `source` and
 * `output_scrolled` and nothing else, so an ordinary copy/paste silently
 * DOWNGRADED a cell - a SQL cell came back as plain Python (wrong grammar, wrong
 * run path, its `-- >>` binding gone), and the nbdev export mark, the report-view
 * `hide_input` choice, the imports `role` and `hidden_from_agent` were dropped.
 * The UNDO record already carried the namespace whole, so the two paths
 * disagreed about what a cell IS; bulk cut/copy amplified the paste half to N
 * cells at once.
 *
 * Every assertion reads the SERVER document, never the DOM: a pasted cell renders
 * plausibly while its metadata is gone, which is exactly how this shipped.
 *
 * Each test SEEDS ITS OWN CELLS through the real add route and finds them by a
 * unique source, never by a fixed index. The notebook is one live server-owned
 * document shared by the whole file - rewriting the `.ipynb` on disk would not
 * reset it (`loadDoc` serves the cached doc), so index-based assertions would
 * drift with whatever the previous test left behind.
 *
 * Boots the REAL launcher against a throwaway workspace (see ./harness); SKIPS
 * when the kernel runtime is absent (local-only, like every other spec here).
 */

const NB = 'notebook.ipynb';

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

interface ServerCell {
	id: string;
	cell_type: string;
	source: string;
	cellar: Record<string, unknown>;
}

/** Every cell's type, source and `cellar` namespace, in document order. */
async function serverCells(page: Page): Promise<ServerCell[]> {
	return page.evaluate(async (nb) => {
		const res = await fetch(`/api/notebooks?path=${encodeURIComponent(nb)}`);
		const body = await res.json();
		type Raw = { id: string; cell_type: string; source: string; metadata?: { cellar?: Record<string, unknown> } };
		return (body.notebook.cells as Raw[]).map((c) => ({
			id: c.id,
			cell_type: c.cell_type,
			source: c.source,
			cellar: c.metadata?.cellar ?? {}
		}));
	}, NB);
}

/**
 * The DURABLE `cellar` keys - what a copy/cut has to preserve. Projected rather
 * than compared whole because a created cell also carries the defaults `newCell`
 * seeds (`extract`, `visible`), which say nothing about this rule.
 */
const DURABLE = ['language', 'role', 'export', 'hide_input', 'output_scrolled', 'hidden_from_agent'] as const;
function durable(cell: ServerCell): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const k of DURABLE) if (cell.cellar[k] !== undefined) out[k] = cell.cellar[k];
	return out;
}

interface Seed {
	cellType?: string;
	source: string;
	cellar?: Record<string, unknown>;
}

/**
 * Append `seeds` to the notebook through the real add route and return their ids.
 * Metadata a cell would otherwise need six UI gestures to acquire, seeded the way
 * an undo already does it (`POST /api/cells` takes a `cellar` namespace).
 */
async function seedCells(page: Page, seeds: Seed[]): Promise<string[]> {
	const ids = await page.evaluate(
		async ({ nb, seeds }) => {
			const out: string[] = [];
			let afterId: string | null = null;
			for (const s of seeds) {
				const res = await fetch('/api/cells', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ nb, afterId, cellType: s.cellType ?? 'code', source: s.source, cellar: s.cellar })
				});
				const body = await res.json();
				afterId = body.cell.id as string;
				out.push(afterId);
			}
			return out;
		},
		{ nb: NB, seeds }
	);
	// The adds arrive over SSE; wait for the last one to mount before driving keys.
	await expect(page.locator(`[data-cell-id="${ids[ids.length - 1]}"]`)).toBeVisible({ timeout: 15_000 });
	return ids;
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-clipboard-meta-'));
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

/** Open the default notebook and wait for its cells. Windowing off - every seeded cell mounts. */
async function openNotebook(page: Page): Promise<void> {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}&virtualize=0`);
	const openBtn = page.getByTestId('empty-open-notebook');
	// Settle on whichever the shell paints before probing (see insert-cell.spec.ts):
	// probing early reports the button invisible and turns the click into a no-op.
	await expect(openBtn.or(page.getByTestId('cell').first())).toBeVisible({ timeout: 30_000 });
	if (await openBtn.isVisible().catch(() => false)) await openBtn.click();
	await expect(page.getByTestId('cell').first()).toBeVisible({ timeout: 30_000 });
}

/**
 * Select a cell in COMMAND mode by clicking the empty middle of its toolbar strip
 * - clicking the editor would open it and put the keyboard in edit mode, and the
 * toolbar's own controls sit at the two ends.
 */
async function clickCell(page: Page, id: string, modifiers: ('Shift' | 'Meta' | 'Control')[] = []) {
	const card = page.locator(`[data-cell-id="${id}"]`);
	await card.scrollIntoViewIfNeeded();
	const box = await card.boundingBox();
	if (!box) throw new Error(`cell ${id} is not mounted`);
	await card.click({ position: { x: Math.round(box.width / 2), y: 14 }, modifiers });
	if (!modifiers.length) await expect(card).toHaveAttribute('data-active', 'true');
}

/** The cells whose source is `source`, in document order. */
const bySource = (cells: ServerCell[], source: string) => cells.filter((c) => c.source === source);

test.beforeEach(async ({ page }) => {
	await openNotebook(page);
});

test('copy/paste of a SQL cell keeps it a SQL cell', async ({ page }) => {
	const SRC = '-- >> sql_copy_df\nSELECT 1';
	const [id] = await seedCells(page, [{ source: SRC, cellar: { language: 'sql' } }]);

	await clickCell(page, id);
	await page.keyboard.press('c');
	await page.keyboard.press('v');

	await expect.poll(async () => bySource(await serverCells(page), SRC).length, { timeout: 15_000 }).toBe(2);
	const cells = await serverCells(page);
	const pasted = cells[cells.findIndex((c) => c.id === id) + 1];
	expect(pasted.id).not.toBe(id);
	// The whole point: `language`, so the grammar, the `spark.sql(...)` run path and
	// the `-- >>` result binding all follow the cell.
	expect(pasted.cellar.language).toBe('sql');
	expect(pasted.cell_type).toBe('code');
	expect(pasted.source).toBe(SRC);
});

test('copy/paste keeps the export mark, hidden input, scrolled output and agent visibility', async ({ page }) => {
	const SRC = 'def marked_helper():\n    return 1';
	const CELLAR = { export: true, hide_input: true, output_scrolled: false, hidden_from_agent: true };
	const [id] = await seedCells(page, [{ source: SRC, cellar: CELLAR }]);

	await clickCell(page, id);
	await page.keyboard.press('c');
	await page.keyboard.press('v');

	await expect.poll(async () => bySource(await serverCells(page), SRC).length, { timeout: 15_000 }).toBe(2);
	const cells = await serverCells(page);
	expect(durable(cells[cells.findIndex((c) => c.id === id) + 1])).toEqual(CELLAR);
});

test('cut/paste carries the imports role, which a same-notebook COPY may not duplicate', async ({ page }) => {
	const SRC = 'import role_probe';
	const [id] = await seedCells(page, [{ source: SRC, cellar: { role: 'imports' } }]);
	const rolesBefore = (await serverCells(page)).filter((c) => c.cellar.role === 'imports').length;

	// COPY: the original still holds the role, and the role is ONE PER NOTEBOOK - so
	// the pasted twin must NOT claim it (the server's uniqueness guard owns that).
	await clickCell(page, id);
	await page.keyboard.press('c');
	await page.keyboard.press('v');
	await expect.poll(async () => bySource(await serverCells(page), SRC).length, { timeout: 15_000 }).toBe(2);
	let cells = await serverCells(page);
	expect(cells[cells.findIndex((c) => c.id === id) + 1].cellar.role).toBeUndefined();
	expect(cells.filter((c) => c.cellar.role === 'imports')).toHaveLength(rolesBefore);

	// CUT: the original is gone, so the pasted cell IS the imports cell again.
	await clickCell(page, id);
	await page.keyboard.press('x');
	await expect.poll(async () => (await serverCells(page)).some((c) => c.id === id), { timeout: 15_000 }).toBe(false);
	await page.keyboard.press('v');
	await expect.poll(async () => bySource(await serverCells(page), SRC).length, { timeout: 15_000 }).toBe(2);
	cells = await serverCells(page);
	expect(bySource(cells, SRC).some((c) => c.cellar.role === 'imports')).toBe(true);
});

test('cut then undo restores the full metadata, not a degraded cell', async ({ page }) => {
	const SQL = '-- >> undo_df\nSELECT 2';
	const MARKED = 'def undo_helper():\n    return 2';
	const MARKED_CELLAR = { export: true, hide_input: true };
	const [sqlId, markedId] = await seedCells(page, [
		{ source: SQL, cellar: { language: 'sql', output_scrolled: true } },
		{ source: MARKED, cellar: MARKED_CELLAR }
	]);
	const before = await serverCells(page);
	const sqlIndex = before.findIndex((c) => c.id === sqlId);

	await clickCell(page, sqlId);
	await page.keyboard.press('Shift+ArrowDown'); // extend onto the marked cell
	await expect(page.getByTestId('selection-count')).toHaveText('2 selected');
	await page.keyboard.press('x');
	await expect.poll(async () => (await serverCells(page)).some((c) => c.id === markedId), { timeout: 15_000 }).toBe(
		false
	);

	await page.keyboard.press('z');
	await expect.poll(async () => (await serverCells(page)).length, { timeout: 15_000 }).toBe(before.length);
	const after = await serverCells(page);
	// Back at their original indices, carrying everything they left with.
	expect(after[sqlIndex].source).toBe(SQL);
	expect(durable(after[sqlIndex])).toEqual({ language: 'sql', output_scrolled: true });
	expect(after[sqlIndex + 1].source).toBe(MARKED);
	expect(durable(after[sqlIndex + 1])).toEqual(MARKED_CELLAR);
});

test('a BULK copy of a mixed selection pastes every cell with its own metadata', async ({ page }) => {
	const seeds: Seed[] = [
		{ source: '-- >> bulk_df\nSELECT 3', cellar: { language: 'sql' } },
		{ source: 'def bulk_helper():\n    return 3', cellar: { export: true, hide_input: true } },
		{ source: 'print("bulk")', cellar: { output_scrolled: true, hidden_from_agent: true } },
		{ cellType: 'markdown', source: '## bulk heading' },
		{ cellType: 'raw', source: 'bulk raw text' }
	];
	const ids = await seedCells(page, seeds);
	const before = await serverCells(page);
	const originals = ids.map((id) => before.find((c) => c.id === id)!);

	await clickCell(page, ids[0]);
	await clickCell(page, ids[ids.length - 1], ['Shift']);
	await expect(page.getByTestId('selection-count')).toHaveText(`${ids.length} selected`);
	await page.keyboard.press('c');
	await page.keyboard.press('v');

	await expect.poll(async () => (await serverCells(page)).length, { timeout: 20_000 }).toBe(before.length + ids.length);
	const after = await serverCells(page);
	// The pasted block sits directly below the primary (the head of the range).
	const at = after.findIndex((c) => c.id === ids[ids.length - 1]) + 1;
	const pasted = after.slice(at, at + ids.length);
	expect(pasted.map((c) => c.cell_type)).toEqual(originals.map((c) => c.cell_type));
	expect(pasted.map((c) => c.source)).toEqual(originals.map((c) => c.source));
	expect(pasted.map(durable)).toEqual(originals.map(durable));
});

test('a BULK cut then undo brings every cell back with its own metadata', async ({ page }) => {
	const seeds: Seed[] = [
		{ source: '-- >> bulkundo_df\nSELECT 4', cellar: { language: 'sql' } },
		{ source: 'def bulkundo_helper():\n    return 4', cellar: { export: true, hide_input: true } },
		{ cellType: 'markdown', source: '## bulkundo heading' },
		{ source: 'print("bulkundo")', cellar: { output_scrolled: true, hidden_from_agent: true } }
	];
	const ids = await seedCells(page, seeds);
	const before = await serverCells(page);
	const at = before.findIndex((c) => c.id === ids[0]);

	await clickCell(page, ids[0]);
	await clickCell(page, ids[ids.length - 1], ['Shift']);
	await page.keyboard.press('x');
	await expect.poll(async () => (await serverCells(page)).length, { timeout: 20_000 }).toBe(before.length - ids.length);

	await page.keyboard.press('z');
	await expect.poll(async () => (await serverCells(page)).length, { timeout: 20_000 }).toBe(before.length);
	const after = await serverCells(page);
	const restored = after.slice(at, at + ids.length);
	const originals = ids.map((id) => before.find((c) => c.id === id)!);
	expect(restored.map((c) => c.source)).toEqual(originals.map((c) => c.source));
	expect(restored.map((c) => c.cell_type)).toEqual(originals.map((c) => c.cell_type));
	expect(restored.map(durable)).toEqual(originals.map(durable));
});
