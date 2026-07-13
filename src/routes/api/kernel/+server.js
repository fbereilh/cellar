import { json } from '@sveltejs/kit';
import { basename } from 'node:path';
import { getKernelInfo, loadedNotebookPaths } from '$lib/server/kernel';
import { workspaceRelative } from '$lib/server/notebook';

/**
 * Current kernel status for the sidebar Kernels section (does not start one).
 *
 * `loaded_notebooks` lists the notebooks whose state actually lives in a kernel:
 * a notebook is "loaded" iff it has a live kernel entry in the manager (one per
 * notebook, lazily started on that notebook's first run), NOT the open tabs. The
 * entry survives a restart (the connection is reused; only the namespace clears)
 * and is dropped on shutdown/rebind. Each carries its workspace-relative `path`
 * (the id the browser matches tabs on) and a display `name`.
 */
export function GET() {
	const loaded_notebooks = loadedNotebookPaths().map((abs) => ({
		path: workspaceRelative(abs),
		name: basename(abs)
	}));
	return json({ ...getKernelInfo(), loaded_notebooks });
}
