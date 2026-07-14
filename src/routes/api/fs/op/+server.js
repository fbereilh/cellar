import { json, error } from '@sveltejs/kit';
import {
	createEntry,
	renameEntry,
	deleteEntry,
	moveEntry,
	copyEntry
} from '$lib/server/fstree';
import { dropDocs, rekeyDocs } from '$lib/server/notebook';
import { shutdownKernelsUnder } from '$lib/server/kernel';

/**
 * File-management operations for the sidebar file explorer. A single POST
 * dispatched on `op`; every underlying helper is path-guarded to the workspace
 * and refuses to touch the workspace root. Returns `{ ok, ...result }` where
 * `result` carries the affected workspace-relative path(s) so the client can
 * refresh and update any open tab.
 */
export async function POST({ request }) {
	let body;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'invalid JSON body');
	}
	const { op } = body ?? {};
	try {
		switch (op) {
			case 'create':
				return json({ ok: true, ...createEntry(body.parent ?? '', body.name, body.kind) });
			case 'rename': {
				const res = renameEntry(body.path, body.name);
				if (res.from && res.from !== res.path) rekeyDocs(res.from, res.path);
				return json({ ok: true, ...res });
			}
			case 'delete': {
				const res = deleteEntry(body.path);
				dropDocs(res.path);
				// Free the kernel process(es) of the deleted notebook (or every notebook
				// under a deleted folder), not just the in-memory doc. Best-effort: a
				// failed shutdown must not fail the delete the user already committed to.
				shutdownKernelsUnder(res.path).catch(() => {});
				return json({ ok: true, ...res });
			}
			case 'move': {
				const res = moveEntry(body.path, body.dest ?? '');
				if (res.from && res.from !== res.path) rekeyDocs(res.from, res.path);
				return json({ ok: true, ...res });
			}
			case 'copy':
				return json({ ok: true, ...copyEntry(body.path, body.dest ?? '') });
			default:
				throw error(400, `unknown op: ${op}`);
		}
	} catch (err) {
		if (err?.status) throw err; // a SvelteKit error() from the default case
		throw error(400, String(err?.message ?? err));
	}
}
