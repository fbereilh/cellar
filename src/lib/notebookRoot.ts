/**
 * Notebook code roots — the pure, browser-safe half.
 *
 * A **root** is a directory a notebook declares as the place its kernel resolves
 * code from — normally a git worktree (`git worktree add roots/pr-482 <branch>`,
 * or a sibling `git worktree add ../pr-482 <branch>`):
 *
 *     notebook.metadata.cellar.root = "roots/pr-482"
 *     notebook.metadata.cellar.root = "../winrate-model-pr398"
 *
 * Absent or empty means the workspace root — today's behavior, byte for byte. A
 * declared root changes EXACTLY two bindings, both already parameterised on a
 * path: the kernel process's working directory, and the `sys.path` entry Cellar
 * injects at startup. Everything else stays workspace-scoped (see
 * `server/notebookRoot.ts` for the surface split).
 *
 * TWO ADMISSION RULES, AND THE DIFFERENCE IS THE WHOLE DESIGN. A root inside the
 * workspace is admitted by `resolveInWorkspace` — the app-wide path guard, which
 * this feature does NOT touch and must never widen. A root OUTSIDE it is admitted
 * only by a second, strictly NARROWER rule: `git worktree list --porcelain`, run
 * in the workspace, must name that exact directory, so the admitted set is
 * authored by the user's own `git worktree add` runs against THIS repo. That gate
 * lives in `server/notebookRoot.ts` beside the guard, never inside it: the guard
 * is the authority for every FILE path in the app (the tree, `/api/fs/*`, blame,
 * the export target), and a worktree root grants no file reach whatsoever — only
 * the kernel's cwd and `sys.path` follow it.
 *
 * This module holds only rules that need no filesystem, so they are cheap to test
 * and can be shared with the browser: it therefore CLASSIFIES a declaration's
 * shape and cannot decide worktree-ness. Existence, directory-ness, containment
 * and registration are decided in `server/notebookRoot.ts`, the only place that
 * touches fs or git.
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
 * Per-workspace preference key: write Cellar's agent config (`.mcp.json`) into an
 * external worktree when a notebook ADOPTS it as a root. Default ON — see
 * `server/worktree-agent-config.ts` for what is written and for the
 * `.git/info/exclude` mitigation that keeps the user's checkout clean.
 *
 * Declared HERE, in the browser-safe half, so the Settings toggle and the server
 * that reads the preference import ONE constant instead of mirroring a literal
 * across the boundary — a mirrored key drifts silently, and the failure mode is a
 * toggle that appears to work and changes nothing.
 */
export const WORKTREE_AGENT_CONFIG_KEY = 'cellar-worktree-agent-config';

/**
 * One code root of the workspace, as the picker and `list_roots` describe it.
 * Declared here (not server-side) so the browser and the server share ONE shape:
 * `server/notebook-root-actions.ts` builds exactly this.
 */
export interface WorkspaceRootOption {
	/** Canonical declaration, e.g. `roots/pr-482` or `../winrate-model-pr398`. */
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
	/**
	 * How Cellar knows about this root: the `roots/` convention, a notebook's own
	 * declaration, or `git worktree list`.
	 */
	source: 'convention' | 'declared' | 'worktree';
	/**
	 * True when the directory is OUTSIDE the workspace (a sibling/external
	 * worktree). Carried explicitly — never inferred from a leading `..` by a
	 * caller — so every surface labels it, and nobody adopts a sibling checkout
	 * believing it sits inside the workspace.
	 */
	external: boolean;
}

/**
 * What Cellar did about agent config in an ADOPTED external worktree, as it
 * reaches a caller. Mirrors `server/worktree-agent-config.ts`'s own shape; the
 * browser cannot import that module, so the shape lives here for the same reason
 * `WorkspaceRootOption` does.
 */
export interface AgentConfigReport {
	file?: string;
	status: 'created' | 'updated' | 'already' | 'skipped';
	message?: string;
	warning?: string;
}

/**
 * The sentence a HUMAN should be shown about an adopted worktree's agent config,
 * or null when there is nothing worth saying.
 *
 * Agent wiring is REPORTED and never thrown (worktree-agent-config.ts rule 4),
 * which only means anything if a surface actually says it — so this is the ONE
 * place the wording lives, shared by the notebook's root picker and the sidebar's
 * WORKTREES block rather than written twice and drifting.
 *
 * SILENT ON SUCCESS, deliberately: `created`/`updated`/`already` is the everyday
 * outcome and needs no sentence beside the root change the user asked for. What
 * must never be silent is the case that leaves their checkout dirty — config
 * written but the ignore entry could not be arranged — and a `skipped` that
 * explains itself.
 *
 * DECIDED FROM THE STATUS AND `warning`, never from the presence of a `message`:
 * the writer sets one on EVERY outcome ("added the cellar MCP server",
 * "already configured"), so keying off it appended a note to every adoption and
 * left the one case this exists to surface indistinguishable from that chatter.
 */
