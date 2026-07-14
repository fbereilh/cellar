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

/**
 * One live per-notebook kernel, as returned by `listKernels()` / the `/api/kernel`
 * `kernels` field / the `kernel:status` SSE snapshot. `path` is workspace-relative
 * (the id the browser matches tabs on). Cellar runs one kernel PER notebook, so
 * this list is the true "loaded notebooks" set — a notebook with no entry never
 * ran a cell and shows as "not started".
 */
export interface KernelListEntry {
	path: string;
	name: string;
	started: boolean;
	id: string | null;
	status: KernelStatus;
	session_id: SessionId | null;
	busy: boolean;
}

/**
 * A Kernels-sidebar card: one per notebook that either has a live kernel OR is
 * open in a tab. `info` drives the status badge (`kernelBadgeClass`); `open`/
 * `active` come from the tab set so a card can focus its tab and dot the focused
 * notebook. `hasKernel` gates the Interrupt/Restart/Shut-down controls.
 */
export interface KernelCard {
	/** Tab id when open, else the notebook path. */
	id: string;
	/** Workspace-relative notebook path (target for the per-kernel controls). */
	path: string;
	name: string;
	open: boolean;
	active: boolean;
	hasKernel: boolean;
	info: KernelInfo;
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

/**
 * Background-color class for a compact status dot in the Kernels list — the
 * standalone-dot counterpart to `kernelBadgeClass`, following the same rule
 * (only a genuinely usable `idle` kernel reads green). A not-started kernel is
 * a muted neutral; `busy` and every transitional state are amber; `dead` red.
 */
export function kernelDotClass(info: KernelInfo | null | undefined): string {
	if (!info?.started) return 'bg-base-content/25';
	if (info.status === 'idle') return 'bg-success';
	if (info.status === 'dead') return 'bg-error';
	return 'bg-warning';
}
