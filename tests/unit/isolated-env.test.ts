import { describe, it, expect } from 'vitest';
import { isIsolatedEnv } from '../../src/lib/server/instances';

/**
 * CELLAR_ISOLATED gates the launcher's isolation path: a truthy value makes a
 * launch skip the global registry entry AND the reaping / single-instance-lock
 * block (bin/cellar.js: `const isolated = isIsolatedEnv()` → gates
 * registerInstance/updateInstance, and folds into `forceNew` which gates the
 * reap block). This pins the predicate that decision hangs on — truthy ⇒ isolated
 * (no register, no reap), falsy / unset ⇒ normal registered + reaping launch.
 */
describe('isIsolatedEnv', () => {
	it('is truthy for 1 / true / yes (case-insensitive)', () => {
		for (const v of ['1', 'true', 'TRUE', 'True', 'yes', 'YES', 'Yes']) {
			expect(isIsolatedEnv({ CELLAR_ISOLATED: v })).toBe(true);
		}
	});

	it('is falsy when unset', () => {
		expect(isIsolatedEnv({})).toBe(false);
		expect(isIsolatedEnv({ CELLAR_ISOLATED: undefined })).toBe(false);
	});

	it('is falsy for empty and non-affirmative values', () => {
		for (const v of ['', '0', 'false', 'no', 'off', 'nope', ' 1', '1 ', '2', 'y', 'enabled']) {
			expect(isIsolatedEnv({ CELLAR_ISOLATED: v })).toBe(false);
		}
	});

	it('defaults to reading process.env when no arg is passed', () => {
		const prev = process.env.CELLAR_ISOLATED;
		try {
			process.env.CELLAR_ISOLATED = 'true';
			expect(isIsolatedEnv()).toBe(true);
			process.env.CELLAR_ISOLATED = '0';
			expect(isIsolatedEnv()).toBe(false);
			delete process.env.CELLAR_ISOLATED;
			expect(isIsolatedEnv()).toBe(false);
		} finally {
			if (prev === undefined) delete process.env.CELLAR_ISOLATED;
			else process.env.CELLAR_ISOLATED = prev;
		}
	});
});
