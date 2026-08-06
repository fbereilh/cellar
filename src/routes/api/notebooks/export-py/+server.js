import { json, error } from '@sveltejs/kit';
import {
	InvalidExportTargetError,
	getExportTarget,
	setExportTarget,
	exportPy,
	isPyTextNotebook
} from '$lib/server/notebook';

/**
 * nbdev-style selective export of a notebook to a `.py` module (distinct from the
 * jupytext whole-notebook `.py` mirror under `/api/notebooks/jupytext`).
 *
 * POST { op:'set-target', target, path?, originId? }  → set/clear the notebook's
 *   `export_target` (workspace-relative `.py` path; '' clears it). EVERY outcome —
 *   stored, refused, or written-but-not-saved — answers with `target`: the value the
 *   document HOLDS once this call is done, never the one it was handed
 *   (`setExportTarget` normalizes an absolute in-workspace path to its relative
 *   form). That is what lets the tab keep NO copy of server state: its input adopts
 *   this value on every reply, so a refusal puts the field back to what the server
 *   really holds rather than to a locally remembered baseline that the two of them
 *   then have to be kept agreeing. Its own `notebook:export-target` event is
 *   echo-suppressed, so this response is the only thing that can correct the field.
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
 *
 * A refused PATH and a failed WRITE answer differently, told apart by TYPE
 * (`InvalidExportTargetError`) exactly as MCP's `set_export_target` does, never by
 * matching the message text: `setExportTarget` validates BEFORE it mutates, so its
 * one other throw is the `persist` — a disk failure (EACCES/ENOSPC, a read-only
 * checkout) over a path that was never wrong and that the live document already
 * HOLDS, and that it will write with the notebook's next successful save. Reported
 * as the same 400, the tab took its refusal branch: it reverted the input to the
 * previous target and told the user it was not set, over a change that did take,
 * with nothing left to correct it (the success event is never emitted, and this tab
 * would echo-suppress it anyway). So a write failure keeps its own 5xx the client can
 * tell apart BY THE `writeFailed` FLAG — never by the status code, since any other
 * 5xx (a proxy 502/503, an HTML error page) is a request that landed no verdict at
 * all and must not be reported as accepted.
 */
export async function POST({ request }) {
	const body = await request.json().catch(() => ({}));
	try {
		if (body.op === 'set-target') return setTarget(body);
		if (body.op === 'export') {
			return json({ ok: true, ...exportPy(body.path) });
		}
		throw new Error(`unknown op: ${JSON.stringify(body.op)}`);
	} catch (err) {
		throw error(400, String(err?.message ?? err));
	}
}

/**
 * Every reply carries `target` = what the document holds now, so a refusal is
 * answered with the value the field should go back to. That is why the refusals
 * below are RETURNED as a json 400 rather than thrown through `error()`, whose body
 * is a bare `{message}`: without the target the tab would have to remember one.
 */
function setTarget(body) {
	const held = () => {
		try {
			return getExportTarget(body.path);
		} catch {
			return null;
		}
	};
	if (isPyTextNotebook(body.path))
		return json(
			{
				ok: false,
				message:
					'cannot set an export target on a .py text notebook: it stores no cell metadata and generates no module - convert it to .ipynb first',
				target: held()
			},
			{ status: 400 }
		);
	try {
		return json({ ok: true, target: setExportTarget(body.target ?? null, body.path, body.originId) });
	} catch (err) {
		if (err instanceof InvalidExportTargetError)
			return json({ ok: false, message: String(err.message ?? err), target: held() }, { status: 400 });
		// The path was ACCEPTED and the live document holds it, so `held()` reports the
		// NEW target: the field keeps it, and the notebook's next successful save writes it.
		return json({ ok: false, writeFailed: String(err?.message ?? err), target: held() }, { status: 500 });
	}
}
