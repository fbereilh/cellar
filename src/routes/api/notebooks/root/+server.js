import { json, error } from '@sveltejs/kit';
import { getNotebookRoot } from '$lib/server/notebook';
import { setNotebookRootAndRestart, listWorkspaceRoots } from '$lib/server/notebook-root-actions';

/**
 * A notebook's CODE ROOT: the directory its kernel runs in and imports from —
 * normally a git worktree, either under `roots/` inside the workspace or a
 * registered sibling checkout outside it. Absent = the workspace root, which is
 * the default and today's behavior.
 *
 * GET  ?path=<notebook>  → `{ root, roots }` — the notebook's declaration plus
 *   every root available in this workspace (for the picker).
 * POST { root, path?, originId? } → declare (or clear with null/'') the root and
 *   free that notebook's kernel so the next run starts at the new directory.
 *
 * WHAT POST ACCEPTS, and what it STORES, are deliberately not the same thing. A
 * path inside the workspace, an ABSOLUTE path, or a `..`-relative one are all
 * accepted — the first is the `roots/` convention, and the other two are what
 * `git worktree add` prints and what a user pastes. An out-of-workspace path is
 * admitted only when `git worktree list`, run in the workspace, names that exact
 * directory (`notebookRoot.ts`'s second, strictly narrower admission rule; it
 * grants a kernel cwd and no file reach whatever). What gets PERSISTED is always
 * the canonical `..`-relative form, so a committed `.ipynb` stays portable and
 * leaks no home directory.
 *
 * Anything else — a path that escapes the workspace without being a registered
 * worktree, a missing directory, a file, or a `.py` notebook that cannot hold a
 * declaration at all — is refused with a 400 naming the path and its own repair.
 * Nothing is written and no kernel is freed.
 *
 * Adopting an EXTERNAL worktree may additionally write Cellar's agent config into
 * that checkout (see `worktree-agent-config.ts`); the outcome rides the response
 * as `agent_config` and is REPORTED, never thrown — agent wiring may not abort a
 * root change, and the case that leaves a checkout untracked-dirty must be said.
 */
export async function GET({ url }) {
	const path = url.searchParams.get('path');
	try {
		return json({
			ok: true,
			root: getNotebookRoot(path || undefined),
			roots: await listWorkspaceRoots()
		});
	} catch (err) {
		throw error(400, String(err?.message ?? err));
	}
}

export async function POST({ request }) {
	const body = await request.json().catch(() => ({}));
	try {
		return json({ ok: true, ...(await setNotebookRootAndRestart(body.root ?? null, body.path, body.originId)) });
	} catch (err) {
		throw error(400, String(err?.message ?? err));
	}
}
