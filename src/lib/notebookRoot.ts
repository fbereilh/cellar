/**
 * Notebook code roots — the pure, browser-safe half.
 *
 * A **root** is a directory INSIDE the workspace (normally a git worktree created
 * there, e.g. `git worktree add roots/pr-482 origin/some-branch`) that a notebook
 * declares as the place its kernel resolves code from:
 *
 *     notebook.metadata.cellar.root = "roots/pr-482"
 *
 * Absent or empty means the workspace root — today's behavior, byte for byte. A
 * declared root changes EXACTLY two bindings, both already parameterised on a
 * path: the kernel process's working directory, and the `sys.path` entry Cellar
 * injects at startup. Everything else stays workspace-scoped (see
 * `server/notebookRoot.ts` for the surface split).
 *
 * Roots living inside the workspace is load-bearing, not a convenience: the
 * workspace stays the single `root_dir` and the single security boundary, so
 * `resolveInWorkspace`, the file tree, git, checkpoints, the UI-state store and
 * the instance registry all keep working unchanged. A root outside the workspace
 * is REFUSED — do not widen the path guards to admit one.
 *
 * This module holds only rules that need no filesystem, so they are cheap to test
 * and can be shared with the browser: normalization of the declared value, and
 * the refusal messages. Existence / directory-ness / inside-the-workspace is
 * decided in `server/notebookRoot.ts`, which is the only place that touches fs.
 */

/**
 * The conventional directory roots live in. Deliberately NOT dot-prefixed:
 * `buildTree` skips dot-prefixed entries, so a `.roots/` would be invisible in
 * the file explorer, and the whole point of the review workflow is that the
 * files under review are browsable. A root may live anywhere inside the
 * workspace — this is the convention `list_roots` enumerates and the UI offers,
 * not a constraint.
 */
export const ROOTS_DIR = 'roots';

/**
 * One code root of the workspace, as the picker and `list_roots` describe it.
 * Declared here (not server-side) so the browser and the server share ONE shape:
 * `server/notebook-root-actions.ts` builds exactly this.
 */
export interface WorkspaceRootOption {
	/** Canonical workspace-relative path, e.g. `roots/pr-482`. */
	path: string;
	/** Absolute directory. */
	absolute: string;
	/** False for a root a notebook declares that no longer exists on disk. */
	exists: boolean;
	/** Branch (or short SHA when detached) checked out there, when it is a git tree. */
	branch: string | null;
	/** Short commit SHA, when it is a git tree. */
	commit: string | null;
	/** True when the entry came only from a notebook's declaration, not from `roots/`. */
	declared: boolean;
	/** Workspace-relative notebooks currently declaring this root. */
	notebooks: string[];
}

/** Thrown for a declared root that is not a usable workspace-relative directory. */
export class NotebookRootError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'NotebookRootError';
	}
}

/**
 * Normalize a declared root to a canonical workspace-relative path, or null when
 * it means "the workspace root" (absent, empty, `.`).
 *
 * Rejects — with a message naming the value and the rule — anything that is not
 * a workspace-relative path: an absolute path, a `~` path, and any `..` segment.
 * Those are refused HERE rather than left to the fs layer so the message can say
 * what a root is, instead of the generic "path escapes workspace" the shared
 * guard raises. The guard still runs afterwards; this is a better error, never a
 * replacement for it.
 *
 * Normalization is deliberately narrow (it must be idempotent, since the result
 * is what gets persisted and later re-read): separators unified to `/`, `.`
 * segments and repeated/trailing separators dropped.
 */
export function normalizeRootPath(raw: string | null | undefined): string | null {
	const value = (raw ?? '').trim();
	if (!value) return null;
	if (value.startsWith('~')) {
		throw new NotebookRootError(
			`A notebook root must be a workspace-relative directory (e.g. "${ROOTS_DIR}/pr-482"); ${JSON.stringify(value)} is a home-relative path. Roots live inside the workspace.`
		);
	}
	// Unify separators before any structural test, so a Windows-style value is
	// judged by the same rules rather than read as one opaque segment.
	const unified = value.replace(/\\/g, '/');
	if (unified.startsWith('/') || /^[A-Za-z]:\//.test(unified)) {
		throw new NotebookRootError(
			`A notebook root must be a workspace-relative directory (e.g. "${ROOTS_DIR}/pr-482"); ${JSON.stringify(value)} is an absolute path. Roots live inside the workspace.`
		);
	}
	const segments = unified.split('/').filter((s) => s !== '' && s !== '.');
	if (segments.includes('..')) {
		throw new NotebookRootError(
			`A notebook root must stay inside the workspace; ${JSON.stringify(value)} escapes it with "..". Create the root inside the workspace (e.g. \`git worktree add ${ROOTS_DIR}/pr-482 <branch>\`).`
		);
	}
	// Every segment was `.` (or the value was `./`): that IS the workspace root,
	// which is the same thing as declaring no root at all.
	return segments.length ? segments.join('/') : null;
}

/**
 * The refusal for a root declared on a `.py` (jupytext / Databricks source)
 * notebook.
 *
 * A `.py` notebook is written back through jupytext / the Databricks converter,
 * which rebuilds the file from its CELLS: it carries no notebook-level metadata
 * on disk at all. So the declaration would live only in memory and be gone on the
 * next reload, after which the notebook would silently run at the workspace root
 * while still looking like the tree under review — the exact silent degrade
 * `resolveRootDir` refuses everywhere else. Refused by name instead.
 *
 * CLEARING a root on a `.py` notebook is always allowed: it can only remove
 * state, never strand it.
 */
export function textNotebookRootError(rel: string): NotebookRootError {
	return new NotebookRootError(
		`Cannot set a code root on a .py notebook: ${JSON.stringify(rel)} could not survive a reload, because a .py (jupytext / Databricks source) notebook stores no notebook metadata on disk — it would silently run at the workspace root instead. Convert it to .ipynb first, or leave it running at the workspace root. Clearing a root is still allowed.`
	);
}

/**
 * True when two declared roots mean the same thing. Both sides are normalized
 * first, so `"./roots/a/"` and `"roots/a"` are one root and re-declaring it
 * costs the user no kernel restart.
 */
export function sameRoot(a: string | null | undefined, b: string | null | undefined): boolean {
	const norm = (v: string | null | undefined) => {
		try {
			return normalizeRootPath(v);
		} catch {
			// An unusable value can only equal itself verbatim; comparing it to a
			// normalized sibling would claim a match the fs layer is about to refuse.
			return (v ?? '').trim() || null;
		}
	};
	return norm(a) === norm(b);
}
