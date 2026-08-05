import { json, error } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { readWorkspaceFile, writeWorkspaceFile, statWorkspaceFile } from '$lib/server/fstree';
import { invalidateGitStatusCache } from '$lib/server/git';
import { watchFileForChanges, noteKnownContent, resyncKnownContent } from '$lib/server/fileWatch';
import { effectiveBodyLimit } from '$lib/saveLimit';

/** A `stat` that must never fail the request it rides along with. */
function statOrNull(path) {
	try {
		return statWorkspaceFile(path);
	} catch {
		return null;
	}
}

/**
 * Read a workspace file's text content (for opening it into an editor tab).
 *
 * `bodyLimit` rides along because only the SERVER knows what the save PUT will
 * be allowed to carry: adapter-node's `BODY_SIZE_LIMIT` (an operator's value or
 * its 512 K default) under the production build, and nothing at all under Vite,
 * which applies no body cap. The tab uses it to decide whether to offer an edit
 * at all — a client-side guess got both of those cases wrong.
 *
 * `stat` rides along too, as the baseline for the tab's stat-first window-focus
 * revalidation (see `GET /api/fs/file/stat`). It is taken BEFORE the read, and
 * that ordering is the fail-safe one: a write landing between the two leaves the
 * baseline describing the OLDER file, so the next focus stats a difference and
 * re-reads. Taken after, the baseline would describe content the tab never got
 * and the change would be missed — the one outcome this must never produce.
 */
export function GET({ url }) {
	const path = url.searchParams.get('path');
	if (!path) throw error(400, 'path required');
	try {
		const stat = statOrNull(path);
		const content = readWorkspaceFile(path);
		// This read IS the "someone has this file open" signal - the server has no
		// other one (tabs are client state), and the content in hand seeds the
		// watcher's echo-suppression hash for free. Idempotent, and LRU-bounded,
		// so a tab that goes away without saying so leaks nothing.
		watchFileForChanges(path, content);
		return json({
			path,
			content,
			stat,
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
		try {
			writeWorkspaceFile(path, content ?? '');
		} catch (err) {
			// The bytes never landed (refused for size, EACCES, ENOSPC), so the hash
			// recorded above describes a file that does not exist. Left there, echo
			// suppression would silently swallow a later GENUINE external change that
			// happens to produce exactly those bytes - the everyday agent shape, where
			// the agent writes the very edit the user was racing to save. Re-seed from
			// what disk actually holds; an explicit reseed is required because
			// `watchFileForChanges` now gives an existing entry precedence and so will
			// never correct this on its own.
			resyncKnownContent(path);
			throw err;
		}
		invalidateGitStatusCache(); // a save changes `git status`; refresh the tree decorations now
		// The tab's stat baseline for what disk now holds, so the next window focus
		// short-circuits instead of re-reading a file it just wrote.
		return json({ ok: true, stat: statOrNull(path) });
	} catch (err) {
		throw error(400, String(err?.message ?? err));
	}
}
