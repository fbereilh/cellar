import { json, error } from '@sveltejs/kit';
import {
	InvalidExportTargetError,
	setExportTarget,
	setExportBase,
	getExportTargetState,
	exportPy,
	isPyTextNotebook
} from '$lib/server/notebook';

/**
 * nbdev-style selective export of a notebook to a `.py` module (distinct from the
 * jupytext whole-notebook `.py` mirror under `/api/notebooks/jupytext`).
 *
 * POST { op:'set-target', target, base?, path?, originId? } → set/clear the
 *   notebook's `export_target` (a `.py` path relative to `base` - 'workspace'
 *   (default), 'notebook' or 'git'; '' clears it). EVERY outcome - stored,
 *   refused, or written-but-not-saved - answers with the full stored state
 *   (`target`, `base`, `resolved`, `resolveError`): the values the document
 *   HOLDS once this call is done, never the ones it was handed (`setExportTarget`
 *   normalizes an absolute in-workspace path to the base-relative form). That is
 *   what lets the tab keep NO copy of server state: its input and base select
 *   adopt these values on every reply, so a refusal puts both back to what the
 *   server really holds rather than to a locally remembered baseline that the
 *   two of them then have to be kept agreeing. Its own `notebook:export-target`
 *   event is echo-suppressed, so this response is the only thing that can
 *   correct the field.
 * POST { op:'set-base', base, path?, originId? } → RE-EXPRESS the stored target
 *   under a new base: the same file, a new spelling (reinterpreting the typed
 *   text against the new base would silently retarget a different file). A call
 *   with no stored target is an honest no-op reporting the current state - the
 *   tab keeps a pre-target base choice locally. Same reply shape, same refusal
 *   split as set-target.
 * POST { op:'export', path?, originId? }             → regenerate the module now
 *   and return `{ written, target, count, reason?, hazards }`. A no-op (no
 *   target / no marked cells) reports its `reason` rather than erroring.
 *   `hazards` (`$lib/exportHazard`) names constructs in the marked cells that
 *   make the written module uncompilable, so the caller cannot report a plain
 *   success for a file that will not import; it rides on `unchanged` too, and
 *   an empty list means none of the checks fired, never "the module compiles".
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
		if (body.op === 'set-target')
			return applyTargetWrite(body, () =>
				setExportTarget(
					optionalText(body.target, 'target'),
					body.path,
					body.originId,
					optionalText(body.base, 'base')
				)
			);
		if (body.op === 'set-base')
			return applyTargetWrite(body, () =>
				setExportBase(optionalText(body.base, 'base') ?? '', body.path, body.originId)
			);
		if (body.op === 'export') {
			return json({ ok: true, ...exportPy(body.path) });
		}
		throw new Error(`unknown op: ${JSON.stringify(body.op)}`);
	} catch (err) {
		throw error(400, String(err?.message ?? err));
	}
}

/**
 * A request field as a string, or null when it is ABSENT.
 *
 * `body` is untyped JSON and both fields reach a `.trim()` in the setter, so a
 * boolean/number/object survived `??` and threw a bare `TypeError` - which is NOT
 * an `InvalidExportTargetError`, so `applyTargetWrite` took the FAILED-WRITE
 * branch and answered 500 `{writeFailed, ...}` over a document nothing had
 * mutated. The tab then reported a malformed request as "accepted but not saved"
 * and, because `exportPy` deliberately does not abort on `writeFailed`, a later
 * export ran against the OLD target and called it a success: exactly the false
 * acceptance that flag exists to prevent.
 *
 * A PRESENT non-string is therefore REFUSED, never coerced - `target` would
 * coerce to a CLEAR (deleting both keys on malformed input) and `base` to a
 * silent inherit, and a direct API caller has no field on screen to notice the
 * repair in (the `affixText` rule, for the same reason). ABSENT keeps its
 * meaning: clearing for `target`, inheriting the stored base for `base`. Thrown
 * as the typed refusal so the reply is the ordinary 400 + held state every other
 * refusal answers with.
 */
function optionalText(v, field) {
	if (v === undefined || v === null) return null;
	if (typeof v !== 'string')
		throw new InvalidExportTargetError(
			`${field} must be a string, got ${Array.isArray(v) ? 'array' : typeof v}`
		);
	return v;
}

/**
 * Every reply carries the stored state (`held`) = what the document holds now, so
 * a refusal is answered with the values the field and base select should go back
 * to. That is why the refusals below are RETURNED as a json 400 rather than thrown
 * through `error()`, whose body is a bare `{message}`: without the state the tab
 * would have to remember one. One shared shape for both write ops - the reply
 * contract is identical, only the mutation differs.
 *
 * It reads that state through the doc layer's OWN `getExportTargetState`, never a
 * second copy: a refusal is the only thing that can correct the tab's field and
 * base select, so a route-local rule reading the base differently from the setter
 * would answer a refusal and a success with two different readings of one
 * document.
 */
function applyTargetWrite(body, write) {
	const held = () => {
		try {
			return getExportTargetState(body.path);
		} catch {
			return { target: null, base: 'workspace', resolved: null, resolveError: null };
		}
	};
	if (isPyTextNotebook(body.path))
		return json(
			{
				ok: false,
				message:
					'cannot set an export target on a .py text notebook: it stores no cell metadata and generates no module - convert it to .ipynb first',
				...held()
			},
			{ status: 400 }
		);
	try {
		return json({ ok: true, ...write() });
	} catch (err) {
		if (err instanceof InvalidExportTargetError)
			return json({ ok: false, message: String(err.message ?? err), ...held() }, { status: 400 });
		// The path was ACCEPTED and the live document holds it, so `held()` reports the
		// NEW target: the field keeps it, and the notebook's next successful save writes it.
		return json({ ok: false, writeFailed: String(err?.message ?? err), ...held() }, { status: 500 });
	}
}
