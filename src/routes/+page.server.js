import { getCellId } from '$lib/server/notebook.js';

/** Hand the browser the notebook's stable cell id (fixed across refreshes). */
export function load() {
	return { cellId: getCellId() };
}
