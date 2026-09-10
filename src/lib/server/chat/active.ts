/**
 * Cellar - the live chat-run registry: which chat children are running per
 * notebook, so kernel-scoped stops reach them.
 *
 * A chat run holds no kernel, so the doors a user stops work through -
 * `interruptKernel`, `restartKernel`, `shutdownKernel`/`shutdownKernelsUnder`
 * (and `teardownKernel`, which they reach) - cannot see it:
 * without this registry an interrupt cleared the queue and returned while the
 * chat child kept streaming. Each of those doors calls `abortChatRuns(nb)` (or
 * `abortChatRunsUnder`) BEFORE its own no-kernel early return, which aborts
 * every registered controller; the engine kills its child and the run settles
 * `cancelled`. Aborting inside `teardownKernel` alone is NOT enough: a chat-only
 * notebook has no kernel, so every door that bails on a missing one would step
 * straight over it.
 *
 * This module imports NOTHING from kernel.ts (kernel.ts imports it), keeping
 * the dependency one-directional like `run-queue.ts`.
 */

const active = new Map<string, Set<AbortController>>();

/** Register a chat run's abort controller under its notebook's ABSOLUTE path. */
export function registerChatRun(nb: string, ctrl: AbortController): void {
	let set = active.get(nb);
	if (!set) {
		set = new Set();
		active.set(nb, set);
	}
	set.add(ctrl);
}

/** Remove a settled run (call from the run's `finally`). */
export function unregisterChatRun(nb: string, ctrl: AbortController): void {
	const set = active.get(nb);
	if (!set) return;
	set.delete(ctrl);
	if (set.size === 0) active.delete(nb);
}

/**
 * Abort every live chat run of one notebook (interrupt / restart / shutdown).
 * Returns how many were aborted (0 is the common case and costs a Map miss).
 */
export function abortChatRuns(nb: string): number {
	const set = active.get(nb);
	if (!set || set.size === 0) return 0;
	const ctrls = [...set];
	for (const ctrl of ctrls) {
		try {
			ctrl.abort();
		} catch {
			// an abort listener threw; the next controller must still be reached
		}
	}
	return ctrls.length;
}

/**
 * Abort every live chat run of a notebook at or UNDER a workspace path - what a
 * deleted notebook (or a deleted folder full of them) needs, mirroring
 * `shutdownKernelsUnder`'s own at-or-under rule. The registry is keyed by
 * absolute notebook path, so the prefix test belongs here rather than at the
 * caller, which would have to know how these keys are shaped.
 */
export function abortChatRunsUnder(deletedAbs: string, sep: string): number {
	const prefix = deletedAbs + sep;
	let aborted = 0;
	for (const nb of [...active.keys()]) {
		if (nb === deletedAbs || nb.startsWith(prefix)) aborted += abortChatRuns(nb);
	}
	return aborted;
}

/**
 * Abort every live chat run, in every notebook - what THIS PROCESS STOPPING
 * needs, since a chat child outlives the app unless something reaches it.
 *
 * A chat child is spawned into its own process group (see `signalRunTree`) so a
 * stop can reach what the CLI itself started. That is also what takes it OUT of
 * the group Cellar's own teardown signals: before it, an external group-kill of
 * the launcher (a take-over reap, `cellar cleanup`, the e2e harness) swept chat
 * children up by accident. This is that coverage made deliberate, and it is
 * strictly wider - the launcher's ordinary shutdown only SIGTERMs its direct
 * children, so an orphaned chat descendant survived Ctrl-C too (REPRODUCED).
 */
export function abortAllChatRuns(): number {
	let aborted = 0;
	for (const nb of [...active.keys()]) aborted += abortChatRuns(nb);
	return aborted;
}

/** The signals a stopping app process is told to stop by. */
export const CHAT_SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

/**
 * Stop every live chat run when this process is asked to stop, so no CLI child
 * is left running behind a Cellar that is gone.
 *
 * Additive and never fatal, like the app's other shutdown listeners: it only
 * aborts (which the engine turns into a signal to each run's process group) and
 * never calls `process.exit` - adapter-node owns that. Aborting is SYNCHRONOUS
 * all the way to `process.kill`, so the signals are out before the process can
 * leave, with no async step to lose the race on.
 *
 * `signals` is injected for the same reason `releaseOnShutdown` injects its own:
 * a test must drive this without touching the runner's signal handling. Returns
 * an unsubscribe.
 */
export function stopChatRunsOnShutdown(
	signals: Pick<NodeJS.EventEmitter, 'on' | 'off'> = process
): () => void {
	const stop = () => {
		try {
			abortAllChatRuns();
		} catch {
			// A shutdown listener may never throw; a run we could not abort is worse
			// reported than escalated into an uncaught exception on the way out.
		}
	};
	for (const sig of CHAT_SHUTDOWN_SIGNALS) signals.on(sig, stop);
	return () => {
		for (const sig of CHAT_SHUTDOWN_SIGNALS) signals.off(sig, stop);
	};
}

/** Test seam: forget everything (controllers are the tests' to settle). */
export function __resetChatRuns(): void {
	active.clear();
}
