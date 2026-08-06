/**
 * Notebook code roots — the actions that pair a declaration with the kernel.
 *
 * `notebookRoot.ts` decides what a root IS (and refuses what it is not);
 * `notebook.ts` records the declaration. Neither may reach the kernel, so this
 * module is the one place that pairs them — the REST route and the MCP tool both
 * go through it, exactly as `jupytext-actions.ts` sits above `jupytext.ts`.
 *
 * WHY CHANGING A ROOT FREES THE KERNEL RATHER THAN RESTARTING IT: a process's cwd
 * is fixed when it spawns, and `restart()` reuses the same argv and cwd — so a
 * plain restart would re-inject the new root onto `sys.path` while the process
 * still ran in the old directory, which is worse than not applying it at all. The
 * kernel is therefore torn down (the existing `rebindKernel(nb)` path, the same
 * one a venv change uses); the next run lazily starts a fresh process at the new
 * root. Teardown bumps the session epoch and publishes `kernel:shutdown`, so
 * every cell honestly reads "not run this session" — the namespace really is
 * gone, and the result says so.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { workspaceRoot } from './fstree';
import { getNotebookRoot, setNotebookRoot, resolveNotebookPath, workspaceRelative, listOpenNotebookPaths } from './notebook';
import { resolveRootDir } from './notebookRoot';
import { rebindKernel } from './kernel';
import { gitRefAt } from './git';
import { ROOTS_DIR, normalizeRootPath, sameRoot } from '../notebookRoot';
import type { WorkspaceRootOption } from '../notebookRoot';

/** Outcome of declaring (or clearing) a notebook's code root. */
export interface SetRootResult {
	/** The root now in force: a workspace-relative path, or null for the workspace. */
	root: string | null;
	/** Absolute directory the kernel will run in. */
	absolute: string;
	/** False when the declaration already said this — nothing was written or torn down. */
	changed: boolean;
	/** True when this notebook's kernel was freed so the next run picks up the new root. */
	kernel_restarted: boolean;
	/** True whenever a kernel was freed: its variables and imports are gone. */
	namespace_cleared: boolean;
}

/**
 * Declare (or clear, with null/'') a notebook's code root and bring its kernel in
 * line.
 *
 * The root is RESOLVED FIRST — an absolute path, a `..` escape, a missing
 * directory or a file all throw here — so a refusal never writes a declaration
 * into the user's `.ipynb` nor frees a working kernel. An unchanged declaration
 * is a genuine no-op: nothing is persisted, and the kernel keeps its namespace
 * (re-declaring the root you are already on must not cost you your variables).
 */
export async function setNotebookRootAndRestart(
	root: string | null | undefined,
	nb?: string | null,
	originId?: string | null
): Promise<SetRootResult> {
	const abs = resolveNotebookPath(nb ?? undefined);
	// Throws (NotebookRootError) on anything that is not a usable directory inside
	// the workspace, BEFORE the document or the kernel is touched.
	const resolved = resolveRootDir(root);
	const next = resolved?.rel ?? null;
	const current = getNotebookRoot(abs);
	if (sameRoot(current, next)) {
		return {
			root: current,
			absolute: resolved?.dir ?? resolve(workspaceRoot()),
			changed: false,
			kernel_restarted: false,
			namespace_cleared: false
		};
	}
	setNotebookRoot(next, abs, originId);
	// Only a notebook that HAS a kernel loses one; a notebook that never ran simply
	// starts at the new root on its first run. `rebindKernel` reports how many it
	// actually freed, which is the honest source for the two flags below — asking
	// `kernelStatus` first would read a kernel still STARTING as "not started" and
	// under-report a namespace that really was cleared.
	const { rebound } = await rebindKernel(abs);
	return {
		root: next,
		absolute: resolved?.dir ?? resolve(workspaceRoot()),
		changed: true,
		kernel_restarted: rebound > 0,
		namespace_cleared: rebound > 0
	};
}

/** One entry of `listWorkspaceRoots()` — the shape the picker and `list_roots` share. */
export type WorkspaceRootInfo = WorkspaceRootOption;

/**
 * Enumerate the workspace's code roots: every immediate subdirectory of the
 * conventional `roots/` directory, plus any root a notebook declares that lives
 * elsewhere — so a hand-set root is still discoverable, and a declaration whose
 * directory has since been removed is reported with `exists:false` rather than
 * silently missing (that is the state a run is about to refuse, so it must be
 * visible here).
 *
 * Which notebooks declare which root is read from the LIVE documents, not from a
 * walk of the workspace: answering it from disk would mean parsing every `.ipynb`
 * every time a picker opens or an agent asks.
 */
export async function listWorkspaceRoots(): Promise<WorkspaceRootInfo[]> {
	const ws = resolve(workspaceRoot());
	const fromConvention = new Set<string>();
	try {
		for (const entry of readdirSync(join(ws, ROOTS_DIR), { withFileTypes: true })) {
			// Dot-prefixed entries are invisible in the file tree, so they are not
			// offered as roots either (see ROOTS_DIR on why the convention is visible).
			if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
			fromConvention.add(`${ROOTS_DIR}/${entry.name}`);
		}
	} catch {
		// No `roots/` directory: nothing conventional to list. Declared roots below
		// are still reported, so a workspace that never adopts the convention works.
	}
	const byRoot = new Map<string, string[]>();
	for (const nbAbs of listOpenNotebookPaths()) {
		let rel: string | null;
		try {
			// Both of these can legitimately refuse: a document left over from another
			// workspace is not a notebook of THIS one, and an unusable declaration names
			// no root of it. Neither is a reason to fail the whole listing.
			rel = normalizeRootPath(getNotebookRoot(nbAbs));
		} catch {
			continue;
		}
		if (!rel) continue;
		const list = byRoot.get(rel) ?? [];
		list.push(workspaceRelative(nbAbs));
		byRoot.set(rel, list);
	}
	const rels = [...new Set([...fromConvention, ...byRoot.keys()])].sort();
	return Promise.all(
		rels.map(async (rel) => {
			const absolute = join(ws, ...rel.split('/'));
			const exists = existsSync(absolute) && statSync(absolute).isDirectory();
			const ref = exists ? await gitRefAt(absolute) : null;
			return {
				path: rel,
				absolute,
				exists,
				branch: ref?.branch ?? null,
				commit: ref?.commit ?? null,
				declared: !fromConvention.has(rel),
				notebooks: (byRoot.get(rel) ?? []).sort()
			};
		})
	);
}
