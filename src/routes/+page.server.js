import { getNotebook } from '$lib/server/notebook.js';

/** Load the canonical notebook (cells + outputs) for the workspace. */
export function load() {
	return { notebook: getNotebook() };
}
