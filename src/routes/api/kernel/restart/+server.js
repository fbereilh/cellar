import { json } from '@sveltejs/kit';
import { restartKernel } from '$lib/server/kernel.js';

/**
 * Restart the active kernel: restarts the process (clears the namespace) while
 * keeping the same connection/session, so the notebook document and MCP session
 * stay intact — the same path the agent interface proved kernel-restart-proof.
 */
export async function POST() {
	try {
		const info = await restartKernel();
		return json({ ok: true, ...info });
	} catch (err) {
		return json({ ok: false, message: String(err?.message ?? err) }, { status: 500 });
	}
}
