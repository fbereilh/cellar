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
 * stop can reach what the CLI itself started. That also takes it out of the
 * group a TERMINAL signals - which is a real loss on the hang-up path, and why
 * SIGHUP is handled below rather than left to node's default.
 *
 * It is NOT a loss against Cellar's own teardown: nothing of Cellar's ever
 * group-killed. A take-over reap and `cellar cleanup` both go through `killPid`
 * (`instances.js`), which signals POSITIVE pids one at a time, and the
 * launcher's own cascade `kill`s its DIRECT children - so a chat descendant
 * already survived an ordinary Ctrl-C before any of this (REPRODUCED: a plain
 * SIGTERM to the launcher left it alive). The one external group-kill in the
 * tree is `tests/e2e/harness.ts`. So this listener is not restoring an accident,
 * it closes a pre-existing leak.
 *
 * STATED RESIDUAL - the coverage is HANDLER-based, so an app that LEAVES WITHOUT
 * RUNNING ONE orphans the tree. Every route in is a handler: the two signals
 * below, `CHAT_HANGUP_SIGNAL`, and `parent-watch`'s explicit call. An uncaught
 * exception, an OOM kill or a SIGKILL runs none of them - and SIGKILL is
 * reachable, since `killPid` escalates to it after a 4s grace - so the tree is
 * left in a session of its OWN, where a later terminal close cannot reach it
 * either. Before `detached` that tree sat in the terminal's group and a terminal
 * close swept it up, so this is a genuine NARROWING and not the old leak
 * restated.
 *
 * Two MEASURED mitigations bound it, so do not overstate it either: `killPid`
 * sends SIGTERM FIRST and that listener aborts SYNCHRONOUSLY, so the SIGKILL
 * half only bites an app already wedged for 4s; and an orphaned REAL `claude`
 * finishes its turn and exits rather than running forever - the endless `sleep`
 * is a property of the test STUB, not of what a user's machine leaves behind.
 *
 * It is CLOSED by the filed follow-up `cellar-chat-pgid-registry-orphan-reap`:
 * an out-of-process pgid registry mirroring `instances.js`, reaped on the next
 * launch or `cellar cleanup`, with pid-reuse verification (`verifyPidIdentity`).
 *
 * DO NOT reach for an `uncaughtException` listener instead. It SUPPRESSES node's
 * default crash-exit exactly as a SIGHUP listener suppresses the default
 * terminate - the trap this file already closed once - so it trades a
 * possibly-orphaned chat tree for a possibly-IMMORTAL APPLICATION, a bigger hole
 * than the one it closes, and it still cannot see SIGKILL at all.
 */
export function abortAllChatRuns(): number {
	let aborted = 0;
	for (const nb of [...active.keys()]) aborted += abortChatRuns(nb);
	return aborted;
}

/**
 * The signals a stopping app process is told to stop by, and which adapter-node
 * already answers - so these listeners are ABORT-ONLY and never exit.
 */
export const CHAT_SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

/**
 * The hang-up signal, handled SEPARATELY because it OWNS ITS OWN EXIT.
 *
 * Do not "harmonise" it with the two above; the asymmetry is the whole point.
 * adapter-node registers SIGTERM and SIGINT only, so on those two something else
 * is already taking the process down and a listener here may stay purely
 * additive. It has NO SIGHUP path, and neither does the launcher - so on SIGHUP
 * node's DEFAULT action is the only thing that stops us, and MERELY REGISTERING
 * A LISTENER SUPPRESSES IT (measured: an otherwise identical process with an
 * empty `process.on('SIGHUP')` survives a hang-up that kills it without one).
 * Whoever listens here therefore owns making the process die, and a half-done
 * handler is worse than none: instead of a surviving chat child you get a
 * surviving APPLICATION. `parent-watch`'s orphan self-exit is only a PARTIAL
 * backstop for that - it needs two 5s-apart dead readings of the launcher, so it
 * cannot act sooner than ~5s, and it does not run at all with no launcher pid
 * (or one the OS has recycled) - which is why the e2e bounds this path well
 * under that floor rather than merely asserting the app eventually goes.
 *
 * It has to be listened for at all because a chat child leads its OWN session
 * (`detached`, see `signalRunTree`), so it is no longer in the terminal's
 * foreground process group. The app IS (the launcher spawns it undetached), so a
 * hard terminal close SIGHUPs the app and the launcher and nothing else - and
 * without this the whole `claude` tree is left behind, which is the very failure
 * class the group kill exists to close, wearing a different hat.
 */
