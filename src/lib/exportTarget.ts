/**
 * The nbdev-style export target's BASE - the pure, browser-safe half.
 *
 * A notebook's export target (`metadata.cellar.export_target`, the `.py` module
 * its marked cells are written to) may be expressed relative to one of three
 * bases, recorded beside it as `metadata.cellar.export_base`:
 *
 *   - `workspace` - the workspace root. This is what an ABSENT `export_base`
 *     means, permanently: every notebook written before bases existed stores a
 *     workspace-relative target and no base, and those must keep resolving to
 *     the identical file forever. `workspace` is therefore never persisted -
 *     the setter deletes the key - so absence stays unambiguous and no
 *     migration ever rewrites a legacy notebook.
 *   - `notebook` - the notebook's OWN directory, so the module travels with the
 *     notebook when it moves.
 *   - `git` - the notebook's enclosing git repository (the directory holding
 *     `.git`, found by walking UP from the notebook - a worktree's `.git`
 *     pointer FILE counts, since that is the top of a working tree). This is
 *     deliberately NOT the code root (which may be an external worktree and
 *     governs the KERNEL, not the notebook file) and not the workspace: the
 *     enclosing repository was the captain's explicit choice. A notebook with
 *     no enclosing repository is a first-class refusal, not an exception.
 *
 * Whatever the base, the RESOLVED module path must still land inside the
 * workspace - a base changes how the path is expressed, never what the
 * exporter may write to (`server/export-py.ts` runs every resolution through
 * the same `resolveInWorkspace` guard).
 *
 * This module holds only what needs no filesystem: the vocabulary (shared by
 * the server setter, the MCP surface and the UI select, so the three cannot
 * drift) and the importability rule the export section renders.
 */

/** Where an export target's path is measured from. */
export type ExportBase = 'workspace' | 'notebook' | 'git';

/** Every legal base, in the order the UI select offers them. */
export const EXPORT_BASES: readonly ExportBase[] = ['workspace', 'notebook', 'git'];

/** Is this value one of the three legal bases? (`workspace` = the absent default.) */
export function isExportBase(v: unknown): v is ExportBase {
	return v === 'workspace' || v === 'notebook' || v === 'git';
}

/** How the UI select names each base. */
export const EXPORT_BASE_LABELS: Record<ExportBase, string> = {
	workspace: 'workspace root',
	notebook: 'notebook folder',
	git: 'git root'
};

/**
 * The importability warning for the export section, or null when there is
 * nothing accurate to warn about.
 *
 * Python import resolution follows the CODE ROOT (the bar directly above this
 * section): the kernel's cwd, and what Cellar puts on `sys.path`. A module
 * written outside that directory is on disk exactly where the user asked, the
 * export reports success - and `import` then fails, which is the confusing
 * late failure this warning surfaces at the moment the target is chosen.
 *
 * Inputs are the two workspace-scoped declarations the tab already holds:
 * `resolved` is the module's WORKSPACE-relative resolved path (null when no
 * target is configured, or when it could not be resolved - a resolution error
 * is its own display, not this one), and `root` is the notebook's declared
 * code root (null = the workspace root). Both are lexical declarations in the
 * same namespace, so a boundary-aware prefix test decides containment.
 *
 * The rule, stated so it warns ONLY when it applies:
 *  - no resolved target, or no declared root → null. With the default root the
 *    kernel runs at the workspace root, and a workspace-contained module is
 *    always under it - the everyday case costs no chrome.
 *  - an EXTERNAL root (`../…` or absolute - the same declaration-shape test the
 *    root picker's stand-in uses) can never contain a workspace file: a root
 *    that ENCLOSES the workspace is refused at admission (`enclosesWorkspace`),
 *    so the module is provably outside the kernel's import scope → warn.
 *  - an in-workspace root contains the module iff the resolved path sits under
 *    it → warn otherwise.
 */
export function exportImportWarning(resolved: string | null, root: string | null): string | null {
	if (!resolved || !root) return null;
	const external = root.startsWith('../') || root.startsWith('/') || root === '..';
	const under = !external && (resolved === root || resolved.startsWith(root + '/'));
	if (under) return null;
	return `the module lands outside the code root (${root}), so this notebook's kernel cannot import it - import resolves from the code root`;
}
