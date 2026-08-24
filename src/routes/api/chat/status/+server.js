import { json } from '@sveltejs/kit';
import { invalidateChatAuthCache, listChatSlots, resolveChatAuth } from '$lib/server/chat/auth';
import { chatReadsBlockedCause } from '$lib/server/chat/claude-cli';
import { workspaceRoot } from '$lib/server/fstree';
import { resolveNotebookPath } from '$lib/server/notebook';

/**
 * Chat account status for the sidebar: which credential a chat run would use
 * RIGHT NOW (the same `resolveChatAuth` the run path calls, so the panel and
 * the engine can never disagree) plus every named Cellar slot with who is
 * signed in to it. `?fresh=1` drops the short-lived probe cache first - the
 * panel's manual refresh, so "am I signed in yet" answers from the CLI, not
 * from a 5s-old memo. Identity only; a token never rides this response.
 *
 * It also carries the workspace-reads availability verdict (`reads`), which the
 * Settings pane REPORTS at its toggle. That capability fails closed on a
 * workspace path or notebook name Cellar cannot express as a literal permission
 * rule, and the fallback is otherwise SILENT - the toggle stays on and the copy
 * still promises reads while only the model is told otherwise. The cause is
 * reported separately for the two halves because a `notebook` verdict is about
 * one notebook (its neighbour still reads) while a `workspace` one covers
 * everything here. It is a pure predicate over paths - no CLI spawn, so it adds
 * nothing to this route's cost - and it answers from the SAME rule the engine
 * applies, so the pane cannot promise what the run would refuse.
 */
export async function GET({ url }) {
	if (url.searchParams.get('fresh')) invalidateChatAuthCache();
	const [resolution, slots] = await Promise.all([resolveChatAuth(), listChatSlots()]);
	return json({ resolution, slots, reads: readsAvailability(url.searchParams.get('notebook')) });
}

/**
 * `{available, cause, notebook}` for the caller's notebook. `notebook` is echoed
 * back (workspace-relative, as asked for) ONLY on the per-notebook cause, since
 * that is the report that has to name which notebook is at fault; a request that
 * names no notebook still answers the workspace half, which is the part that
 * holds for the whole pane.
 */
function readsAvailability(nb) {
	const root = workspaceRoot();
	let notebookPath = null;
	try {
		notebookPath = nb ? resolveNotebookPath(nb) : null;
	} catch {
		// An unresolvable notebook is not this route's error to raise: answer the
		// workspace half and leave the notebook half unclaimed.
		notebookPath = null;
	}
	// With no notebook in hand only the workspace half can be decided. Passing a
	// known-good placeholder would invent a verdict, so the notebook half is
	// simply not answered.
	const cause = notebookPath === null ? (chatReadsBlockedCause(root, '/placeholder/x.ipynb') === 'workspace' ? 'workspace' : null) : chatReadsBlockedCause(root, notebookPath);
	return { available: cause === null, cause, ...(cause === 'notebook' && nb ? { notebook: nb } : {}) };
}
