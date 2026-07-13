import { json, error } from '@sveltejs/kit';
import { setHeaderNumbering } from '$lib/server/notebook';

/**
 * Set which heading levels (1-6) render with a display-only auto-number. The
 * numbers are computed at render time and never written to a cell's markdown
 * source; this only persists *which levels* are numbered, in the allowlisted
 * `cellar` namespace (round-trips through clean-on-save, so the `.ipynb` stays
 * git-clean apart from the level set itself).
 *
 * POST { levels:number[], path?, originId? } → the sanitized enabled levels.
 * `path` is the workspace-relative notebook (defaults to the active one).
 */
export async function POST({ request }) {
	const body = await request.json().catch(() => ({}));
	try {
		const levels = setHeaderNumbering(body.levels ?? [], body.path, body.originId);
		return json({ ok: true, levels });
	} catch (err) {
		throw error(400, String(err?.message ?? err));
	}
}
