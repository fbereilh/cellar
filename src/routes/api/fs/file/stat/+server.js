import { json, error } from '@sveltejs/kit';
import { statWorkspaceFile } from '$lib/server/fstree';

/**
 * A workspace file's size + mtime. NO read.
 *
 *   GET /api/fs/file/stat?path=report.html  → { path, stat: { size, mtimeMs } }
 *
 * This is the cheap first half of a file tab's window-focus revalidation. The
 * tab compares this against the stat it recorded for the content it holds and
 * only issues the full content GET when they differ - so alt-tabbing back into
 * Cellar with nothing changed costs one `stat` per open tab instead of a
 * multi-MB read + serialize + transfer + whole-string compare (`readWorkspaceFile`
 * admits an `.html` export up to 15 MB, and every file tab stays mounted).
 *
 * THE INVARIANT: this is a short-circuit that may only ever cause an EXTRA read,
 * never a MISSED change. So it answers a real `stat` or an error, and never a
 * guess - the caller treats anything it cannot verify as "read the file". It is
 * emphatically not a deletion signal either: reporting one is the watcher's job,
 * and a missing file here is simply an error the caller falls back from.
 *
 * Path-guarded through `resolveInWorkspace` exactly like its sibling routes.
 */
export function GET({ url }) {
	const path = url.searchParams.get('path');
	if (!path) throw error(400, 'path required');
	try {
		return json({ path, stat: statWorkspaceFile(path) });
	} catch (err) {
		throw error(400, String(err?.message ?? err));
	}
}
