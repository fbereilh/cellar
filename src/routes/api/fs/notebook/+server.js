import { json, error } from '@sveltejs/kit';
import { readWorkspaceNotebook } from '$lib/server/fstree.js';
import { deserialize } from '$lib/server/ipynb.js';

/**
 * Parse an arbitrary workspace `.ipynb` into renderable cells (source +
 * outputs), so opening it from the file tree shows a rendered notebook rather
 * than raw JSON. Read-only: unlike the canonical `notebook.ipynb`, these are
 * not the live kernel-attached document.
 */
export function GET({ url }) {
	const path = url.searchParams.get('path');
	if (!path) throw error(400, 'path required');
	try {
		const nb = readWorkspaceNotebook(path);
		const { cells } = deserialize(nb);
		return json({
			path,
			cells: cells.map((c, i) => ({
				id: c.id || `cell-${i}`, // older nbformat may lack cell ids
				cell_type: c.cell_type,
				source: c.source,
				outputs: c.outputs
			}))
		});
	} catch (err) {
		throw error(400, String(err?.message ?? err));
	}
}
