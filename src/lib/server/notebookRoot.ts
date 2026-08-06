/**
 * Notebook code roots — the filesystem half (see `$lib/notebookRoot` for the
 * pure rules and the model).
 *
 * WHAT A ROOT CHANGES — exactly two bindings, both already parameterised on a
 * path, so this is a pure superset of the single-root behavior:
 *
 *   1. The kernel process's working directory. `getKernel` sends the root as the
 *      `path` field of the kernel-start request; jupyter_server resolves it under
 *      its `root_dir` (= the workspace) via `cwd_for_path` and spawns the kernel
 *      there. A notebook with no root sends no `path` at all, so the kernel keeps
 *      inheriting the sidecar's cwd exactly as before.
 *   2. The `sys.path` entry Cellar injects at startup (`projectRootAddCode`).
 *
 * WHAT STAYS WORKSPACE-SCOPED (do not "extend" a root into these): the file
 * tree, git status/decorations/blame, search, checkpoints, the UI-state store,
 * the `.cellar/` runtime + harness config, the instance registry, and the
 * interpreter — one venv per instance, unaffected by any notebook's root.
 *
 * WHY EXISTENCE IS CHECKED HERE, and why a bad root REFUSES rather than degrades:
 * jupyter_server's `cwd_for_path` walks UP to `root_dir` when the path is not a
 * directory, so a stale or misspelled root would silently start the kernel in the
 * workspace — the notebook would look connected to the tree under review while
 * running the wrong code, which is precisely the failure this feature exists to
 * prevent. So a declared-but-unusable root throws with a message naming the path
 * and the fix, and the run fails loudly instead of quietly answering from the
 * wrong checkout.
 *
 * WHAT "INSIDE THE WORKSPACE" MEANS HERE, stated exactly: `resolveInWorkspace` is
 * a LEXICAL prefix check with no `realpathSync`, so it refuses an absolute path
 * and a `..` traversal by name - and a root declared as a SYMLINK pointing outside
 * the workspace resolves, since `statSync` follows it. That narrowing is ACCEPTED,
 * not an oversight, and must not be "fixed" here: the same lexical guard is what
 * the file tree and `/api/fs/file` resolve through, so such a symlink already
 * reads outside the workspace everywhere else - making a code root uniquely
 * stricter than every other path in the app would be inconsistent, and widening
 * the guard app-wide is a separate task. Do NOT reach for `realpathSync` on the
 * root alone: on macOS a `mkdtemp` workspace lives under `/tmp` -> `/private/tmp`,
 * so realpathing one side and not the other refuses legitimate setups (real users
 * and the e2e harness both). The exposure is bounded: the picker cannot offer one
 * (`readdirSync` dirents report a symlink as `isDirectory() === false`, so
 * `listWorkspaceRoots` never enumerates it), it takes a hand-edited
 * `metadata.cellar.root` or an explicit MCP call, and the kernel executes
 * arbitrary user code regardless - so a symlinked root grants nothing a cell
 * could not already do.
 */
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { workspaceRoot, resolveInWorkspace } from './fstree';
import { getNotebookRoot } from './notebook';
import { NotebookRootError, ROOTS_DIR, normalizeRootPath } from '../notebookRoot';

/** A notebook's resolved root: the declared workspace-relative path + its absolute dir. */
export interface ResolvedRoot {
	/** Canonical workspace-relative path, e.g. `roots/pr-482`. Also the jupyter API path. */
	rel: string;
	/** Absolute directory the kernel is rooted at. */
	dir: string;
}

/**
 * Resolve a declared root to an absolute directory, refusing anything that is not
 * a usable directory inside the workspace.
 *
 * Layered deliberately: the pure rules reject the wrong SHAPE with a message that
 * explains what a root is, `resolveInWorkspace` (unchanged, never widened) is
 * still the authority on the boundary, and only then is the filesystem consulted.
 * Returns null when the declaration means "the workspace root" (absent/empty).
 */
export function resolveRootDir(raw: string | null | undefined): ResolvedRoot | null {
	const rel = normalizeRootPath(raw);
	if (!rel) return null;
	let dir: string;
	try {
		dir = resolveInWorkspace(rel);
	} catch {
		// The shared guard's own message ("path escapes workspace") is correct but
		// says nothing about roots; restate it in this feature's vocabulary.
		throw new NotebookRootError(
			`A notebook root must stay inside the workspace; ${JSON.stringify(rel)} escapes it. Create the root inside the workspace (e.g. \`git worktree add ${ROOTS_DIR}/pr-482 <branch>\`).`
		);
	}
	if (dir === resolve(workspaceRoot())) {
		// Reachable only via a value the normalizer accepted that still resolves to
		// the workspace itself; that is the same thing as declaring no root.
		return null;
	}
	let stat;
	try {
		stat = statSync(dir);
	} catch {
		throw new NotebookRootError(
			`Notebook root ${JSON.stringify(rel)} does not exist in this workspace. Create it (e.g. \`git worktree add ${rel} <branch>\`) or clear the notebook's root to run against the workspace.`
		);
	}
	if (!stat.isDirectory()) {
		throw new NotebookRootError(
			`Notebook root ${JSON.stringify(rel)} is a file, not a directory. A root is a directory the kernel runs in — normally a git worktree.`
		);
	}
	return { rel, dir };
}

/**
 * The resolved root for a notebook, or null when it declares none (the workspace
 * — today's behavior). Throws `NotebookRootError` when a root IS declared but is
 * unusable; see the module header for why that is a refusal, not a fallback.
 *
 * `nb` is any form `notebook.ts` accepts (absolute, workspace-relative, or
 * omitted for the active notebook).
 */
export function notebookRoot(nb?: string | null): ResolvedRoot | null {
	return resolveRootDir(getNotebookRoot(nb));
}
