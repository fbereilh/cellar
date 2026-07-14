import { json, error } from '@sveltejs/kit';
import { gitBlameFile, gitBlameNotebookCells } from '$lib/server/git';

/**
 * Git blame for a workspace file or notebook, cached client-side and indexed by
 * the cursor line (files) or the focused cell (notebooks). Both feed the same
 * bottom status-bar blame in the shell footer.
 *
 *   GET /api/fs/git/blame?path=src/foo.py
 *     → { isRepo, tracked, lines: [{ commit, shortSha, author, authorTime, summary, notCommitted }, …] }
 *
 *   GET /api/fs/git/blame?path=a.ipynb&kind=notebook
 *     → { isRepo, tracked, cells: { [cellId]: { …BlameLine } } }
 *
 * The notebook form blames the `.ipynb` per line, then reduces each cell to its
 * most-recent contributing commit (keyed by stable cell id). `tracked:false`
 * means "no blame to show" — a non-git workspace, an untracked/new file, or a
 * blob with no notebook to parse. The caller then hides the blame.
 */
export async function GET({ url }) {
	const path = url.searchParams.get('path');
	if (!path) error(400, 'path required');

	try {
		if (url.searchParams.get('kind') === 'notebook') {
			return json(await gitBlameNotebookCells(path));
		}
		return json(await gitBlameFile(path));
	} catch (err) {
		error(400, String(err?.message ?? err));
	}
}
