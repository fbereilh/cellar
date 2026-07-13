import { json } from '@sveltejs/kit';
import { sendWidgetComm } from '$lib/server/kernel';
import { updateWidget } from '$lib/server/widgets';

/**
 * The browser → kernel widget-interaction endpoint (the return direction #86
 * lacked). An interactive widget in the browser POSTs here when the user drives
 * it; we forward a `comm_msg` to the model living in the kernel so ipywidgets
 * updates the Python trait + fires its `observe`/`interact` callbacks. Any
 * resulting state (changed traits, an `interact` Output re-run) flows back over
 * the existing SSE receive path.
 *
 * Body:
 *   { method: 'update', state: { <trait>: <value> } }  — a value change
 *   { method: 'custom', content: { event: 'click' } }  — a Button press
 *
 * For an `update` we also merge the new trait into the server store and rebroadcast
 * it, because the kernel does NOT echo a frontend-originated change back as a plain
 * `update` — this is what keeps a second open tab (and this tab, idempotently) in
 * sync. A kernel-side clamp/observer that overrides the value arrives as a real
 * `update` and reconciles on top.
 */
export async function POST({ params, request }) {
	const commId = params.commId;
	let body;
	try {
		body = await request.json();
	} catch {
		return json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
	}
	const method = body?.method;
	try {
		if (method === 'update') {
			const state = body.state && typeof body.state === 'object' ? body.state : {};
			sendWidgetComm(commId, { method: 'update', state });
			updateWidget(commId, state);
			return json({ ok: true });
		}
		if (method === 'custom') {
			const content = body.content && typeof body.content === 'object' ? body.content : {};
			sendWidgetComm(commId, { method: 'custom', content });
			return json({ ok: true });
		}
		return json({ ok: false, error: `unsupported method: ${method}` }, { status: 400 });
	} catch (err) {
		// Unknown/dead comm (widget from a prior session): 409, not a 500.
		return json({ ok: false, error: err?.message ?? String(err) }, { status: 409 });
	}
}
