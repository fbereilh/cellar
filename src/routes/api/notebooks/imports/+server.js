import { json, error } from '@sveltejs/kit';
import { consolidateImports } from '$lib/server/imports-cell.js';

/**
 * Consolidate a notebook's imports: sweep every module-level import into the
 * pinned imports cell at index 0, strip them from their source cells, and run it.
 * Idempotent — a second call finds nothing to move and changes nothing.
 *
 * `path` is the workspace-relative notebook (defaults to the active one). No
 * `originId` is threaded through: a sweep touches many cells, so the initiating
 * tab renders it from the same `cell:*` events every other tab does rather than
 * replaying it locally.
 */
export async function POST({ request }) {
	const { path } = await request.json().catch(() => ({}));
	try {
		return json(await consolidateImports(path, { actor: 'user' }));
	} catch (err) {
		throw error(400, String(err?.message ?? err));
	}
}
