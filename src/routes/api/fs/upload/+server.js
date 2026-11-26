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
 *
 * This route writes caller-chosen bytes, so it refuses a page on another site:
 * the body must be `application/octet-stream`, which a browser only sends
 * cross-site after a preflight this server never grants, and an `Origin` header
 * must name this server's own host.
 */
export async function POST({ request, url }) {
	refuseForeignOrigin(request, url);
	const type = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
	if (type !== 'application/octet-stream') {
		throw error(415, 'upload body must be application/octet-stream');
	}
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

/** Drop the part file of an upload the browser abandoned (`id`). */
export function DELETE({ request, url }) {
	refuseForeignOrigin(request, url);
	try {
		abortUpload(url.searchParams.get('id') ?? '');
		return json({ ok: true });
	} catch (err) {
		throw error(400, String(err?.message ?? err));
	}
}

/**
 * Refuse a request whose `Origin` header names another host. The compare is on
 * host and port: adapter-node builds `url` from the `Host` header and assumes
 * `https` when no `ORIGIN` is configured, so the scheme of `url` is not evidence.
 *
 * @param {Request} request
 * @param {URL} url
 */
function refuseForeignOrigin(request, url) {
	const origin = request.headers.get('origin');
	if (origin === null) return;
	let host = '';
	try {
		host = new URL(origin).host;
	} catch {
		// an opaque origin ("null") is not this app
	}
	if (host !== url.host) throw error(403, 'upload refused: request comes from another origin');
}
