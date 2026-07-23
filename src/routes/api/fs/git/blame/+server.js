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
 *
 * The file form also answers `tooLarge:true` (and spawns no `git blame`) past
 * `MAX_DECORATION_BYTES`: a whole-file `--line-porcelain` of a multi-MB export
 * costs seconds and tens of MB of stdout. That is a distinct fact from
 * untracked, so the status bar says "too large for blame" rather than hiding.
 * The notebook form is not gated — its blame is already scoped to source-line
 * ranges with `-L`, so its cost tracks source, not file size.
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
