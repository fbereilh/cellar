import { json } from '@sveltejs/kit';
import { resolve } from 'node:path';
import { gitCommitAt } from '$lib/server/git';
import { workspaceRoot } from '$lib/server/fstree';
import { getNotebookRoot } from '$lib/server/notebook';
import { resolveRootDir } from '$lib/server/notebookRoot';

/**
 * Which commit each open notebook's CODE ROOT is checked out at — the Git sidebar
 * section's whole payload, in one round trip.
 *
 *   GET /api/fs/git/roots?path=a.ipynb&path=roots/x/b.ipynb
 *     → { workspace: <GitDirCommit>, notebooks: [{ path, root, error, unreadable, git }] }
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
 */
export async function GET({ url }) {
	const ws = resolve(workspaceRoot());
	const paths = [...new Set(url.searchParams.getAll('path').filter(Boolean))];

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

	// One probe per DISTINCT directory (three `git` spawns), shared by every
	// notebook rooted there — plus the workspace itself, which every no-root
	// notebook reports and which is usually already one of them.
	const dirs = [...new Set([ws, ...targets.map((t) => t.dir).filter(Boolean)])];
	const commits = new Map(await Promise.all(dirs.map(async (dir) => [dir, await gitCommitAt(dir)])));

	return json({
		workspace: commits.get(ws),
		notebooks: targets.map((t) => ({
			path: t.path,
			root: t.root,
			error: t.error,
			unreadable: t.unreadable,
			git: t.dir ? commits.get(t.dir) : null
		}))
	});
}
