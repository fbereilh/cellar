import { json, error } from '@sveltejs/kit';
import { getNotebook, setActiveNotebook } from '$lib/server/notebook.js';

/**
 * Live notebook documents. GET loads a workspace `.ipynb` as a live,
 * kernel-attached document and returns its cells; POST makes a notebook the
 * active one that the agent-facing (MCP) tools default to. Both address the
 * notebook by its workspace-relative path (`path` query / body); omitting it
 * targets the default workspace notebook.
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
	const { path } = await request.json().catch(() => ({}));
	try {
		return json({ ok: true, notebook: setActiveNotebook(path) });
	} catch (err) {
		throw error(400, String(err?.message ?? err));
	}
}
