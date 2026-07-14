import { json } from '@sveltejs/kit';
import { shutdownKernel } from '$lib/server/kernel';
import { resolveNotebookPath } from '$lib/server/notebook';

/**
 * Shut ONE notebook's kernel down: terminate the process and REMOVE its entry, so
 * its card drops from the Kernels sidebar and its memory is freed — unlike restart,
 * which keeps the process and only clears the namespace. The document and MCP
 * session are untouched; the notebook lazily gets a fresh kernel on its next run.
 * `path` is the notebook (workspace-relative or absolute); omitting it targets the
 * active notebook.
 */
export async function POST({ request }) {
	try {
		const { path } = await request.json().catch(() => ({}));
		const info = await shutdownKernel(path ? resolveNotebookPath(path) : null);
		return json({ ok: true, ...info });
	} catch (err) {
		return json({ ok: false, message: String(err?.message ?? err) }, { status: 500 });
	}
}
