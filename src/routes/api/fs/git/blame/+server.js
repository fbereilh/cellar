import { json, error } from '@sveltejs/kit';
import { gitBlameFile } from '$lib/server/git';

/**
 * Per-line git blame for one workspace file, cached client-side per file version
 * and indexed by the cursor line (see the status-bar blame in `FileTab.svelte`).
 *
 *   GET /api/fs/git/blame?path=src/foo.py
 *     → { isRepo, tracked, lines: [{ commit, shortSha, author, authorTime, summary, notCommitted }, …] }
 *
 * `tracked:false` (empty `lines`) means "no blame to show" — a non-git workspace,
 * an untracked/new file, or a binary blob. The caller then hides the blame.
 */
export async function GET({ url }) {
	const path = url.searchParams.get('path');
	if (!path) error(400, 'path required');

	try {
		return json(await gitBlameFile(path));
	} catch (err) {
		error(400, String(err?.message ?? err));
	}
}
