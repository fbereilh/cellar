import { json, error } from '@sveltejs/kit';
import { setHideAllCode } from '$lib/server/notebook';

/**
 * Toggle the notebook-wide "hide all code inputs" default (a clean output-only
 * report view). This is the default for cells with no explicit per-cell
 * `cellar.hide_input`; a per-cell choice always wins. It is display only - no
 * cell source is touched - and rides the allowlisted `cellar` namespace, so the
 * `.ipynb` stays git-clean apart from the flag itself.
 *
 * POST { hidden:boolean, path?, originId? } → the applied value.
 * `path` is the workspace-relative notebook (defaults to the active one).
 */
export async function POST({ request }) {
	const body = await request.json().catch(() => ({}));
	try {
		const hidden = setHideAllCode(!!body.hidden, body.path, body.originId);
		return json({ ok: true, hidden });
	} catch (err) {
		throw error(400, String(err?.message ?? err));
	}
}
