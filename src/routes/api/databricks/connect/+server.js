import { json } from '@sveltejs/kit';
import { connect, disconnect, statusFor } from '$lib/server/databricks';

/**
 * Connect: build `spark` + `w` inside the shared kernel against the chosen
 * cluster. This is the one Databricks call that runs IN the kernel, because the
 * kernel namespace is the only place the user's cells can reach the session.
 *
 * It boots the kernel if none is running, and can legitimately take minutes when
 * the cluster is cold (Databricks Connect starts a terminated cluster and waits
 * for it), so the client shows a spinner rather than a timeout.
 */
export async function POST({ request }) {
	const { profile, host, clusterId, clusterName, path } = await request.json();
	try {
		// `path` binds `spark`/`w` into THAT notebook's kernel (each notebook has its
		// own kernel + Databricks session); omitting it targets the active notebook.
		return json(await connect({ profile, host, clusterId, clusterName, nb: path }));
	} catch (err) {
		const code = err?.code ?? 'error';
		return json({ code, message: String(err?.message ?? err) }, { status: statusFor(code) });
	}
}

/** Disconnect: stop this notebook's session and unbind `spark`/`w` from its namespace. */
export async function DELETE({ url }) {
	try {
		return json(await disconnect(url.searchParams.get('path')));
	} catch (err) {
		const code = err?.code ?? 'error';
		return json({ code, message: String(err?.message ?? err) }, { status: statusFor(code) });
	}
}
