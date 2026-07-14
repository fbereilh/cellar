/**
 * "Add the project root to the kernel's `sys.path`" — pure logic.
 *
 * A Jupyter kernel starts with the notebook's OWN directory on `sys.path`, but
 * not necessarily the workspace/project root, so a notebook in a subfolder can't
 * `import mypackage` (nor the `.py` module Cellar's nbdev-style export writes at
 * the root). Adding the workspace root fixes that. It is a per-workspace setting,
 * default ON, persisted in the UI-state store and honored at kernel-start time
 * (and applied live to running kernels on toggle) — see `kernel.ts`.
 *
 * This module holds only the pure bits (no fs, no jupyter, no `$lib` server
 * imports) so they are cheap to unit-test: the setting predicate + the two
 * idempotent Python snippets that add / remove the root from `sys.path`.
 */

/** UI-state key for the per-workspace setting. Default value is TRUE (see below). */
export const ADD_PROJECT_ROOT_KEY = 'cellar-add-project-root';

/**
 * Resolve the effective setting. Default is TRUE, so imports "just work" out of
 * the box: only an explicit `false` (stored value, or a falsey env override)
 * disables it. An env override (`CELLAR_ADD_PROJECT_ROOT`) wins over the store so
 * a headless / CI run can force it either way.
 */
export function projectRootEnabled(storeValue: unknown, envValue?: string | null): boolean {
	if (envValue != null && envValue !== '') {
		const v = envValue.trim().toLowerCase();
		if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
		if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
	}
	// Default ON: anything but an explicit `false` enables it.
	return storeValue !== false;
}

/**
 * Idempotent Python that prepends `root` to `sys.path` (front, so a project
 * module shadows a same-named site package, matching how the notebook's own dir
 * behaves). Never inserts a duplicate. `root` must be an absolute path.
 */
export function projectRootAddCode(root: string): string {
	return [
		'import sys as _sys',
		`_cellar_root = ${JSON.stringify(root)}`,
		'if _cellar_root not in _sys.path:',
		'    _sys.path.insert(0, _cellar_root)',
		'del _cellar_root, _sys'
	].join('\n');
}

/**
 * Idempotent Python that removes every occurrence of `root` from `sys.path`, the
 * inverse used when the setting is toggled OFF on a live kernel.
 */
export function projectRootRemoveCode(root: string): string {
	return [
		'import sys as _sys',
		`_cellar_root = ${JSON.stringify(root)}`,
		'while _cellar_root in _sys.path:',
		'    _sys.path.remove(_cellar_root)',
		'del _cellar_root, _sys'
	].join('\n');
}
