import { json } from '@sveltejs/kit';
import { interruptKernel } from '$lib/server/kernel';
import { resolveNotebookPath } from '$lib/server/notebook';

/**
 * Interrupt ONE notebook's kernel (SIGINT equivalent) — stops its running cell.
 * `path` is the notebook (workspace-relative or absolute); omitting it targets the
 * active notebook. Other notebooks are untouched.
 */
export async function POST({ request }) {
	try {
		const { path } = await request.json().catch(() => ({}));
		const info = await interruptKernel(path ? resolveNotebookPath(path) : null);
		return json({ ok: true, ...info });
	} catch (err) {
		return json({ ok: false, message: String(err?.message ?? err) }, { status: 500 });
	}
}
