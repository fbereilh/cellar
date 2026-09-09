import { json } from '@sveltejs/kit';
import {
	setNotebookLanguage,
	getExportTargetState,
	getNotebookLanguage,
	isNotebookUnavailable
} from '$lib/server/notebook';
import { InvalidNotebookLanguageError, TextNotebookLanguageError } from '$lib/cellLanguage';
import { reasonWithoutServerPath } from '$lib/serverMessage';

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
 * EVERY reply carries the language the document HOLDS once the call is done, so
 * the select adopts it on any outcome rather than keeping a locally remembered
 * baseline the two then have to be kept agreeing about (the `set-target` reply
 * contract).
 *
 * A REFUSED language and a FAILED WRITE answer differently, told apart BY TYPE
 * exactly as `/api/notebooks/export-py` does and never by matching message text:
 * `setNotebookLanguage` VALIDATES before it mutates (an unknown language, or
 * `mojo` on a `.py` text notebook - both typed), and OPENS the document before
 * that (`isNotebookUnavailable`: the file is gone, unreadable or does not parse,
 * which an open tab reaches when the notebook is deleted or renamed outside
 * Cellar). So its one REMAINING throw is the `persist`, a disk failure
 * (EACCES/ENOSPC, a read-only checkout) over a language the live document already
 * HOLDS and that its next successful save will write.
 *
 * THE OPEN FAILURE IS ITS OWN OUTCOME, never `writeFailed`: nothing was applied,
 * so claiming the language took and only the save failed is false in both halves
 * - it points at a save that was never the problem and asserts a change that never
 * happened. It answers the REFUSAL shape (which the select reverts on) carrying no
 * `language`, so the tab keeps the value it already had rather than adopting a
 * `python` nothing observed, and its message is stripped of the absolute server
 * path the doc layer's throw carries (`reasonWithoutServerPath`).
 * Reported as the same 400, the tab took the refusal branch and left the select
 * saying Python while `run.ts` compiled every code cell as Mojo, with nothing
 * left to correct it (no event is emitted on that path, and this tab would
 * echo-suppress it anyway). So a write failure keeps its own 5xx the client tells
 * apart BY THE `writeFailed` FLAG - never by the status code, since any other 5xx
 * (a proxy 502/503, an HTML error page) landed no verdict at all and must not be
 * reported as accepted.
 */
export async function POST({ request }) {
	const body = await request.json().catch(() => ({}));
	// What the document holds NOW - read after the attempt, so a refusal reports the
	// unchanged value and a failed write reports the one it really took.
	const held = () => {
		try {
			return { language: getNotebookLanguage(body.path), exportTarget: getExportTargetState(body.path) };
		} catch {
			return { language: 'python', exportTarget: null };
		}
	};
	try {
		const language = setNotebookLanguage(String(body.language ?? ''), body.path, body.originId);
		return json({ ok: true, language, exportTarget: getExportTargetState(body.path) });
	} catch (err) {
		if (isNotebookUnavailable(err)) {
			const why = reasonWithoutServerPath(String(err?.message ?? err));
			return json(
				{
					ok: false,
					reason: 'notebook-unavailable',
					message: `the notebook could not be opened, so its language is unchanged${why ? ` (${why})` : ''}`
				},
				{ status: 409 }
			);
		}
		if (err instanceof TextNotebookLanguageError || err instanceof InvalidNotebookLanguageError)
			return json(
				{ ok: false, reason: err.reason, message: String(err.message ?? err), ...held() },
				{ status: 400 }
			);
		// The language was ACCEPTED and the live document holds it, so `held()` reports
		// the NEW one: the select keeps it, and the notebook's next successful save
		// writes it.
		return json({ ok: false, writeFailed: String(err?.message ?? err), ...held() }, { status: 500 });
	}
}
