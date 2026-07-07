import { json } from '@sveltejs/kit';
import { buildTree } from '$lib/server/fstree.js';

/** List the workspace folder tree for the sidebar file tree. */
export function GET() {
	return json(buildTree());
}
