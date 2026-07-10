import { json } from '@sveltejs/kit';
import { getNotebookStaleness } from '$lib/server/dataflow.js';

/**
 * Per-cell staleness for a notebook: `{ sid, cells: { id: { state, reason, upstream } } }`.
 *
 * `state` is one of not_run / fresh / stale / n/a (see `$lib/staleness.js`).
 * Derived at runtime from the dependency graph + the live kernel session; nothing
 * is persisted, so it produces no git diff. The browser refetches this whenever a
 * run ends, a cell is edited, or the notebook structure changes, and renders the
 * per-cell stale indicator from it. `path` is the workspace-relative notebook
 * (defaults to the active one).
 */
export async function GET({ url }) {
	const path = url.searchParams.get('path') || undefined;
	try {
		return json(await getNotebookStaleness(path));
	} catch (err) {
		return json({ sid: null, cells: {}, error: String(err?.message ?? err) });
	}
}
