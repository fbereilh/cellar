import { json } from '@sveltejs/kit';
import { getVenvInfo, bindVenv } from '$lib/server/venv-bind.js';
import { rebindKernel } from '$lib/server/kernel.js';

/** Current venv binding for the Settings control. */
export async function GET() {
	return json(await getVenvInfo());
}

/**
 * Switch to a different venv (or create one via uv) and rebind the kernel onto
 * the new interpreter. Body: `{ path, create? }`.
 */
export async function POST({ request }) {
	let body;
	try {
		body = await request.json();
	} catch {
		body = {};
	}
	try {
		const result = await bindVenv({ path: body?.path, create: !!body?.create });
		const kernel = await rebindKernel();
		return json({ ok: true, ...result, kernel, info: await getVenvInfo() });
	} catch (err) {
		return json({ ok: false, message: String(err?.message ?? err) }, { status: 400 });
	}
}