export const CHAT_HANGUP_SIGNAL = 'SIGHUP' as const;

/**
 * 128 + SIGHUP(1) - what a shell reports for a hang-up kill. Used only where the
 * default disposition cannot be restored, so the process still dies with a
 * status that reads as the signal rather than as a clean stop.
 */
export const HANGUP_EXIT_CODE = 129;

/**
 * The REAL process, as the hang-up path needs to reach it. Injected so a unit
 * test can drive the abort half without killing the runner (the `signals`
 * emitter cannot cover this: removing our listener from a fake emitter says
 * nothing about the real process's disposition).
 */
export interface HangupExit {
	/** How many listeners the process still has for `sig`, ours already removed. */
	listenerCount(sig: string): number;
	/** Re-raise `sig` at ourselves, with the default disposition restored. */
	raise(sig: NodeJS.Signals): void;
	/** Last resort: terminate deterministically when the default is unreachable. */
	exit(code: number): void;
}

const processHangupExit: HangupExit = {
	listenerCount: (sig) => process.listenerCount(sig as NodeJS.Signals),
	raise: (sig) => {
		process.kill(process.pid, sig);
	},
	exit: (code) => {
		process.exit(code);
	}
};

/**
 * Stop every live chat run when this process is asked to stop, so no CLI child
 * is left running behind a Cellar that is gone.
 *
 * On SIGTERM/SIGINT this is additive and never fatal, like the app's other
 * shutdown listeners: it only aborts (which the engine turns into a signal to
 * each run's process group) and never calls `process.exit` - adapter-node owns
 * that. Aborting is SYNCHRONOUS all the way to `process.kill`, so the signals
 * are out before the process can leave, with no async step to lose the race on.
 *
 * On SIGHUP it aborts and THEN MAKES SURE WE STILL DIE, because nothing else
 * will (see `CHAT_HANGUP_SIGNAL`). It restores the default disposition by
 * removing OUR OWN listener - never `removeAllListeners`, which would drop one
 * some other module added - and re-raises, so the process dies BY THE SIGNAL it
 * was sent and the launcher reports exactly what it always did. If a listener
 * some other module registered is still there the default is STILL suppressed
 * and re-raising would spin (measured), so that branch exits explicitly instead.
 * Both branches terminate; `exit` is also the backstop for a raise that returns.
 *
 * `signals` is injected for the same reason `releaseOnShutdown` injects its own:
 * a test must drive this without touching the runner's signal handling, and
 * `hangupExit` is injected for the half an emitter cannot stand in for. Returns
 * an unsubscribe.
 */
export function stopChatRunsOnShutdown(
	signals: Pick<NodeJS.EventEmitter, 'on' | 'off'> = process,
	hangupExit: HangupExit = processHangupExit
): () => void {
	const stop = () => {
		try {
			abortAllChatRuns();
		} catch {
			// A shutdown listener may never throw; a run we could not abort is worse
			// reported than escalated into an uncaught exception on the way out.
		}
	};
	const hangUp = () => {
		stop();
		signals.off(CHAT_HANGUP_SIGNAL, hangUp);
		let remaining = 1;
		try {
			remaining = hangupExit.listenerCount(CHAT_HANGUP_SIGNAL);
		} catch {
			// Unknown reads as "still suppressed": the explicit exit below always
			// terminates, while a re-raise into a suppressed default would not.
		}
		if (remaining === 0) {
			try {
				hangupExit.raise(CHAT_HANGUP_SIGNAL);
			} catch {
				// fall through to the explicit exit rather than staying up
			}
		}
		hangupExit.exit(HANGUP_EXIT_CODE);
	};
	for (const sig of CHAT_SHUTDOWN_SIGNALS) signals.on(sig, stop);
	signals.on(CHAT_HANGUP_SIGNAL, hangUp);
	return () => {
		for (const sig of CHAT_SHUTDOWN_SIGNALS) signals.off(sig, stop);
		signals.off(CHAT_HANGUP_SIGNAL, hangUp);
	};
}

/** Test seam: forget everything (controllers are the tests' to settle). */
export function __resetChatRuns(): void {
	active.clear();
}
