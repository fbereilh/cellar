import { json } from '@sveltejs/kit';
import { restartKernel } from '$lib/server/kernel';
import { resolveNotebookPath } from '$lib/server/notebook';

/**
 * Restart ONE notebook's kernel: restarts its process (clears that notebook's
 * namespace — the "wipe this notebook from memory" affordance) while keeping the
 * same connection/session, so the notebook document and MCP session stay intact —
 * the same path the agent interface proved kernel-restart-proof. Other notebooks'
 * kernels are untouched. `path` is the notebook (workspace-relative or absolute);
 * omitting it targets the active notebook.
 */
export async function POST({ request }) {
	try {
		const { path } = await request.json().catch(() => ({}));
		const info = await restartKernel(path ? resolveNotebookPath(path) : null);
		return json({ ok: true, ...info });
	} catch (err) {
		return json({ ok: false, message: String(err?.message ?? err) }, { status: 500 });
	}
}
