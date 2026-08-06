/**
 * The ONE rule for turning an ABSOLUTE path into a workspace-RELATIVE one.
 *
 * Every bus event carries an absolute path while the shell addresses notebooks
 * workspace-relatively, so this conversion is needed wherever the two shapes
 * meet. A second copy of it drifts silently: the shell held two, and both were
 * a bare `startsWith` with no separator boundary, so a SIBLING directory sharing
 * the workspace's name as a prefix (`/tmp/ws` vs `/tmp/ws2/x.ipynb`) read as
 * INSIDE the workspace and yielded the nonsense rel `2/x.ipynb` - which the
 * foreign-run gate then decided as a MISMATCH and silently skipped the refresh,
 * the exact missed-refresh failure its fail-open doctrine exists to prevent.
 *
 * Returns null for anything it cannot decide - a path outside the workspace, one
 * that merely shares its prefix, or the workspace root itself (which is not a
 * file in it). A caller supplies its own fallback for null, so this function
 * never guesses a relative path it did not derive.
 */
export function toWorkspaceRel(workspace: string, abs: string): string | null {
	if (!workspace || !abs) return null;
	const root = workspace.replace(/[/\\]+$/, '');
	if (!abs.startsWith(root)) return null;
	const rest = abs.slice(root.length);
	// A separator boundary is what distinguishes a child from a sibling whose name
	// merely starts with the workspace's; an exact match is the root itself.
	if (!/^[/\\]/.test(rest)) return null;
	return rest.replace(/^[/\\]+/, '') || null;
}
