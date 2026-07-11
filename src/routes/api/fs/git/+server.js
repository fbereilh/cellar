import { json } from '@sveltejs/kit';
import { gitStatus } from '$lib/server/git';

/** Per-file git status for the sidebar file tree (VS Code-style decorations). */
export async function GET() {
	return json(await gitStatus());
}
