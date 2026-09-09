import { json } from '@sveltejs/kit';
import { setNotebookLanguage, getExportTargetState } from '$lib/server/notebook';
import { TextNotebookLanguageError } from '$lib/cellLanguage';

/**
 * Set the notebook's LANGUAGE - the ONE authority for python-vs-mojo. Every plain
 * `code` cell in the notebook is written in it; markdown, raw, SQL and chat cells
 * are untouched, because nothing per-cell is written at all.
 *
 * POST { language:'python'|'mojo', path?, originId? } -> the applied value, PLUS
 * the resulting export-target state. The target's extension follows the language,
 * so a switch can MOVE it (`utils.py` -> `utils.mojo`); the initiating tab
 * suppresses its own `notebook:export-target` echo by `originId`, so the reply is
 * the only thing that can settle its target field.
 * `path` is the workspace-relative notebook (defaults to the active one).
 *
 * A refusal is the `{ok:false, reason, message}` 400 the cell routes already
 * answer in, rather than a bare `error()` string: the browser reverts an
 * optimistic switch on it and SAYS why, and it must tell the two apart WITHOUT
 * matching message text (the `InvalidExportTargetError` rule). The reason for a
 * `.py` text notebook rides on the error TYPE, so it is never re-derived here.
 */
export async function POST({ request }) {
	const body = await request.json().catch(() => ({}));
	try {
		const language = setNotebookLanguage(String(body.language ?? ''), body.path, body.originId);
		return json({ ok: true, language, exportTarget: getExportTargetState(body.path) });
	} catch (err) {
		const reason = err instanceof TextNotebookLanguageError ? err.reason : 'bad-language';
		return json({ ok: false, reason, message: String(err?.message ?? err) }, { status: 400 });
	}
}
