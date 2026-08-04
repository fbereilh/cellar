import { json, error } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { readWorkspaceFile, writeWorkspaceFile } from '$lib/server/fstree';
import { invalidateGitStatusCache } from '$lib/server/git';
import { watchFileForChanges, noteKnownContent } from '$lib/server/fileWatch';
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
		const content = readWorkspaceFile(path);
		// This read IS the "someone has this file open" signal - the server has no
		// other one (tabs are client state), and the content in hand seeds the
		// watcher's echo-suppression hash for free. Idempotent, and LRU-bounded,
		// so a tab that goes away without saying so leaks nothing.
		watchFileForChanges(path, content);
		return json({
			path,
			content,
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
		// BEFORE the write: the watcher event can arrive as soon as the bytes land,
		// so a hash recorded afterwards would race and bounce our own save back
		// into the tab that made it as a phantom "changed on disk".
		noteKnownContent(path, content ?? '');
		writeWorkspaceFile(path, content ?? '');
		invalidateGitStatusCache(); // a save changes `git status`; refresh the tree decorations now
		return json({ ok: true });
	} catch (err) {
		throw error(400, String(err?.message ?? err));
	}
}
