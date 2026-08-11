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
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { workspaceRoot } from './fstree';
import {
	getNotebookRoot,
	setNotebookRoot,
	resolveNotebookPath,
	workspaceRelative,
	listOpenNotebookPaths,
	isTextNotebook
} from './notebook';
import { resolveRootDir, worktreeDeclaration } from './notebookRoot';
import { rebindKernel } from './kernel';
import { gitRefAt, listWorktreesAt } from './git';
import { configureAdoptedWorktree, type WorktreeAgentConfig } from './worktree-agent-config';
import { ROOTS_DIR, normalizeRootPath, sameRoot, textNotebookRootError } from '../notebookRoot';
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
	/**
	 * Agent config written INTO the root, for an external worktree only. Absent
	 * when nothing was addressed (a workspace-internal root, or the setting off) —
	 * so an ordinary root change is unchanged. A failure is reported HERE rather
	 * than thrown: agent wiring may never abort a root change.
	 */
	agent_config?: WorktreeAgentConfig;
}

/**
 * Declare (or clear, with null/'') a notebook's code root and bring its kernel in
 * line.
 *
 * The root is RESOLVED FIRST — an absolute path, a `..` escape, a missing
 * directory, a file, or a `.py` notebook that could not keep the declaration all
 * throw here — so a refusal never writes a declaration into the user's `.ipynb`
 * nor frees a working kernel. An unchanged declaration is a genuine no-op:
 * nothing is persisted, and the kernel keeps its namespace (re-declaring the root
 * you are already on must not cost you your variables).
 */
export async function setNotebookRootAndRestart(
	root: string | null | undefined,
	nb?: string | null,
	originId?: string | null
): Promise<SetRootResult> {
	const abs = resolveNotebookPath(nb ?? undefined);
	// A `.py` notebook stores no notebook metadata, so a root declared on one could
	// not survive a reload. Refused BEFORE the directory is resolved, so the message
	// names the real reason rather than reporting a perfectly good directory as the
	// problem. Clearing stays allowed: it can only remove state, never strand it.
	const declared = normalizeRootPath(root);
	if (declared && isTextNotebook(abs)) throw textNotebookRootError(declared);
	// Throws (NotebookRootError) on anything that is not a usable directory inside
	// the workspace, BEFORE the document or the kernel is touched.
	const resolved = resolveRootDir(root);
	const next = resolved?.rel ?? null;
	const current = getNotebookRoot(abs);
	if (isSameDeclaredRoot(current, resolved)) {
		return {
			root: current,
			absolute: resolved?.dir ?? resolve(workspaceRoot()),
			changed: false,
			kernel_restarted: false,
			namespace_cleared: false
		};
	}
	setNotebookRoot(next, abs, originId);
	// Only for a root that really is an external worktree, and only once it has
	// been ADOPTED (this line is past every refusal, so a rejected declaration
	// never writes into a checkout). Never throws — see worktree-agent-config.ts.
	const agent_config = resolved?.kind === 'worktree' ? configureAdoptedWorktree(resolved.dir) : undefined;
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
		namespace_cleared: rebound > 0,
		...(agent_config ? { agent_config } : {})
	};
}

/**
 * Whether a notebook already runs at the root now being declared — the test that
 * decides a genuine no-op (no write, no kernel teardown, no lost namespace).
 *
 * Compares the resolved DIRECTORIES when both sides resolve, because one
 * directory has two legal spellings: `/Users/me/code/sibling` and `../sibling`
 * name the same checkout, and re-declaring the root you are already on in the
 * other form must not cost you your variables. `sameRoot` cannot answer that — it
 * is pure and browser-safe, so it has no workspace to resolve against — and it
 * remains the fallback for the case where it IS the right answer: a declaration
 * that no longer resolves can only equal itself verbatim, which is exactly its
 * own doctrine.
 */
function isSameDeclaredRoot(current: string | null, resolved: { dir: string; rel: string } | null): boolean {
	if (!current || !resolved) return !current && !resolved;
	try {
		const now = resolveRootDir(current);
		if (now) return now.dir === resolved.dir;
	} catch {
		// The stored declaration is unusable, so it names no directory to compare;
		// fall through to the text rule below.
	}
	return sameRoot(current, resolved.rel);
}

/** One entry of `listWorkspaceRoots()` — the shape the picker and `list_roots` share. */
export type WorkspaceRootInfo = WorkspaceRootOption;

