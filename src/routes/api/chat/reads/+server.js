import { json } from '@sveltejs/kit';
import { chatReadsBlockedCause } from '$lib/server/chat/claude-cli';
import { workspaceRoot } from '$lib/server/fstree';
import { resolveNotebookPath } from '$lib/server/notebook';

/**
 * Can workspace reads be granted here, and if not, why - the verdict the Settings
 * pane REPORTS at its toggle.
 *
 * Its OWN route, deliberately, rather than a field on `/api/chat/status`: that
 * one awaits `resolveChatAuth()` + `listChatSlots()`, i.e. a `claude auth status`
 * spawn for the ambient account and one per configured slot. Riding it made
 * opening the Settings modal spawn the CLI for every user - including everyone
 * who never touches chat cells - and put this notice behind authentication
 * latency, which also widened the window in which a stale verdict could render.
 * The verdict is a pure function of two path strings and has no business behind
 * an authentication route, so it gets a route that imports nothing auth-related
 * and spawns nothing.
 *
 * The answer carries the offending SEGMENT and the KIND of refusal, not just a
 * cause: the pane can only name what the verdict identified, and guessing the
 * notebook's own file name is wrong on a reachable path (an un-patternable
 * ancestor DIRECTORY raises the notebook cause too). A `platform` refusal is
 * structural - the POSIX-only rule prefix - so no rename can fix it and the pane
 * must not offer one.
 *
 * `?notebook=` is workspace-relative. Without it only the WORKSPACE half can be
 * decided, and the notebook half is left explicitly UNDECIDED rather than
 * reported as available - answering a question that was not asked is how a
 * silent capability gap gets reported as healthy.
 */
export function GET({ url }) {
	const nb = url.searchParams.get('notebook');
	const root = workspaceRoot();
	let notebookPath = null;
	if (nb) {
		try {
			notebookPath = resolveNotebookPath(nb);
		} catch {
			// An unresolvable notebook is not this route's error to raise: answer the
			// workspace half and leave the notebook half unclaimed.
			notebookPath = null;
		}
	}
	const blocked = chatReadsBlockedCause(root, notebookPath ?? root);
	// With no notebook in hand, a `notebook` verdict is about the placeholder we
	// substituted, not about anything the caller asked - drop it.
	const relevant = notebookPath === null && blocked?.cause === 'notebook' ? null : blocked;
	return json({
		decided: notebookPath !== null ? 'both' : 'workspace',
		available: relevant === null,
		...(relevant ? { blocked: relevant, ...(relevant.cause === 'notebook' && nb ? { notebook: nb } : {}) } : {})
	});
}
