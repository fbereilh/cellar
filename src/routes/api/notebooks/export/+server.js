import { error } from '@sveltejs/kit';
import { buildNotebookHtml } from '$lib/server/export-html';

/**
 * Export a notebook to a single self-contained HTML file.
 *
 * Renders the notebook MODEL (cells + the persisted outputs already in the
 * `.ipynb`) server-side — it never touches the kernel, so the export reflects
 * the notebook's last run. `path` is the workspace-relative notebook (defaults
 * to the active one). The response is an HTML attachment so the browser
 * downloads it; the file opens standalone with no Cellar server.
 *
 * Report style: by default the export honors the notebook's "hide all code"
 * (report view) setting, so a notebook read as a clean report in Cellar exports
 * as one (markdown + outputs, no code). `?hideCode=1|0` explicitly forces the
 * report style on/off for a one-off export regardless of the saved setting.
 */
export function GET({ url }) {
	const path = url.searchParams.get('path') || undefined;
	const hideParam = url.searchParams.get('hideCode');
	try {
		const hideCode = hideParam == null ? undefined : hideParam === '1' || hideParam === 'true';
		const { html, filename } = buildNotebookHtml({ nb: path, hideCode });
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
