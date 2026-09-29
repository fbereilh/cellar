/**
 * The export affordances on a `.py` (jupytext / Databricks source) notebook.
 *
 * Such a notebook stores no cell metadata, so a mark set there lived only in the
 * server's memory: the row toggle showed ON and the mark was gone after the next
 * relaunch. `notebookHoldsExport` is the ONE rule every export surface asks - the
 * server's refusals and the browser's gates - so the UI cannot offer what the
 * server refuses.
 *
 * The rule is executed here. The doc-layer and route refusal are driven in
 * `tests/unit/mcp-set-cell-export.test.ts`, and the browser behaviour on both a
 * `.py` and an `.ipynb` notebook in `tests/e2e/export-toggle-py-notebook.spec.ts`.
 */
import { describe, it, expect } from 'vitest';
import { notebookHoldsExport, TEXT_NOTEBOOK_EXPORT_MARK_MESSAGE } from '../../src/lib/exportRole';

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