/** `realpathSync` where possible, else the path itself — the identity key for dedupe. */
function realpathOrSelf(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

/**
 * Enumerate the workspace's code roots, from THREE sources:
 *
 *   1. `roots/`      — the convention: every immediate subdirectory.
 *   2. declarations  — any root a live notebook points at, wherever it lives, so
 *                      a hand-set root is discoverable and one whose directory has
 *                      since been removed is reported `exists:false` rather than
 *                      silently missing (that is the state a run is about to
 *                      refuse, so it must be visible here).
 *   3. `git worktree list` — every OTHER registered worktree of the workspace's
 *                      own repo, including siblings outside the workspace.
 *
 * The workspace's own checkout is EXCLUDED from (3): `git worktree list` includes
 * it, and offering it would duplicate the picker's existing "workspace root
 * (default)" entry.
 *
 * DEDUPE IS BY REALPATH, not by string: a worktree created under `roots/` appears
 * in both (1) and (3), and on macOS the two spellings differ anyway (`/tmp` vs
 * `/private/tmp`). Where both forms exist the workspace-relative declaration WINS
 * — `roots/pr-1` is the better thing to persist than `..`-gymnastics, and it keeps
 * existing notebooks' stored values stable.
 *
 * Being listed is NOT being authorised: `resolveRootDir` re-verifies on every
 * resolve, so a worktree removed after this listing was taken is still refused.
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
			if (entry.name.startsWith('.')) continue;
			// A SYMLINK to a directory counts. Such a root already resolves and already
			// runs (the guard is lexical and `statSync` follows the link — see
			// server/notebookRoot.ts, where that narrowing is stated and accepted), so
			// the dirent test alone made the picker the one surface that could not see a
			// root the rest of the app happily uses. `statSync` follows, `isDirectory()`
			// on the dirent does not.
			if (!entry.isDirectory() && !isDirectory(join(ws, ROOTS_DIR, entry.name))) continue;
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

	// (1) + (2): everything named workspace-relative-ly, in the form it is declared.
	const rels = [...new Set([...fromConvention, ...byRoot.keys()])].sort();
	const seen = new Set(rels.map((rel) => realpathOrSelf(absoluteOf(rel, ws))));
	seen.add(realpathOrSelf(ws));

	// (3): registered worktrees not already covered above. Their branch/HEAD come
	// straight from the porcelain stanza, so a detected root costs no extra `git`
	// spawn at all — `gitRefAt` below is only paid by the declared/convention ones.
	const detected = listWorktreesAt(ws)
		.filter((w) => !w.bare)
		.filter((w) => {
			const real = realpathOrSelf(w.path);
			if (seen.has(real)) return false;
			seen.add(real);
			return true;
		})
		.map((w) => {
			// The lexical declaration for a realpath'd path git printed — the
			// two-namespace rule, owned by `notebookRoot.ts` so the picker and the
			// sidebar route cannot end up with different spellings of one worktree.
			const rel = worktreeDeclaration(w.path);
			// Then validated through the ONE resolver, so the picker can only ever offer
			// a declaration that really resolves — and `rel` comes back canonicalized by
			// the same code that will later read it. A worktree that is registered but
			// gone (`prunable`) throws here and is simply not offered: nothing declares
			// it, so unlike a broken DECLARATION there is nothing to see and clear.
			try {
				const resolved = resolveRootDir(rel);
				if (!resolved) return null;
				return {
					path: resolved.rel,
					absolute: resolved.dir,
					exists: true,
					// Branch and HEAD ride the porcelain stanza we already have, so a
					// detected root costs no `gitRefAt` spawns of its own.
					branch: w.branch ?? (w.head ? w.head.slice(0, 7) : null),
					commit: w.head ? w.head.slice(0, 7) : null,
					declared: false,
					notebooks: [] as string[],
					source: 'worktree' as const,
					external: resolved.kind === 'worktree'
				};
			} catch {
				return null;
			}
		})
		.filter((r): r is NonNullable<typeof r> => r !== null)
		.sort((a, b) => a.path.localeCompare(b.path));

	const named = await Promise.all(
		rels.map(async (rel) => {
			const absolute = absoluteOf(rel, ws);
			const exists = isDirectory(absolute);
			const ref = exists ? await gitRefAt(absolute) : null;
			return {
				path: rel,
				absolute,
				exists,
				branch: ref?.branch ?? null,
				commit: ref?.commit ?? null,
				declared: !fromConvention.has(rel),
				notebooks: (byRoot.get(rel) ?? []).sort(),
				source: (fromConvention.has(rel) ? 'convention' : 'declared') as 'convention' | 'declared',
				// A declared root may itself be external (a sibling worktree already in
				// use), so this is decided by the resolved path, never by the source.
				external: !isInsideWorkspace(absolute, ws)
			};
		})
	);

	// Workspace-internal roots first — they are the established convention, so a
	// workspace that has already adopted `roots/` sees no reordering of what it had
	// — then external worktrees, each group alphabetical.
	const internal = named.filter((r) => !r.external);
	const externalNamed = named.filter((r) => r.external);
	return [...internal, ...externalNamed, ...detected];
}

/**
 * The absolute directory a DECLARATION names.
 *
 * `resolve`, never `join(ws, ...rel.split('/'))`: a declaration is no longer
 * always workspace-relative — it may be `../sibling`, and a hand-edited one may
 * be absolute. `join` would fold `/somewhere/else` into `<ws>/somewhere/else`,
 * which both points at the wrong directory and reads as INSIDE the workspace,
 * mislabelling an external root as internal.
 */
function absoluteOf(rel: string, ws: string): string {
	return resolve(ws, rel);
}

/** True when `abs` exists and is a directory (symlinks followed, like the resolver). */
function isDirectory(abs: string): boolean {
	try {
		return existsSync(abs) && statSync(abs).isDirectory();
	} catch {
		return false;
	}
}

/** Lexical containment, the same rule the workspace guard applies. */
function isInsideWorkspace(abs: string, ws: string): boolean {
	return abs === ws || abs.startsWith(ws + sep);
}
