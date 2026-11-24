/**
 * The export path field's example follows the notebook's language: `utils.py` in
 * a Python notebook, `utils.mojo` in a Mojo one. A Rust notebook generates no
 * module, so it keeps the Python example rather than suggesting a `.rs` module.
 *
 * The source guard is there because vitest runs without the SvelteKit plugin, so
 * `Notebook.svelte` cannot be mounted, and e2e is absent from the pre-push gate.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exportTargetPlaceholder } from '../../src/lib/exportRole';

describe('exportTargetPlaceholder', () => {
	it('names the module extension of the notebook language', () => {
		expect(exportTargetPlaceholder('python')).toBe('utils.py');
		expect(exportTargetPlaceholder('mojo')).toBe('utils.mojo');
	});

	it('keeps the Python example for a Rust notebook, which exports no module', () => {
		expect(exportTargetPlaceholder('rust')).toBe('utils.py');
	});

	it('is what the export field in Notebook.svelte shows', () => {
		const src = readFileSync(join(__dirname, '../../src/lib/Notebook.svelte'), 'utf8');
		expect(src).toContain('placeholder={exportTargetPlaceholder(notebookLanguage)}');
		expect(src).not.toContain('placeholder="utils.py"');
	});
});
