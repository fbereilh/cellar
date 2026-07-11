import { json } from '@sveltejs/kit';
import { basename } from 'node:path';
import { getKernelInfo, loadedNotebookPaths } from '$lib/server/kernel.js';
import { workspaceRelative } from '$lib/server/notebook.js';

/**
 * Current kernel status for the sidebar Kernels section (does not start one).
 *
 * `loaded_notebooks` lists the notebooks whose state actually lives in the live
 * kernel session — those that ran >=1 cell this session (kernel.js tracks the set,
 * cleared on restart), NOT the open tabs. Each carries its workspace-relative
 * `path` (the id the browser matches tabs on) and a display `name`.
 */
export function GET() {
	const loaded_notebooks = loadedNotebookPaths().map((abs) => ({
		path: workspaceRelative(abs),
		name: basename(abs)
	}));
	return json({ ...getKernelInfo(), loaded_notebooks });
}
