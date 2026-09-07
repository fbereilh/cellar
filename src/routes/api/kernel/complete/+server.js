import { json } from '@sveltejs/kit';
import { completeInKernel } from '$lib/server/kernel';
import { resolveNotebookPath } from '$lib/server/notebook';
import { readIntrospectRequest } from '$lib/server/introspect-request';

/**
 * Tab completion from the LIVE kernel (Jupyter `complete_request`).
 *
 * Answers for ONE notebook's kernel and never starts one - `completeInKernel`
 * refuses (`no_kernel`) rather than booting a Python process for a keystroke, and
 * likewise refuses a busy / restarting / disconnected kernel BY NAME instead of
 * queueing behind it. The editor treats every refusal as "no kernel completions"
 * and falls back to CodeMirror's own file-local sources, so this route never has
 * to fail loudly: a 200 carrying `{ok:false, reason}` IS the answer, and only a
 * malformed request is a 4xx.
 */
export async function POST({ request }) {
	try {
		const req = await readIntrospectRequest(request);
		if (!req.ok) return json({ ok: false, reason: 'failed', message: req.message }, { status: 400 });
		return json(await completeInKernel(req.path ? resolveNotebookPath(req.path) : null, req.code, req.cursorPos));
	} catch (err) {
		// `resolveNotebookPath` THROWS for a path that escapes the workspace, which is a
		// malformed request rather than anything the kernel said - so it takes the same
		// 400 shape as every other bad field instead of an unhandled 500.
		return json({ ok: false, reason: 'failed', message: String(err?.message ?? err) }, { status: 400 });
	}
}
