/**
 * The export path field's example follows the notebook's language: `utils.py` in
 * a Python notebook, `utils.mojo` in a Mojo one and `utils.rs` in a Rust one.
 */
import { describe, it, expect } from 'vitest';
import { exportTargetPlaceholder } from '../../src/lib/exportRole';

describe('exportTargetPlaceholder', () => {
	it('names the module extension of the notebook language', () => {
		expect(exportTargetPlaceholder('python')).toBe('utils.py');
		expect(exportTargetPlaceholder('mojo')).toBe('utils.mojo');
		expect(exportTargetPlaceholder('rust')).toBe('utils.rs');
	});
});
