import { json, error } from '@sveltejs/kit';
import { readWorkspaceFile, writeWorkspaceFile } from '$lib/server/fstree.js';

/** Read a workspace file's text content (for opening it into an editor tab). */
export function GET({ url }) {
	const path = url.searchParams.get('path');
	if (!path) throw error(400, 'path required');
	try {
		return json({ path, content: readWorkspaceFile(path) });
	} catch (err) {
		throw error(400, String(err?.message ?? err));
	}
}

/** Save an edited file tab back to disk. */
export async function PUT({ request }) {
	const { path, content } = await request.json();
	if (!path) throw error(400, 'path required');
	try {
		writeWorkspaceFile(path, content ?? '');
		return json({ ok: true });
	} catch (err) {
		throw error(400, String(err?.message ?? err));
	}
}
