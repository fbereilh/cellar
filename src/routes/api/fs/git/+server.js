import { json } from '@sveltejs/kit';
import { gitStatus, gitBranch } from '$lib/server/git';

/**
 * Per-file git status + ignored paths + current branch for the sidebar file
 * tree (VS Code-style decorations). One HTTP round-trip; the sidebar refreshes
 * it on the same signals (mount / focus / save) so a checkout or commit made
 * outside cellar is reflected.
 */
export async function GET() {
	const [status, branch] = await Promise.all([gitStatus(), gitBranch()]);
	return json({ ...status, branch: branch.branch, detached: branch.detached });
}
