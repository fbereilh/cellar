import { json, error } from '@sveltejs/kit';
import { readWorkspaceFile } from '$lib/server/fstree';
import { JupytextError, detectPyNotebook, ensureJupytext, isPyPath, statusFor } from '$lib/server/jupytext';
import { exportNotebookAsPy, convertPyToIpynb } from '$lib/server/jupytext-actions';

/**
 * jupytext / Databricks `.py` notebook support.
 *
 * GET  ?path=foo.py  — should Cellar open this `.py` as a live notebook?
 *   Returns `{ notebook, format, ready }`. `notebook` is content-detected (an
 *   explicit Databricks / percent / jupytext marker; a plain script is not one).
 *   When it is a notebook, jupytext is ensured in the project venv so opening it
 *   actually works; `ready:false` (with a `message`) means the environment could
 *   not be prepared and the caller should fall back to opening it as text.
 *
 * POST { op }  — the two human-invoked actions:
 *   op:'export'  { source, target, format }         → save a notebook as `.py`
 *   op:'convert' { source, target, originId }        → run a `.py`, write `.ipynb`
 */
export async function GET({ url }) {
	const path = url.searchParams.get('path');
	if (!path) throw error(400, 'path required');
	if (!isPyPath(path)) return json({ notebook: false });
	let text;
	try {
		text = readWorkspaceFile(path);
	} catch (err) {
		// Unreadable / binary / too large → definitely not a live notebook.
		return json({ notebook: false, message: String(err?.message ?? err) });
	}
	const det = detectPyNotebook(text);
	if (!det.notebook) return json({ notebook: false });
	try {
		await ensureJupytext();
		return json({ notebook: true, format: det.format, ready: true });
	} catch (err) {
		return json({ notebook: true, format: det.format, ready: false, message: err?.message ?? String(err) });
	}
}

export async function POST({ request }) {
	const body = await request.json().catch(() => ({}));
	try {
		if (body.op === 'export') {
			return json({ ok: true, ...(await exportNotebookAsPy(body)) });
		}
		if (body.op === 'convert') {
			return json({ ok: true, ...(await convertPyToIpynb({ ...body, actor: 'user' })) });
		}
		throw new JupytextError('bad_request', `unknown op: ${JSON.stringify(body.op)}`);
	} catch (err) {
		if (err instanceof JupytextError) throw error(statusFor(err.code), err.message);
		throw error(400, String(err?.message ?? err));
	}
}
