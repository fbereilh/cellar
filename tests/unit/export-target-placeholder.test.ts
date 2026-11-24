/**
 * The export path field's example follows the notebook's language: `utils.py` in
 * a Python notebook, `utils.mojo` in a Mojo one. A Rust notebook generates no
 * module, so it keeps the Python example rather than suggesting a `.rs` module.
 */
import { describe, it, expect } from 'vitest';
import { exportTargetPlaceholder } from '../../src/lib/exportRole';

describe('exportTargetPlaceholder', () => {
	it('names the module extension of the notebook language', () => {
		expect(exportTargetPlaceholder('python')).toBe('utils.py');
		expect(exportTargetPlaceholder('mojo')).toBe('utils.mojo');
	});

	it('keeps the Python example for a Rust notebook, which exports no module', () => {
		expect(exportTargetPlaceholder('rust')).toBe('utils.py');
	});
});
