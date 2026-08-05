import { json, error } from '@sveltejs/kit';
import {
	createEntry,
	renameEntry,
	deleteEntry,
	moveEntry,
	copyEntry
} from '$lib/server/fstree';
import { dropDocs, rekeyDocs } from '$lib/server/notebook';
import { shutdownKernelsUnder } from '$lib/server/kernel';
import { invalidateGitStatusCache } from '$lib/server/git';
import { unwatchUnder } from '$lib/server/fileWatch';

/**
 * File-management operations for the sidebar file explorer. A single POST
 * dispatched on `op`; every underlying helper is path-guarded to the workspace
 * and refuses to touch the workspace root. Returns `{ ok, ...result }` where
 * `result` carries the affected workspace-relative path(s) so the client can
 * refresh and update any open tab.
 */
export async function POST({ request }) {
	let body;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'invalid JSON body');
	}
	const { op } = body ?? {};
	// Every op here mutates the working tree (create/delete/rename/move/copy), so
	// `git status` will differ; drop the cached status so the file-tree decorations
	// reflect the change on the client's next refresh instead of lagging by the TTL.
	invalidateGitStatusCache();
	try {
		switch (op) {
			case 'create':
				return json({ ok: true, ...createEntry(body.parent ?? '', body.name, body.kind) });
			case 'rename': {
				const res = renameEntry(body.path, body.name);
				// This guard and the one in `move` answer the same question the neighbouring
				// `rekeyDocs` does - did this path actually move? - so they read alike.
				// `renameEntry` returns NO `from` for a rename to the same name, and
				// `moveEntry` returns `from === path` for a same-parent move: nothing moved
				// on disk and the file is still open, so unwatching there would silently
				// switch off that tab's live sync (it never remaps, so it never remounts and
				// never re-issues the read that is the sole registration point).
				if (res.from && res.from !== res.path) {
					rekeyDocs(res.from, res.path);
					// The old name no longer exists, so its watcher entry can only settle
					// into a deletion nobody is listening for - and it would hold an LRU slot
					// a genuinely open file could use. The remapped tab re-registers the new
					// path on its next read / window-focus revalidation.
					unwatchUnder(res.from);
				}
				return json({ ok: true, ...res });
			}
			case 'delete': {
				const res = deleteEntry(body.path);
				dropDocs(res.path);
				unwatchUnder(res.path);
				// Free the kernel process(es) of the deleted notebook (or every notebook
				// under a deleted folder), not just the in-memory doc. Best-effort: a
				// failed shutdown must not fail the delete the user already committed to.
				shutdownKernelsUnder(res.path).catch(() => {});
				return json({ ok: true, ...res });
			}
			case 'move': {
				const res = moveEntry(body.path, body.dest ?? '');
				// Same guard as `rename` above, for the same reason: a same-parent move
				// returns `from === path` and moved nothing.
				if (res.from && res.from !== res.path) {
					rekeyDocs(res.from, res.path);
					unwatchUnder(res.from);
				}
				return json({ ok: true, ...res });
			}
			case 'copy':
				return json({ ok: true, ...copyEntry(body.path, body.dest ?? '') });
			default:
				throw error(400, `unknown op: ${op}`);
		}
	} catch (err) {
		if (err?.status) throw err; // a SvelteKit error() from the default case
		throw error(400, String(err?.message ?? err));
	}
}
