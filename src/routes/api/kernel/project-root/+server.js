import { json } from '@sveltejs/kit';
import { setUiState, addProjectRootToPath } from '$lib/server/ui-state';
import { ADD_PROJECT_ROOT_KEY } from '$lib/server/projectRoot';
import { applyProjectRootToLiveKernels } from '$lib/server/kernel';

/**
 * Per-workspace "add the project root to the kernel's sys.path" setting
 * (default ON). Persisted in the UI-state store and honored at kernel start; the
 * POST also applies the change LIVE to every running kernel so a toggle takes
 * effect without a restart. See `$lib/server/projectRoot.ts`.
 */
export function GET() {
	return json({ enabled: addProjectRootToPath() });
}

/**
 * Set the setting to `{ enabled: boolean }` (default true when omitted) and apply
 * it to all live kernels now. The store is written FIRST so a kernel finishing
 * start mid-apply reads the new value from `initKernel`.
 */
export async function POST({ request }) {
	const body = await request.json().catch(() => ({}));
	const enabled = body?.enabled !== false;
	setUiState({ [ADD_PROJECT_ROOT_KEY]: enabled });
	try {
		await applyProjectRootToLiveKernels(enabled);
	} catch (err) {
		// A live-apply failure must not lose the persisted setting; new kernels still
		// honor it. Surface it but keep the stored value.
		return json({ ok: true, enabled, applyError: String(err?.message ?? err) });
	}
	return json({ ok: true, enabled });
}
