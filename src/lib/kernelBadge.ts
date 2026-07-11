// Single source of truth for how a kernel's runtime state is presented, shared
// by the navbar badge and the sidebar Kernels card so the two can never drift.
//
// `getKernelInfo()` forwards the kernel's status verbatim, and the Jupyter
// status set is wider than idle/busy/starting/dead: it also carries the
// transitional `restarting`, `autorestarting`, `terminating` and `unknown`.
// Only a genuinely usable kernel may read green, so `idle` is the sole success
// case and every other started status falls back to a non-green badge.

import type { KernelStatus, SessionId } from '$lib/server/types';

/** A notebook whose state is loaded in the shared kernel session (from `/api/kernel`). */
export interface LoadedNotebook {
	path: string;
	name: string;
}

/** Read-only kernel runtime state as returned by `getKernelInfo()` / `/api/kernel`. */
export interface KernelInfo {
	started: boolean;
	id: string | null;
	name: string;
	status: KernelStatus;
	session_id: SessionId | null;
	/** Notebooks loaded in the live session (only the `/api/kernel` route adds this). */
	loaded_notebooks?: LoadedNotebook[];
}

export function kernelStatusLabel(info: KernelInfo | null | undefined): string {
	return info?.started ? info.status : 'not started';
}

export function kernelBadgeClass(info: KernelInfo | null | undefined): string {
	if (!info?.started) return 'badge-ghost';
	if (info.status === 'idle') return 'badge-success';
	if (info.status === 'dead') return 'badge-error';
	return 'badge-warning';
}
