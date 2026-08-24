import { json } from '@sveltejs/kit';
import { detectNbdev, protectCellarMetadata } from '$lib/server/nbdev';

/**
 * The nbdev metadata-preservation hazard: is this an nbdev project, and are
 * Cellar's two allowlist keys in its `pyproject.toml`?
 *
 * GET  → the current `NbdevState`. Cheap (a walk-up plus one TOML scan), so the
 *        sidebar re-reads it on the same signals it re-reads git decorations on:
 *        a file-tree change, or the window regaining focus after an edit made in
 *        a terminal.
 * POST → `{ op: 'protect' }` adds `cellar` to both allowlists and returns the
 *        state AFTERWARDS. There is deliberately NO path parameter: the target is
 *        derived server-side by the same detection the GET reports, so this can
 *        never be driven into writing a file the user was not shown.
 */
export function GET() {
	return json({ state: detectNbdev() });
}

export async function POST({ request }) {
	const body = await request.json().catch(() => ({}));
	if (body?.op !== 'protect') {
		return json({ ok: false, reason: 'unknown-op', state: detectNbdev() }, { status: 400 });
	}
	const result = protectCellarMetadata();
	// A refusal or a failed write is not an HTTP failure - the caller needs the
	// resulting state either way, and the card renders the reason from it.
	return json({ ok: result.status === 'written' || result.status === 'already', ...result });
}
