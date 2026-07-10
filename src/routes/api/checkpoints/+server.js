import { json, error } from '@sveltejs/kit';
import {
	listCheckpoints,
	createCheckpoint,
	restoreCheckpoint,
	undoLastAgentAction
} from '$lib/server/checkpoints.js';

/**
 * Notebook checkpoints — the human-facing snapshot/restore surface.
 *
 * GET  ?path=      → { checkpoints } (newest first, metadata only) for a notebook.
 * POST { path, action, ... }:
 *   - action:'create'  { label? }        → take a manual checkpoint now.
 *   - action:'restore' { id, originId }  → restore the notebook to a checkpoint.
 *   - action:'undo-agent' { originId }   → restore the newest pre-agent-run checkpoint.
 *
 * Every response echoes the fresh `checkpoints` list so the UI updates in one round
 * trip. `path` is a workspace-relative notebook path (defaults to the active one).
 */
export function GET({ url }) {
	const path = url.searchParams.get('path') || undefined;
	try {
		return json({ checkpoints: listCheckpoints(path) });
	} catch (err) {
		throw error(400, String(err?.message ?? err));
	}
}

export async function POST({ request }) {
	const { path, action, id, label, originId } = await request.json().catch(() => ({}));
	try {
		if (action === 'create') {
			const created = createCheckpoint(path, { trigger: 'manual', label });
			return json({ ok: true, created, checkpoints: listCheckpoints(path) });
		}
		if (action === 'restore') {
			const result = restoreCheckpoint(path, id, originId);
			if (!result.ok) throw error(404, 'checkpoint not found');
			return json({ ...result, checkpoints: listCheckpoints(path) });
		}
		if (action === 'undo-agent') {
			const result = undoLastAgentAction(path, originId);
			return json({ ...result, checkpoints: listCheckpoints(path) });
		}
		throw error(400, 'unknown action');
	} catch (err) {
		if (err?.status) throw err; // a SvelteKit error() - preserve its status
		throw error(400, String(err?.message ?? err));
	}
}
