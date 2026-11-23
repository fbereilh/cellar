/**
 * The file tree's folder EXPANSION state, addressable by path, and the one
 * "reveal this file" rule built on it.
 *
 * Expansion used to be a `let open = $state(false)` inside every
 * `FileTreeNode`, which a parent cannot drive: revealing `a/b/c.md` means opening
 * `a` AND `a/b`, and the component that knows the target (the sidebar) owns none
 * of the nodes that would have to open. So the sidebar now owns ONE set of
 * expanded directory paths and every row reads its own membership from it
 * (through the `cellarFileOps` context). The rules that set is subject to live
 * here, pure, because vitest runs without the SvelteKit plugin: a rule left in
 * a component cannot be driven at all.
 *
 * The set is an immutable value - every change returns a NEW set (or the SAME
 * one when nothing changed), so the sidebar can assign it to a `$state` and the
 * rows re-derive, and a no-op writes nothing.
 */

import type { TreeNode } from '$lib/server/fstree';

/**
 * The cross-project user setting for revealing the active tab's file in the
 * tree (VS Code's `explorer.autoReveal`). A person-level preference - how this
 * person browses - so it lives in the `~/.cellar/` store beside the others.
 *
 * Default ON: read through `getUserSettingDefaultOn`, so only a stored literal
 * `false` turns it off. The toggle deletes the key when it is switched back on,
 * so an untouched install stores nothing.
 */
export const TREE_AUTO_REVEAL_KEY = 'cellar-tree-auto-reveal';

/**
 * Every folder that has to be open for `path` to be visible, outermost first
 * (`a/b/c.md` -> `['a', 'a/b']`). A root-level entry needs none.
 */
export function ancestorDirs(path: string): string[] {
	const parts = path.split('/').filter(Boolean);
	const out: string[] = [];
	for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'));
	return out;
}

/**
 * The node at `path`, or null. Walks only the branch the path names (each level
 * matched by exact path), so a lookup costs the depth of the path, not the size
 * of the tree.
 */
export function findTreeNode(nodes: readonly TreeNode[] | undefined, path: string): TreeNode | null {
	if (!path || !nodes) return null;
	let level: readonly TreeNode[] | undefined = nodes;
	for (const dir of [...ancestorDirs(path), path]) {
		const hit: TreeNode | undefined = level?.find((n) => n.path === dir);
		if (!hit) return null;
		if (dir === path) return hit;
		if (hit.type !== 'dir') return null;
		level = hit.children;
	}
	return null;
}

/** `expanded` with `path` opened or closed. The same set back when nothing changes. */
export function setExpanded(expanded: ReadonlySet<string>, path: string, open: boolean): ReadonlySet<string> {
	if (expanded.has(path) === open) return expanded;
	const next = new Set(expanded);
	if (open) next.add(path);
	else next.delete(path);
	return next;
}

/**
 * `expanded` with every ancestor of `path` opened - the expansion half of a
 * reveal. Opens, never closes: a sibling folder the user expanded stays so.
 */
export function expandAncestors(expanded: ReadonlySet<string>, path: string): ReadonlySet<string> {
	const missing = ancestorDirs(path).filter((d) => !expanded.has(d));
	if (!missing.length) return expanded;
	const next = new Set(expanded);
	for (const d of missing) next.add(d);
	return next;
}

/**
 * `expanded` after a folder (or file) moved from `from` to `to`: every
 * expanded path at or under `from` follows it, so renaming or moving an open
 * folder leaves it - and its open subfolders - open at the new name. Nothing
 * else moves. The same set back when nothing was under `from`.
 */
export function remapExpanded(expanded: ReadonlySet<string>, from: string, to: string): ReadonlySet<string> {
	if (!from || from === to) return expanded;
	const prefix = from + '/';
	let changed = false;
	const next = new Set<string>();
	for (const p of expanded) {
		if (p === from) {
			next.add(to);
			changed = true;
		} else if (p.startsWith(prefix)) {
			next.add(to + '/' + p.slice(prefix.length));
			changed = true;
		} else next.add(p);
	}
	return changed ? next : expanded;
}

/**
 * `expanded` restricted to the folders `nodes` really contains. Applied on every
 * tree load, so a deleted folder's entry cannot linger and pop a LATER folder of
 * the same name open, and the set never grows past what is on disk.
 */
export function pruneExpanded(expanded: ReadonlySet<string>, nodes: readonly TreeNode[] | undefined): ReadonlySet<string> {
	if (!expanded.size) return expanded;
	const dirs = new Set<string>();
	const walk = (list: readonly TreeNode[] | undefined) => {
		for (const n of list ?? []) {
			if (n.type !== 'dir') continue;
			dirs.add(n.path);
			walk(n.children);
		}
	};
	walk(nodes);
	let changed = false;
	const next = new Set<string>();
	for (const p of expanded) {
		if (dirs.has(p)) next.add(p);
		else changed = true;
	}
	return changed ? next : expanded;
}
