import { json, error } from '@sveltejs/kit';
import { writeUploadChunk, abortUpload } from '$lib/server/fstree';
import { invalidateGitStatusCache } from '$lib/server/git';

/**
 * Paste a file from the system clipboard into a workspace folder, one chunk
 * per request (see `fstree.ts`'s `writeUploadChunk` for why it is chunked).
 *
 * The chunk is the raw request body. The query names the rest:
 * `dir` (workspace-relative folder), `name`, `id` (the browser's upload id),
 * `offset` (bytes already sent) and `last=1` on the final chunk. The final
 * chunk answers `{ ok, path }` with the workspace-relative path it landed at.
 */
export async function POST({ request, url }) {
	const q = url.searchParams;
	try {
		const bytes = new Uint8Array(await request.arrayBuffer());
		const res = writeUploadChunk({
			dir: q.get('dir') ?? '',
			name: q.get('name') ?? '',
			id: q.get('id') ?? '',
			offset: Number(q.get('offset') ?? 'NaN'),
			bytes,
			last: q.get('last') === '1'
		});
		if ('path' in res) invalidateGitStatusCache(); // a new file changes `git status`
		return json({ ok: true, ...res });
	} catch (err) {
		throw error(400, String(err?.message ?? err));
	}
}

/** Drop the part file of an upload the browser abandoned (`dir`, `id`). */
export function DELETE({ url }) {
	try {
		abortUpload(url.searchParams.get('dir') ?? '', url.searchParams.get('id') ?? '');
		return json({ ok: true });
	} catch (err) {
		throw error(400, String(err?.message ?? err));
	}
}
