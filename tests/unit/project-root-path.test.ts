/**
 * "Add project root to sys.path" — pure setting predicate + inject snippets.
 *
 * A notebook in a subfolder can't `import` a project module unless the workspace
 * root is on `sys.path`. Cellar adds it at kernel start, gated by a per-workspace
 * setting that defaults ON. These cover the default, the env override, and the
 * idempotent add/remove Python the kernel injects.
 */
import { describe, it, expect } from 'vitest';
import {
	ADD_PROJECT_ROOT_KEY,
	projectRootEnabled,
	projectRootAddCode,
	projectRootRemoveCode
} from '../../src/lib/server/projectRoot';

describe('projectRootEnabled', () => {
	it('defaults ON when the setting is unset', () => {
		expect(projectRootEnabled(undefined)).toBe(true);
		expect(projectRootEnabled(null)).toBe(true);
	});

	it('is ON unless the stored value is explicitly false', () => {
		expect(projectRootEnabled(true)).toBe(true);
		expect(projectRootEnabled(false)).toBe(false);
		// Any other truthy junk is still ON (default direction).
		expect(projectRootEnabled('yes')).toBe(true);
	});

	it('lets an env override win over the store, both directions', () => {
		expect(projectRootEnabled(true, '0')).toBe(false);
		expect(projectRootEnabled(true, 'false')).toBe(false);
		expect(projectRootEnabled(true, 'off')).toBe(false);
		expect(projectRootEnabled(false, '1')).toBe(true);
		expect(projectRootEnabled(false, 'true')).toBe(true);
		expect(projectRootEnabled(false, 'on')).toBe(true);
	});

	it('falls back to the store for an empty / unrecognized env value', () => {
		expect(projectRootEnabled(false, '')).toBe(false);
		expect(projectRootEnabled(true, '')).toBe(true);
		expect(projectRootEnabled(false, 'maybe')).toBe(false);
	});

	it('exposes a stable store key', () => {
		expect(ADD_PROJECT_ROOT_KEY).toBe('cellar-add-project-root');
	});
});

describe('projectRoot inject snippets', () => {
	const root = '/Users/dev/proj';

	it('add code prepends the root guarded against duplicates', () => {
		const code = projectRootAddCode(root);
		expect(code).toContain('import sys as _sys');
		expect(code).toContain(JSON.stringify(root));
		expect(code).toContain('if _cellar_root not in _sys.path:');
		expect(code).toContain('_sys.path.insert(0, _cellar_root)');
	});

	it('remove code strips every occurrence of the root', () => {
		const code = projectRootRemoveCode(root);
		expect(code).toContain('while _cellar_root in _sys.path:');
		expect(code).toContain('_sys.path.remove(_cellar_root)');
	});

	it('embeds the path as a valid Python/JSON string literal (quotes escaped)', () => {
		const weird = '/tmp/a "b" \\c';
		const code = projectRootAddCode(weird);
		expect(code).toContain(JSON.stringify(weird));
		// The literal must be quote-safe so it never breaks the injected line.
		expect(JSON.parse(JSON.stringify(weird))).toBe(weird);
	});
});
