import { json } from '@sveltejs/kit';
import { inspectInKernel } from '$lib/server/kernel';
import { resolveNotebookPath } from '$lib/server/notebook';
import { readIntrospectRequest } from '$lib/server/introspect-request';

/**
 * The Shift+Tab documentation tooltip, from the LIVE kernel (Jupyter
 * `inspect_request`).
 *
 * `detail` is the protocol's own escalation and the whole of the second-press
 * behaviour: 0 is the signature plus docstring, 1 adds the source. Anything else
 * is a 400 rather than a silent clamp - the two levels are what the tooltip's
 * "press again to expand" promises, so an unrecognised one must not quietly
 * answer as level 0.
 *
 * Like its completion sibling this never starts a kernel and never queues behind
 * a running cell; a refusal comes back as a 200 `{ok:false, reason}` the tooltip
 * states to the user.
 */
export async function POST({ request }) {
	const req = await readIntrospectRequest(request);
	if (!req.ok) return json({ ok: false, reason: 'failed', message: req.message }, { status: 400 });
	if (req.detail !== 0 && req.detail !== 1)
		return json({ ok: false, reason: 'failed', message: 'detail must be 0 or 1' }, { status: 400 });
	return json(
		await inspectInKernel(req.path ? resolveNotebookPath(req.path) : null, req.code, req.cursorPos, req.detail)
	);
}
