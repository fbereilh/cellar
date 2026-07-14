/**
 * Cellar — git-ignored path matching for the file tree (browser-safe, pure).
 *
 * The server (`git status --ignored=matching`, see `$lib/server/git`) hands the
 * sidebar a flat list of git-ignored workspace-relative paths: a wholly-ignored
 * directory as one entry WITH a trailing slash (`build/`), individually-ignored
 * files with no slash (`secret.txt`). `makeIgnoredMatcher` turns that list into
 * a predicate the recursive `FileTreeNode` consults per node to grey ignored
 * entries VS Code-style, without a git process per node.
 *
 * A node counts as ignored when it matches an entry exactly OR sits under an
 * ignored directory prefix — so a gitignored `build/` greys the folder AND
 * everything beneath it.
 */

/**
 * Build a predicate `(path) => boolean` over a list of git-ignored paths.
 * `path` is the node's workspace-relative path (no trailing slash, as the file
 * tree stores it); the matcher handles the directory-vs-file distinction itself.
 */
export function makeIgnoredMatcher(ignored: string[] | undefined | null): (path: string) => boolean {
	if (!ignored || ignored.length === 0) return () => false;
	const exactFiles = new Set<string>();
	const dirs: string[] = []; // ignored directory prefixes (trailing slash kept)
	for (const raw of ignored) {
		if (!raw) continue;
		if (raw.endsWith('/')) dirs.push(raw);
		else exactFiles.add(raw);
	}
	return (path: string): boolean => {
		if (!path) return false;
		if (exactFiles.has(path)) return true; // an ignored file
		if (dirs.includes(path + '/')) return true; // the ignored directory itself
		for (const d of dirs) if (path.startsWith(d)) return true; // inside one
		return false;
	};
}
