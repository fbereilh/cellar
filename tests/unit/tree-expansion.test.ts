import { describe, it, expect } from 'vitest';
import {
	ancestorDirs,
	findTreeNode,
	setExpanded,
	expandAncestors,
	remapExpanded,
	pruneExpanded
} from '../../src/lib/treeExpansion';
import { hydrateUserSettings, getUserSettingDefaultOn } from '../../src/lib/userSettings';
import type { TreeNode } from '../../src/lib/server/fstree';

/**
 * The file tree's path-addressed expansion state and the reveal rule
 * (`$lib/treeExpansion`). The wiring - a tab click reaching the sidebar and the
 * rows re-deriving - is pinned by `tests/e2e/file-tree-reveal.spec.ts`.
 */

const dir = (path: string, children: TreeNode[] = []): TreeNode => ({
	name: path.split('/').pop()!,
	path,
	type: 'dir',
	children
});
const file = (path: string): TreeNode => ({ name: path.split('/').pop()!, path, type: 'file' });

const TREE: TreeNode[] = [
	dir('a', [dir('a/b', [dir('a/b/c', [file('a/b/c/deep.md')]), file('a/b/mid.md')])]),
	dir('ab', [file('ab/x.md')]),
	file('top.md')
];

describe('ancestorDirs', () => {
	it('lists every folder above a nested path, outermost first', () => {
		expect(ancestorDirs('a/b/c/deep.md')).toEqual(['a', 'a/b', 'a/b/c']);
	});
	it('needs no folder for a root-level entry', () => {
		expect(ancestorDirs('top.md')).toEqual([]);
		expect(ancestorDirs('')).toEqual([]);
	});
});

describe('findTreeNode', () => {
	it('finds a nested file and a folder', () => {
		expect(findTreeNode(TREE, 'a/b/c/deep.md')?.type).toBe('file');
		expect(findTreeNode(TREE, 'a/b')?.type).toBe('dir');
		expect(findTreeNode(TREE, 'top.md')?.name).toBe('top.md');
	});
	it('answers null for a path the tree does not hold', () => {
		expect(findTreeNode(TREE, 'a/b/c/missing.md')).toBeNull();
		expect(findTreeNode(TREE, 'nope/deep.md')).toBeNull();
		expect(findTreeNode(TREE, '')).toBeNull();
		expect(findTreeNode(undefined, 'top.md')).toBeNull();
	});
	it('does not descend through a FILE named like a folder', () => {
		expect(findTreeNode(TREE, 'top.md/inner')).toBeNull();
	});
	it('matches whole path segments, never a prefix (`ab` is not under `a`)', () => {
		expect(findTreeNode(TREE, 'ab/x.md')?.path).toBe('ab/x.md');
		expect(findTreeNode(TREE, 'a/x.md')).toBeNull();
	});
});

describe('setExpanded', () => {
	it('opens and closes one folder, returning the SAME set when nothing changes', () => {
		const empty: ReadonlySet<string> = new Set();
		const opened = setExpanded(empty, 'a', true);
		expect([...opened]).toEqual(['a']);
		expect(setExpanded(opened, 'a', true)).toBe(opened);
		expect(setExpanded(opened, 'a', false).has('a')).toBe(false);
		expect(setExpanded(empty, 'a', false)).toBe(empty);
	});
});

describe('expandAncestors (the reveal)', () => {
	it('opens EVERY collapsed ancestor of a nested file', () => {
		expect([...expandAncestors(new Set(), 'a/b/c/deep.md')].sort()).toEqual(['a', 'a/b', 'a/b/c']);
	});
	it('only ever opens: a sibling folder the user expanded stays open', () => {
		const next = expandAncestors(new Set(['ab']), 'a/b/c/deep.md');
		expect(next.has('ab')).toBe(true);
		expect(next.has('a/b/c')).toBe(true);
	});
	it('is a no-op (same set) when everything is already open or the file is at the root', () => {
		const open = new Set(['a', 'a/b', 'a/b/c']);
		expect(expandAncestors(open, 'a/b/c/deep.md')).toBe(open);
		expect(expandAncestors(open, 'top.md')).toBe(open);
	});
});

describe('remapExpanded', () => {
	it('carries an open folder and its open subfolders to the new name', () => {
		const next = remapExpanded(new Set(['a', 'a/b', 'ab']), 'a', 'renamed');
		expect([...next].sort()).toEqual(['ab', 'renamed', 'renamed/b']);
	});
	it('follows a move into another folder', () => {
		expect([...remapExpanded(new Set(['a/b']), 'a/b', 'ab/b')]).toEqual(['ab/b']);
	});
	it('leaves everything else alone and returns the same set when nothing was under `from`', () => {
		const s = new Set(['ab']);
		expect(remapExpanded(s, 'a', 'z')).toBe(s);
		expect(remapExpanded(s, 'ab', 'ab')).toBe(s);
	});
});

describe('pruneExpanded', () => {
	it('drops a folder the tree no longer holds, keeping the rest', () => {
		const next = pruneExpanded(new Set(['a', 'a/b', 'gone', 'a/b/gone']), TREE);
		expect([...next].sort()).toEqual(['a', 'a/b']);
	});
	it('drops a path that is now a FILE', () => {
		expect([...pruneExpanded(new Set(['top.md']), TREE)]).toEqual([]);
	});
	it('returns the same set when nothing is stale', () => {
		const s = new Set(['a', 'a/b/c']);
		expect(pruneExpanded(s, TREE)).toBe(s);
	});
});

describe('getUserSettingDefaultOn (the reveal switch)', () => {
	it('is ON unless the store holds a literal false', () => {
		hydrateUserSettings({});
		expect(getUserSettingDefaultOn('k')).toBe(true);
		hydrateUserSettings({ k: false });
		expect(getUserSettingDefaultOn('k')).toBe(false);
		for (const junk of ['false', 0, null, {}, true]) {
			hydrateUserSettings({ k: junk });
			expect(getUserSettingDefaultOn('k')).toBe(true);
		}
	});
});
