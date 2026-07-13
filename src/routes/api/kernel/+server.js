import { json } from '@sveltejs/kit';
import { getKernelInfo, listKernels } from '$lib/server/kernel';

/**
 * Kernel status for the sidebar (does not start one).
 *
 * `kernels` is the full list of live per-notebook kernels — one card per entry
 * in the Kernels section, each with its own status/session/busy (Cellar runs one
 * kernel PER notebook, lazily started on that notebook's first run). Each carries
 * its workspace-relative `path` (the id the browser matches tabs on) and a display
 * `name`; the entry survives a restart (the process is reused, only the namespace
 * clears) and is dropped on shutdown/rebind. The top-level fields are the ACTIVE
 * notebook's kernel, kept for the navbar badge, the variable inspector, and the
 * Databricks panel, which all follow the focused notebook.
 */
export function GET() {
	return json({ ...getKernelInfo(), kernels: listKernels() });
}
