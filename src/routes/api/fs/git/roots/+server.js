import { json } from '@sveltejs/kit';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { gitCommitAt, listWorktreesAt } from '$lib/server/git';
import { workspaceRoot } from '$lib/server/fstree';
import { getNotebookRoot } from '$lib/server/notebook';
import { resolveRootDir, worktreeDeclaration } from '$lib/server/notebookRoot';

/**
 * Which commit each open notebook's CODE ROOT is checked out at — the Git sidebar
 * section's whole payload, in one round trip.
 *
 *   GET /api/fs/git/roots?path=a.ipynb&path=roots/x/b.ipynb
 *     → { workspace: <GitDirCommit>, readLimit,
 *         notebooks: [{ path, root, error, unreadable, notRead, git }],
 *         worktrees: [{ path, absolute, external, exists, branch, detached, shortSha, dirty }] }
 *
 * `worktrees` is every OTHER registered worktree of the workspace's repo (its own
 * checkout excluded, since that is what `workspace` above already reports) — the
 * sidebar's WORKTREES block. It rides THIS route rather than a new one because it
 * is the same question ("which checkout is what") already coalesced and
 * generation-guarded, and it is empty in a single-checkout repo, where the block
 * renders nothing at all.
 *
 * `path` repeats, one per open notebook tab; unknown/omitted is not an error, it
 * just yields an empty list (a workspace with no notebook open still reports its
 * own HEAD, which is what a no-root notebook runs against).
 *
 * READ-ONLY, and deliberately so: this reports the commit each kernel is rooted
 * at. It never stages, commits, switches a branch, or touches a notebook's root
 * declaration — those belong to the terminal and to the notebook's own root
 * picker respectively.
 *
 * A notebook whose declared root is unusable (missing, a file, escaping the
 * workspace) reports that root and the resolver's own message on `error` instead
 * of a commit — the same state a RUN of that notebook is about to refuse, so
 * hiding it here would be the silent degrade `notebookRoot.ts` exists to prevent.
 * A root that is a real directory but not a git checkout is not an error at all:
 * it answers `isRepo:false` and the section says "no commit info".
 *
 * A notebook whose DOCUMENT cannot be read at all (deleted or renamed outside
 * Cellar while its tab is still open) is a DIFFERENT fact and gets its own
 * structural flag, `unreadable`, never the `error` channel above: with no document
 * there is no declaration to report, so routing it through `error` left the row
 * naming the workspace as the notebook's root, i.e. asserting a root it never
 * verified. It carries no message, because the only thing the throw knows is an
 * absolute server path, which has no business reaching the browser; the client
 * owns the wording.
 *
 * Probing is DEDUPED by directory: several notebooks reviewing one worktree cost
 * one probe, and `gitCommitAt`'s own cache collapses repeat requests on top.
 *
 * BOUNDED at `MAX_PATHS` distinct paths, because the fan-out is per path and lands
 * on the process that also carries the kernel websockets and the SSE fan-out: each
 * one loads that notebook's DOCUMENT (`getNotebookRoot` → `loadDoc`, a blocking
 * `spawnSync` jupytext conversion for a `.py` notebook), and each distinct root it
 * resolves to costs three concurrent `git` spawns below.
 *
 * Past the cap it READS THE FIRST `MAX_PATHS` AND REPORTS THE REMAINDER as
 * `notRead:true` — a row with no root, no commit and no error, i.e. asserting
 * nothing at all — rather than refusing the whole request. Refusing bounded the
 * work correctly but dead-ended the only real caller: the panel's own list is every
 * open notebook tab, unclamped, so one workspace with enough tabs turned every
 * fetch into a 400 and the section rendered an error paragraph and no rows at all,
 * permanently. That is strictly worse than the truncation it was avoiding — it
 * drops the notebooks it COULD have read too. A hand-made oversized request is not
 * a reason to make the sidebar useless, and `notRead` is what keeps the truncation
 * from being silent: the dropped rows are still named and are structurally
 * distinguishable from a row still loading and from one whose document could not be
 * read, so the panel can mark them and say why, once, instead of leaving them
 * rendering as never-arrived. `readLimit` rides along so it can name the cap.
 */

/** Distinct `path` params one request PROBES; the rest come back `notRead`. See the header. */
const MAX_PATHS = 64;

