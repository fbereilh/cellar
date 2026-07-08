import { json } from '@sveltejs/kit';
import { interruptKernel } from '$lib/server/kernel.js';

/** Interrupt the active kernel (SIGINT equivalent) — stops a running cell. */
export async function POST() {
	try {
		const info = await interruptKernel();
		return json({ ok: true, ...info });
	} catch (err) {
		return json({ ok: false, message: String(err?.message ?? err) }, { status: 500 });
	}
}
