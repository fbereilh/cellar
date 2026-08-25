// Single source of truth for how a kernel's runtime state is presented, shared
// by the navbar badge and the sidebar Kernels card so the two can never drift.
//
// `getKernelInfo()` forwards the kernel's status verbatim, and the Jupyter
// status set is wider than idle/busy/starting/dead: it also carries the
// transitional `restarting`, `autorestarting`, `terminating` and `unknown`.
// Only a genuinely usable kernel may read green, so `idle` is the sole success
// case and every other started status falls back to a non-green badge.

import type { KernelStatus, SessionId } from '$lib/server/types';

/** A notebook whose state is loaded in its own kernel session (from `/api/kernel`). */
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
	/** Resident memory of the kernel process in bytes; null when no kernel / unreadable. */
	memoryRss?: number | null;
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
	/** Resident memory of the kernel process in bytes; null when unreadable / not sampled yet. */
	memoryRss: number | null;
}

/**
 * A Kernels-sidebar card: one per notebook that either has a live kernel OR is
 * open in a tab. `info` drives the status badge (`kernelBadgeClass`); `open`
 * says whether a tab already exists (it only changes what the row CALLS the
 * action - "Focus" vs "Open") and `active` dots the focused notebook.
 * `hasKernel` gates the Interrupt/Restart/Shut-down controls. Everything the
 * card ACTS on is addressed by `path`: the per-kernel controls, and the card's
 * NAME, which is its own click target and opens (or surfaces) that notebook.
 */
export interface KernelCard {
	/** Workspace-relative notebook path — the target of every action on the card. */
	path: string;
	name: string;
	open: boolean;
	active: boolean;
	hasKernel: boolean;
	info: KernelInfo;
}

/**
 * What a Kernels card CALLS its notebook.
 *
 * A card exists for a notebook whose TAB WAS CLOSED (its kernel is still alive
 * and holding the namespace), and that card has no tab to borrow a title from.
 * The obvious fallback - `KernelListEntry.name` - is the KERNELSPEC name, which
 * is `python3` for every kernel Cellar starts, so it labelled every tab-closed
 * card `python3`: a name identifying no notebook at all, on exactly the card
 * whose one job is to open one.
 *
 * So the fallback is the path's BASENAME, which is what a tab is titled with
 * (`makeTab`) - a card and its tab therefore read alike. The full path is not
 * used because it does not fit a dense 256px row; it rides the row's tooltip
 * instead, which is what tells two same-named notebooks in different folders
 * apart. A path with no basename (empty, or a trailing separator) falls back to
 * the path itself rather than to an empty label.
 */
export function kernelCardName(path: string, tabTitle?: string | null): string {
	if (tabTitle) return tabTitle;
	return path.split('/').pop() || path;
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

/**
 * Compact, human-readable memory figure for a kernel's RSS (e.g. `312 MB`,
 * `1.4 GB`). Returns null for a missing/invalid reading so callers can hide the
 * figure rather than render a broken `NaN`/`0 B`. Uses decimal (MB/GB) units — the
 * familiar "how much RAM" scale — not binary MiB/GiB, since the value is displayed
 * to a human, not compared byte-for-byte.
 */
export function formatMemory(bytes: number | null | undefined): string | null {
	if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return null;
	if (bytes < 1000 * 1000) return `${Math.max(1, Math.round(bytes / 1000))} KB`;
	if (bytes < 1000 * 1000 * 1000) return `${Math.round(bytes / (1000 * 1000))} MB`;
	return `${(bytes / (1000 * 1000 * 1000)).toFixed(1)} GB`;
}
