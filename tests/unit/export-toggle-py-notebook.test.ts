/**
 * The export affordances on a `.py` (jupytext / Databricks source) notebook.
 *
 * Such a notebook stores no cell metadata, so a mark set there lived only in the
 * server's memory: the row toggle showed ON and the mark was gone after the next
 * relaunch. `notebookHoldsExport` is the ONE rule every export surface asks - the
 * server's refusals and the browser's gates - so the UI cannot offer what the
 * server refuses.
 *
 * The rule is executed here. The Svelte wiring is pinned by SOURCE guards,
 * because vitest runs without the SvelteKit plugin (the components cannot be
 * mounted) and e2e is absent from the pre-push gate; the behaviour itself is
 * covered by `tests/e2e/export-toggle-py-notebook.spec.ts` and the doc-layer +
 * route refusal by `tests/unit/mcp-set-cell-export.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { notebookHoldsExport, TEXT_NOTEBOOK_EXPORT_MARK_MESSAGE } from '../../src/lib/exportRole';

const src = (rel: string) => readFileSync(join(__dirname, '../../src', rel), 'utf8');

describe('notebookHoldsExport', () => {
	it('refuses a .py text notebook and allows an .ipynb', () => {
		expect(notebookHoldsExport(true)).toBe(false);
		expect(notebookHoldsExport(false)).toBe(true);
	});

	it('names the cause and the way out', () => {
		expect(TEXT_NOTEBOOK_EXPORT_MARK_MESSAGE).toContain('.py');
		expect(TEXT_NOTEBOOK_EXPORT_MARK_MESSAGE).toContain('Convert it to .ipynb');
	});
});

describe('every export surface asks the one rule', () => {
	it('the row toggle is withheld on a .py notebook', () => {
		const cell = src('lib/Cell.svelte');
		expect(cell).toMatch(/const exportOffered = \$derived\(notebookHoldsExport\(isPy\)\)/);
		expect(cell).toContain('{#if exportOffered && (canExport || exportStranded)}');
	});

	it('the export bar asks it too', () => {
		expect(src('lib/Notebook.svelte')).toMatch(/const showExportBar = \$derived\(notebookHoldsExport\(isPy\)\)/);
	});

	it('the optimistic mirror refuses and reverts on the server verdict', () => {
		const live = src('lib/LiveNotebook.svelte');
		expect(live).toMatch(/if \(exported && !notebookHoldsExport\(isPy\)\) \{\s*onNotice\?\.\(TEXT_NOTEBOOK_EXPORT_MARK_MESSAGE\);/);
		expect(live).toContain("verdict?.reason !== 'py-notebook'");
	});

	it('the server refusals ask it, not a second copy', () => {
		const nb = src('lib/server/notebook.ts');
		expect(nb).toContain("if (exported && !notebookHoldsExport(!!doc.jpFormat)) return { ok: false, reason: 'py-notebook' };");
		expect(nb).toContain('if (exported && !notebookHoldsExport(!!doc.jpFormat)) return [];');
		expect(src('lib/server/mcp/service.ts')).toContain('notebookHoldsExport(isPyTextNotebook(nb))');
		expect(src('routes/api/notebooks/export-py/+server.js')).toContain('notebookHoldsExport(isPyTextNotebook(body.path))');
		expect(src('routes/api/cells/[id]/+server.js')).toContain("r.reason === 'py-notebook'");
	});
});
