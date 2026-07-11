import { json } from '@sveltejs/kit';
import { getEnvironment, saveRequirements } from '$lib/server/environment';

/**
 * The Environment sidebar section's one read: the bound interpreter, its venv,
 * and the installed packages (name + version). Runs a short-lived subprocess of
 * the project venv - never the kernel - so it is safe to poll and works before
 * the first cell runs. A "no venv" workspace reads as `{ok:false, code:'no_venv'}`.
 */
export async function GET() {
	try {
		return json(await getEnvironment());
	} catch (err) {
		return json({ ok: false, code: 'error', message: String(err?.message ?? err) }, { status: 500 });
	}
}

/**
 * Export: write a pinned `requirements.txt` into the workspace root from a fresh
 * probe (authoritative, never a client-supplied list). The browser can also copy
 * the same text to the clipboard; this is the "save next to the project" path.
 */
export async function POST() {
	try {
		return json(await saveRequirements());
	} catch (err) {
		const code = err?.code ?? 'error';
		return json({ ok: false, code, message: String(err?.message ?? err) }, { status: code === 'no_venv' ? 412 : 500 });
	}
}
