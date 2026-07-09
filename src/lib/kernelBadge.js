// Single source of truth for how a kernel's runtime state is presented, shared
// by the navbar badge and the sidebar Kernels card so the two can never drift.
//
// `getKernelInfo()` forwards the kernel's status verbatim, and the Jupyter
// status set is wider than idle/busy/starting/dead: it also carries the
// transitional `restarting`, `autorestarting`, `terminating` and `unknown`.
// Only a genuinely usable kernel may read green, so `idle` is the sole success
// case and every other started status falls back to a non-green badge.

export function kernelStatusLabel(info) {
	return info?.started ? info.status : 'not started';
}

export function kernelBadgeClass(info) {
	if (!info?.started) return 'badge-ghost';
	if (info.status === 'idle') return 'badge-success';
	if (info.status === 'dead') return 'badge-error';
	return 'badge-warning';
}
