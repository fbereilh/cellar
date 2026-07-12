import { json, error } from '@sveltejs/kit';
import { setExportTarget, exportPy } from '$lib/server/notebook';

/**
 * nbdev-style selective export of a notebook to a `.py` module (distinct from the
 * jupytext whole-notebook `.py` mirror under `/api/notebooks/jupytext`).
 *
 * POST { op:'set-target', target, path?, originId? }  → set/clear the notebook's
 *   `export_target` (workspace-relative `.py` path; '' clears it).
 * POST { op:'export', path?, originId? }              → regenerate the module now
 *   and return `{ written, target, count, reason? }`. A no-op (no target / no
 *   marked cells) reports its `reason` rather than erroring.
 *
 * `path` is the workspace-relative notebook (defaults to the active one).
 */
export async function POST({ request }) {
	const body = await request.json().catch(() => ({}));
	try {
		if (body.op === 'set-target') {
			setExportTarget(body.target ?? null, body.path, body.originId);
			return json({ ok: true, target: (body.target ?? '').trim() || null });
		}
		if (body.op === 'export') {
			return json({ ok: true, ...exportPy(body.path) });
		}
		throw new Error(`unknown op: ${JSON.stringify(body.op)}`);
	} catch (err) {
		throw error(400, String(err?.message ?? err));
	}
}
