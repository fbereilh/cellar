import { json, error } from '@sveltejs/kit';
import { gitHeadFile } from '$lib/server/git';
import { deserialize } from '$lib/server/ipynb';

/**
 * A file's git-HEAD baseline, for the client-side change decorations.
 *
 *   GET /api/fs/git/head?path=src/foo.py             → { isRepo, tracked, content }
 *   GET /api/fs/git/head?path=a.ipynb&kind=notebook  → { isRepo, tracked, cells }
 *
 * The notebook form parses HEAD's `.ipynb` through the same `deserialize` the
 * live document uses, so both sides of the cell diff are normalized identically
 * (nbformat's multiline `source` arrays joined into one string) and formatting
 * alone never reads as a change. `tracked:false` means "nothing at HEAD to
 * compare against" — the caller draws no decorations.
 */
export async function GET({ url }) {
	const path = url.searchParams.get('path');
	if (!path) error(400, 'path required');

	let head;
	try {
		head = await gitHeadFile(path);
	} catch (err) {
		error(400, String(err?.message ?? err));
	}

	if (url.searchParams.get('kind') !== 'notebook') {
		return json(head);
	}

	if (!head.tracked) return json({ isRepo: head.isRepo, tracked: false, cells: null });
	let cells;
	try {
		cells = deserialize(JSON.parse(head.content)).cells.map((c) => ({
			id: c.id,
			cell_type: c.cell_type,
			source: c.source
		}));
	} catch {
		// HEAD holds something that isn't a parseable notebook — no baseline to diff.
		return json({ isRepo: true, tracked: false, cells: null });
	}
	return json({ isRepo: true, tracked: true, cells });
}