export function agentConfigNotice(report: AgentConfigReport | null | undefined): string | null {
	if (!report) return null;
	if (report.warning) return report.warning;
	return report.status === 'skipped' ? (report.message ?? null) : null;
}

/** Thrown for a declared root that is not a usable workspace-relative directory. */
export class NotebookRootError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'NotebookRootError';
	}
}

/**
 * The SHAPE of a declared root, as far as a module with no filesystem can tell.
 *
 * `outside` is a CANDIDATE, never an admission: only `server/notebookRoot.ts`,
 * which can run `git worktree list`, decides whether such a path is a registered
 * worktree of this repo. Splitting it this way is what keeps the pure half
 * honest — it can say "this is not workspace-relative", and nothing more.
 */
export type RootShape =
	/** Absent / empty / `.` — the workspace root, i.e. no declaration. */
	| { kind: 'none' }
	/** A workspace-relative path with no `..`: today's shape, unchanged. */
	| { kind: 'inside'; rel: string }
	/** Absolute, or carrying a `..` segment. Canonicalized only as far as text allows. */
	| { kind: 'outside'; raw: string };

/**
 * Classify a declared root by shape, canonicalizing what can be canonicalized
 * without a filesystem.
 *
 * `~` is the one shape refused outright: it is a shell construct Cellar never
 * expands, so admitting it would mean two ways to write one path with only one of
 * them ever resolving.
 *
 * Canonicalization is deliberately narrow, because the result is what gets
 * PERSISTED and later re-read, so it must be idempotent: separators unified to
 * `/`, `.` segments and repeated/trailing separators dropped. `..` segments are
 * deliberately NOT collapsed here — `a/../b` and `b` can differ once symlinks are
 * involved, and only the resolver knows the workspace to resolve against.
 */
export function classifyRootPath(raw: string | null | undefined): RootShape {
	const value = (raw ?? '').trim();
	if (!value) return { kind: 'none' };
	if (value.startsWith('~')) {
		throw new NotebookRootError(
			`A notebook root must be a directory path (e.g. "${ROOTS_DIR}/pr-482" or "../pr-482"); ${JSON.stringify(value)} is a home-relative path, which Cellar never expands. Write the path out in full.`
		);
	}
	// Unify separators before any structural test, so a Windows-style value is
	// judged by the same rules rather than read as one opaque segment.
	const unified = value.replace(/\\/g, '/');
	if (unified.startsWith('/') || /^[A-Za-z]:\//.test(unified)) {
		// Trailing separators only; an absolute path is otherwise handed over
		// verbatim, since resolving it is the server half's job.
		return { kind: 'outside', raw: unified.replace(/\/+$/, '') || '/' };
	}
	const segments = unified.split('/').filter((s) => s !== '' && s !== '.');
	if (segments.includes('..')) return { kind: 'outside', raw: segments.join('/') };
	// Every segment was `.` (or the value was `./`): that IS the workspace root,
	// which is the same thing as declaring no root at all.
	return segments.length ? { kind: 'inside', rel: segments.join('/') } : { kind: 'none' };
}

/**
 * The canonical text of a declared root, or null when it means "the workspace
 * root" (absent, empty, `.`).
 *
 * This is the DECLARATION's canonical form, not a resolved one: an out-of-
 * workspace shape comes back as written (canonicalized), because turning
 * `/abs/path` into the `../name` form that gets persisted needs the workspace and
 * therefore happens at the one validate-and-store site, `resolveRootDir`. Callers
 * that only need "did the user declare something, and is it the same string as
 * before" — the `.py` pre-check, the writer, the listing — use this; callers that
 * need a usable directory use the resolver.
 */
export function normalizeRootPath(raw: string | null | undefined): string | null {
	const shape = classifyRootPath(raw);
	if (shape.kind === 'none') return null;
	return shape.kind === 'inside' ? shape.rel : shape.raw;
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
 * True when two declared roots mean the same TEXT. Both sides are normalized
 * first, so `"./roots/a/"` and `"roots/a"` are one root and re-declaring it
 * costs the user no kernel restart.
 *
 * Text only, and that is a real limit: `/abs/path/sibling` and `../sibling` can
 * name one directory, and no pure function can know it — that needs the
 * workspace. `setNotebookRootAndRestart` therefore compares RESOLVED DIRECTORIES
 * first and falls back to this, so declaring a root you are already on in the
 * other form is still a no-op. Do not "fix" that by teaching this function about
 * paths it cannot resolve.
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
