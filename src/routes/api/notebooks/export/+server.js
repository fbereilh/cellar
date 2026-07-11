import { error } from '@sveltejs/kit';
import { listCells, resolveNotebookPath } from '$lib/server/notebook';
import { renderNotebookHtml, exportFilename } from '$lib/server/export-html';

/**
 * Export a notebook to a single self-contained HTML file.
 *
 * Renders the notebook MODEL (cells + the persisted outputs already in the
 * `.ipynb`) server-side — it never touches the kernel, so the export reflects
 * the notebook's last run. `path` is the workspace-relative notebook (defaults
 * to the active one). The response is an HTML attachment so the browser
 * downloads it; the file opens standalone with no Cellar server.
 */
export function GET({ url }) {
	const path = url.searchParams.get('path') || undefined;
	try {
		const abs = resolveNotebookPath(path);
		const cells = listCells(path);
		const filename = exportFilename(abs);
		const html = renderNotebookHtml({ cells, title: filename.replace(/\.html$/i, '') });
		return new Response(html, {
			headers: {
				'content-type': 'text/html; charset=utf-8',
				'content-disposition': `attachment; filename="${filename.replace(/["\\]/g, '')}"`,
				'cache-control': 'no-store'
			}
		});
	} catch (err) {
		throw error(400, String(err?.message ?? err));
	}
}
