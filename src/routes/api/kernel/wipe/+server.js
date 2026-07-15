import { json } from '@sveltejs/kit';
import { wipeKernelVariables } from '$lib/server/kernel';
import { resolveNotebookPath, listCells, clearLastRunStamps } from '$lib/server/notebook';
import { cellsDefiningNames } from '$lib/server/dataflow';
import { connectionStatus } from '$lib/server/databricks';

/**
 * Wipe ONE notebook's user-defined DATA variables from its kernel namespace to
 * free memory — WITHOUT restarting. The kernel process, its session, and the epoch
 * are all unchanged (a subsequent cell runs instantly), so this is a scalpel, not
 * the Restart control: it keeps imports, user-defined functions/classes, and a
 * live Databricks session. `path` is the notebook (workspace-relative or absolute);
 * omitting it targets the active notebook. Other notebooks' kernels are untouched.
 *
 * `spark`/`w` are preserved when a Databricks session is live, because
 * `connectionStatus()` reconciles on the (unchanged) epoch, not on whether `spark`
 * is bound — dropping the binding here would leave it falsely reporting connected.
 *
 * After the kernel drops the variables, the runtime-only `lastRun` stamp is cleared
 * from the cells that defined them (`cellsDefiningNames`), so the existing staleness
 * machinery reports those cells "not run this session" and their dependents "stale".
 * `lastRun` is never persisted, so the `.ipynb` is untouched.
 */
export async function POST({ request }) {
	try {
		const { path } = await request.json().catch(() => ({}));
		const nb = path ? resolveNotebookPath(path) : null;
		// Keep the Databricks session bindings iff a connection is live for this notebook.
		const preserve = connectionStatus(nb).connected ? ['spark', 'w'] : [];
		const { status, cleared, session_id, probe_failed } = await wipeKernelVariables(nb, { preserve });
		// Reflect the wipe in staleness. Normally clear the run stamp of exactly the
		// cells that defined a wiped name; if the probe could not report the names
		// (a rare kernel quirk), fall back to clearing every code cell — the safe,
		// over-invalidating direction the run-status doctrine prefers.
		const ids = probe_failed
			? listCells(nb).filter((c) => c.cell_type === 'code').map((c) => c.id)
			: await cellsDefiningNames(cleared, nb);
		const stamps_cleared = clearLastRunStamps(ids, nb);
		return json({ ok: true, status, cleared, count: cleared.length, stamps_cleared, session_id });
	} catch (err) {
		return json({ ok: false, message: String(err?.message ?? err) }, { status: 500 });
	}
}
