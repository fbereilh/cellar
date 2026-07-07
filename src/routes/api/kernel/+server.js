import { json } from '@sveltejs/kit';
import { getKernelInfo } from '$lib/server/kernel.js';

/** Current kernel status for the sidebar Kernels section (does not start one). */
export function GET() {
	return json(getKernelInfo());
}
