import { json, error } from '@sveltejs/kit';
import { getNotebookRoot } from '$lib/server/notebook';
import { setNotebookRootAndRestart, listWorkspaceRoots } from '$lib/server/notebook-root-actions';

/**
 * A notebook's CODE ROOT: the workspace-relative directory its kernel runs in and
 * imports from (normally a git worktree under `roots/`). Absent = the workspace
 * root, which is the default and today's behavior.
 *
 * GET  ?path=<notebook>  → `{ root, roots }` — the notebook's declaration plus
 *   every root available in this workspace (for the picker).
 * POST { root, path?, originId? } → declare (or clear with null/'') the root and
 *   free that notebook's kernel so the next run starts at the new directory.
 *
 * A root that is not a usable directory inside the workspace is refused with a
 * 400 naming the path and the fix — nothing is written and no kernel is freed.
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
