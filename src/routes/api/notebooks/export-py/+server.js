import { json, error } from '@sveltejs/kit';
import { setExportTarget, exportPy, isPyTextNotebook } from '$lib/server/notebook';

/**
 * nbdev-style selective export of a notebook to a `.py` module (distinct from the
 * jupytext whole-notebook `.py` mirror under `/api/notebooks/jupytext`).
 *
 * POST { op:'set-target', target, path?, originId? }  → set/clear the notebook's
 *   `export_target` (workspace-relative `.py` path; '' clears it) and answer with
 *   the value that was STORED, never the one it was handed: `setExportTarget`
 *   normalizes an absolute in-workspace path to its relative form, and the tab
 *   adopts this value as its baseline (its own `notebook:export-target` event is
 *   echo-suppressed), so reporting the raw request would leave the input showing
 *   a path the document does not hold.
 * POST { op:'export', path?, originId? }              → regenerate the module now
 *   and return `{ written, target, count, reason? }`. A no-op (no target / no
 *   marked cells) reports its `reason` rather than erroring.
 *
 * `path` is the workspace-relative notebook (defaults to the active one).
 *
 * A `.py` TEXT notebook is refused through the SAME `isPyTextNotebook` predicate
 * MCP's `set_export_target` uses — never a second check — because the reason is
 * the same on both surfaces: such a document is written through jupytext, which
 * stores no cellar metadata, so a target accepted here would survive neither a
 * reload nor a regeneration and the user would be shown a setting that does
 * nothing. (`op:'export'` is already refused inside `exportPy`.)
 */
export async function POST({ request }) {
	const body = await request.json().catch(() => ({}));
	try {
		if (body.op === 'set-target') {
			if (isPyTextNotebook(body.path))
				throw new Error(
					'cannot set an export target on a .py text notebook: it stores no cell metadata and generates no module - convert it to .ipynb first'
				);
			const stored = setExportTarget(body.target ?? null, body.path, body.originId);
			return json({ ok: true, target: stored });
		}
		if (body.op === 'export') {
			return json({ ok: true, ...exportPy(body.path) });
		}
		throw new Error(`unknown op: ${JSON.stringify(body.op)}`);
	} catch (err) {
		throw error(400, String(err?.message ?? err));
	}
}