/** `realpathSync` where possible, else the path itself (it may not exist). */
function realpathOrSelf(p) {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

/** True when `abs` exists and is a directory. */
function isDir(abs) {
	try {
		return existsSync(abs) && statSync(abs).isDirectory();
	} catch {
		return false;
	}
}

/** Lexical containment, the same rule the workspace path guard applies. */
function isInside(abs, ws) {
	return abs === ws || abs.startsWith(ws + sep);
}

export async function GET({ url }) {
	const ws = resolve(workspaceRoot());
	const asked = [...new Set(url.searchParams.getAll('path').filter(Boolean))];
	const paths = asked.slice(0, MAX_PATHS);
	const notRead = asked.slice(MAX_PATHS);

	/** Declared root + resolved directory (or the refusal) for one notebook. */
	const targets = paths.map((path) => {
		// Read the declaration first and on its own, so a document that cannot be
		// read at all is reported as such, and so the refusal below can name the
		// root the notebook actually holds — that verbatim value is what makes the
		// message actionable.
		let declared = null;
		try {
			declared = getNotebookRoot(path);
		} catch {
			// The DOCUMENT is gone/unreadable, so nothing here knows what root it
			// declares. Reported as its own fact rather than as a root refusal — see
			// the header — and deliberately without the thrown message, which is an
			// absolute server path.
			return { path, root: null, dir: null, error: null, unreadable: true };
		}
		try {
			// Throws (NotebookRootError) for a declared root that is not a usable
			// directory inside the workspace; null means "the workspace root".
			const resolved = resolveRootDir(declared);
			return { path, root: resolved?.rel ?? null, dir: resolved?.dir ?? ws, error: null, unreadable: false };
		} catch (err) {
			return { path, root: declared, dir: null, error: String(err?.message ?? err), unreadable: false };
		}
	});

	// Every other registered worktree of this repo. The workspace's own checkout is
	// dropped (matched by REALPATH — `git worktree list` realpaths its output while
	// `ws` is the lexical resolve, and on macOS those differ), because `workspace`
	// below already reports it and a duplicate row would read as a second checkout.
	const wsReal = realpathOrSelf(ws);
	const wtrees = listWorktreesAt(ws)
		.filter((w) => !w.bare && realpathOrSelf(w.path) !== wsReal)
		// A registered worktree can be GONE (`prunable`); `statSync` decides, since
		// that is what a run of a notebook rooted here would ask. A missing one is
		// never probed: there is no status to read, and it would spawn three
		// processes to learn nothing.
		.map((w) => ({ w, exists: isDir(w.path) }));

	// One probe per DISTINCT directory (three `git` spawns), shared by every
	// notebook rooted there — plus the workspace itself, which every no-root
	// notebook reports and which is usually already one of them, plus each live
	// worktree. Pooling the worktrees into this SAME set is what keeps the cost
	// per-directory rather than per-row: a worktree that is also some notebook's
	// root is already in it and costs nothing extra.
	const dirs = [
		...new Set([ws, ...targets.map((t) => t.dir).filter(Boolean), ...wtrees.filter((e) => e.exists).map((e) => e.w.path)])
	];
	const commits = new Map(await Promise.all(dirs.map(async (dir) => [dir, await gitCommitAt(dir)])));

	const worktrees = wtrees.map(({ w, exists }) => ({
		// The LEXICAL declaration for the realpath'd path git printed — through the
		// ONE helper that owns the two-namespace rule, so "Use as root" posts exactly
		// the value the picker would and exactly the value that gets persisted.
		path: worktreeDeclaration(w.path),
		absolute: w.path,
		external: !isInside(realpathOrSelf(w.path), wsReal),
		exists,
		branch: w.branch,
		detached: w.detached,
		shortSha: w.head ? w.head.slice(0, 7) : null,
		prunable: w.prunable,
		dirty: exists ? (commits.get(w.path)?.dirty ?? false) : false
	}));

	return json({
		workspace: commits.get(ws),
		readLimit: MAX_PATHS,
		worktrees,
		notebooks: [
			...targets.map((t) => ({
				path: t.path,
				root: t.root,
				error: t.error,
				unreadable: t.unreadable,
				notRead: false,
				git: t.dir ? commits.get(t.dir) : null
			})),
			// Named, so the panel can mark them; empty on every other field, so the row
			// claims nothing about a notebook this request never opened.
			...notRead.map((path) => ({
				path,
				root: null,
				error: null,
				unreadable: false,
				notRead: true,
				git: null
			}))
		]
	});
}
