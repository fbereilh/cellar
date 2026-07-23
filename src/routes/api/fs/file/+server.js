import { json, error } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { readWorkspaceFile, writeWorkspaceFile } from '$lib/server/fstree';
import { invalidateGitStatusCache } from '$lib/server/git';
import { effectiveBodyLimit } from '$lib/saveLimit';

/**
 * Read a workspace file's text content (for opening it into an editor tab).
 *
 * `bodyLimit` rides along because only the SERVER knows what the save PUT will
 * be allowed to carry: adapter-node's `BODY_SIZE_LIMIT` (an operator's value or
 * its 512 K default) under the production build, and nothing at all under Vite,
 * which applies no body cap. The tab uses it to decide whether to offer an edit
 * at all — a client-side guess got both of those cases wrong.
 */
export function GET({ url }) {
	const path = url.searchParams.get('path');
	if (!path) throw error(400, 'path required');
	try {
		return json({
			path,
			content: readWorkspaceFile(path),
			bodyLimit: effectiveBodyLimit(process.env.BODY_SIZE_LIMIT, dev)
		});
	} catch (err) {
		throw error(400, String(err?.message ?? err));
	}
}

/** Save an edited file tab back to disk. */
export async function PUT({ request }) {
	const { path, content } = await request.json();
	if (!path) throw error(400, 'path required');
	try {
		writeWorkspaceFile(path, content ?? '');
		invalidateGitStatusCache(); // a save changes `git status`; refresh the tree decorations now
		return json({ ok: true });
	} catch (err) {
		throw error(400, String(err?.message ?? err));
	}
}
