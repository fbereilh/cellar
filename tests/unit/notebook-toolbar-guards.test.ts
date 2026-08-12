/**
 * The notebook toolbar's three buttons live in a component, and vitest runs without
 * the SvelteKit plugin (see `vitest.config.ts`), so `Notebook.svelte` cannot be
 * mounted here. Their behavioural proof is `tests/e2e/toolbar-interrupt-clear-all.spec.ts`,
 * which neither CI nor the no-mistakes gate runs - so the rules that are one
 * expression wide are pinned at the source too (the `shell-refresh-handlers` /
 * `upload-default-guards` precedent).
 *
 * The rules:
 *
 *   1. Interrupt and Clear-all are SURFACING, not new logic: each button calls the
 *      handler prop its command-palette twin already drives (`onInterrupt` /
 *      `onClearAll`). A second kernel or clear implementation in the toolbar would
 *      be a second persistence/abort path.
 *   2. `LiveNotebook` passes `clearAll` in as `onClearAll` - the SAME function the
 *      `clear-all-outputs` palette command calls, so the two cannot diverge.
 *   3. The gating derives from the notebook's OWN state: `runningId`/`queued` (both
 *      already per-notebook props, so another notebook's run can never arm this
 *      button) and the cells' outputs read off the MODEL - never off the mounted
 *      DOM, which windowing prunes to a fraction of the notebook.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const NOTEBOOK = readFileSync(join(process.cwd(), 'src/lib/Notebook.svelte'), 'utf8');
const LIVE = readFileSync(join(process.cwd(), 'src/lib/LiveNotebook.svelte'), 'utf8');

/** The `<button …>` element whose `data-testid` is `id`. */
function buttonWith(testid: string): string {
	const marker = `data-testid="${testid}"`;
	const at = NOTEBOOK.indexOf(marker);
	expect(at, `no control carries data-testid="${testid}"`).toBeGreaterThan(-1);
	const open = NOTEBOOK.lastIndexOf('<button', at);
	const close = NOTEBOOK.indexOf('</button>', at);
	expect(open, `data-testid="${testid}" is not on a <button>`).toBeGreaterThan(-1);
	expect(close).toBeGreaterThan(at);
	return NOTEBOOK.slice(open, close);
}

/** The toolbar block, from its own marker to the element that follows it. */
const TOOLBAR = (() => {
	const at = NOTEBOOK.indexOf('data-testid="notebook-toolbar"');
	expect(at, 'the notebook toolbar is gone').toBeGreaterThan(-1);
	const end = NOTEBOOK.indexOf('</div>\n\t\t{#if showRootBar}', at);
	return NOTEBOOK.slice(at, end > at ? end : at + 4000);
})();

describe('notebook toolbar: the three whole-notebook actions', () => {
	it('renders Run all, Interrupt and Clear all outputs together', () => {
		for (const id of ['run-all', 'interrupt-all', 'clear-all-outputs']) {
			expect(TOOLBAR, `${id} is not in the toolbar`).toContain(`data-testid="${id}"`);
		}
	});

	it('gives each button a title and an aria-label, like Run all has', () => {
		for (const id of ['run-all', 'interrupt-all', 'clear-all-outputs']) {
			const btn = buttonWith(id);
			expect(btn, `${id} has no title`).toMatch(/title="/);
			expect(btn, `${id} has no aria-label`).toMatch(/aria-label="/);
		}
	});
});

describe('the buttons only TRIGGER the existing handlers', () => {
	it('Interrupt calls the onInterrupt prop and nothing else', () => {
		const btn = buttonWith('interrupt-all');
		expect(btn).toContain('onclick={() => onInterrupt?.()}');
		// No second abort/kernel path: the whole interrupt sequence (abort the in-flight
		// run fetches, bump `interruptGeneration`, then hit the server) is behind that prop.
		expect(btn).not.toMatch(/fetch\(|interruptGeneration|\/api\/kernel/);
	});

	it('Clear all outputs calls the onClearAll prop and nothing else', () => {
		const btn = buttonWith('clear-all-outputs');
		expect(btn).toContain('onclick={() => onClearAll?.()}');
		// A clear that persisted from here would be a SECOND persistence path beside
		// the one `clearAll` -> `clearCell` already drives.
		expect(btn).not.toMatch(/fetch\(|\/api\/cells/);
	});
});

describe('gating', () => {
	it('Interrupt is disabled unless THIS notebook is running or has queued work', () => {
		expect(NOTEBOOK).toContain(
			"const notebookBusy = $derived(runningId !== null || Object.keys(queued).length > 0);"
		);
		expect(buttonWith('interrupt-all')).toContain('disabled={!notebookBusy}');
	});

	it('Clear all outputs is disabled unless some cell holds output', () => {
		// Read off `cells` (the document model), so a cell windowing has never mounted
		// still counts - the same reason `clearAll` itself iterates the model.
		expect(NOTEBOOK).toContain(
			'const hasOutputs = $derived(cells.some((c) => (c.outputs?.length ?? 0) > 0));'
		);
		expect(buttonWith('clear-all-outputs')).toContain('disabled={!hasOutputs}');
	});

	it('Run all keeps its own gating unchanged', () => {
		expect(buttonWith('run-all')).toContain('disabled={!hasCodeCell}');
	});
});

describe('LiveNotebook wiring', () => {
	it('passes the palette command`s own clearAll in as onClearAll', () => {
		expect(LIVE).toContain('onClearAll={clearAll}');
		// The same function the `clear-all-outputs` command reaches through the
		// notebook API registry, so the button and the palette cannot diverge.
		expect(LIVE).toMatch(/onRegisterApi\?\.\([^)]*\bclearAll\b/);
	});

	it('passes the existing kernel interrupt in as onInterrupt', () => {
		expect(LIVE).toContain('onInterrupt={onInterruptKernel}');
	});
});
