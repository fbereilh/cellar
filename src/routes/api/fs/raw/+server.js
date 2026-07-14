import { error } from '@sveltejs/kit';
import { readFileSync, statSync } from 'node:fs';
import { resolveInWorkspace } from '$lib/server/fstree';
import { imageContentType } from '$lib/imagePath';

/**
 * Serve the RAW bytes of a workspace file with an image Content-Type, for the
 * shell's image tabs (`<img src="/api/fs/raw?path=…">`). Distinct from
 * `/api/fs/file`, which is text-oriented JSON — here the body is the file's
 * bytes, never base64 in JSON, so large images are cheap.
 *
 * Security: every path is resolved through `resolveInWorkspace()`, so a
 * traversal (`../../etc/passwd`) or absolute escape is rejected before any read.
 * Only known image extensions are served (others 400), and SVG goes out as
 * `image/svg+xml` for an `<img>` — never as inline DOM — so embedded script can
 * never execute.
 */
export function GET({ url }) {
	const path = url.searchParams.get('path');
	if (!path) throw error(400, 'path required');

	const type = imageContentType(path);
	if (!type) throw error(400, 'not an image file');

	let abs;
	try {
		abs = resolveInWorkspace(path);
	} catch {
		throw error(400, 'path escapes workspace');
	}

	let stat;
	try {
		stat = statSync(abs);
	} catch {
		throw error(404, 'file not found');
	}
	if (!stat.isFile()) throw error(404, 'not a file');

	let bytes;
	try {
		bytes = readFileSync(abs);
	} catch {
		throw error(404, 'file not found');
	}

	// The file can change on disk, so never let a stale copy stick in cache.
	return new Response(bytes, {
		headers: {
			'Content-Type': type,
			'Content-Length': String(stat.size),
			'Cache-Control': 'no-cache'
		}
	});
}
