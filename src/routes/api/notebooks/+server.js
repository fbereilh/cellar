import { json, error } from '@sveltejs/kit';
import { getNotebook, setActiveNotebook, createNotebook } from '$lib/server/notebook';

/**
 * Live notebook documents. GET loads a workspace `.ipynb` as a live,
 * kernel-attached document and returns its cells; POST makes a notebook the
 * active one that the agent-facing (MCP) tools default to, or (with
 * `create: true`) materializes it on disk first. Both address the notebook by
 * its workspace-relative path (`path` query / body); omitting it targets the
 * default workspace notebook.
 */
export function GET({ url }) {
	const path = url.searchParams.get('path') || undefined;
	try {
		return json({ notebook: getNotebook(path) });
	} catch (err) {
		throw error(400, String(err?.message ?? err));
	}
}

export async function POST({ request }) {
	const { path, create, originId } = await request.json().catch(() => ({}));
	try {
		// `create` writes the file (default notebook may exist only in memory) and
		// broadcasts `notebook:opened`; a plain POST just sets the active pointer.
		const notebook = create ? createNotebook(path, originId) : setActiveNotebook(path);
		return json({ ok: true, notebook });
	} catch (err) {
		throw error(400, String(err?.message ?? err));
	}
}
