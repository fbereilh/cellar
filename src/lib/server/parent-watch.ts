/**
 * Cellar — orphaned-instance self-exit.
 *
 * The app server (`build/index.js`, or vite in --dev) is spawned by the `cellar`
 * launcher. On a clean stop the launcher SIGTERMs us, but when the launcher is
 * killed uncleanly (terminal closed hard, SIGKILL, crash) we are reparented to
 * init (ppid 1) and keep running — for hours — serving stale in-memory code to
 * any agent that discovers our MCP port. That is the observed pile-up: many old
 * `build/index.js` processes, launchers long gone.
 *
 * This watches the launcher pid (passed as CELLAR_LAUNCHER_PID) and, once it is
 * gone, kills the recorded Jupyter sidecar (also orphaned) and exits, so an
 * orphaned instance reaps itself instead of lingering. A launcher pid that is
 * reused by an unrelated process reads as "alive", which only makes us linger
 * (the safe direction) rather than exit a healthy server.
 */
import { readInstance, unregisterInstance } from './instances.js';

const CHECK_MS = 5000;

/** True if `pid` is currently alive (EPERM = exists, owned by another user). */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException)?.code === 'EPERM';
	}
}

// Require the launcher to look dead on this many CONSECUTIVE checks before we
// self-exit. A single missed check could be a transient (a hiccup in the
// existence probe); two in a row, CHECK_MS apart, is a real disappearance. This
// keeps a live kernel from being torn down on a spurious reading.
const CONFIRM_STRIKES = 2;

export function startParentWatch(): void {
	const raw = process.env.CELLAR_LAUNCHER_PID;
	const launcherPid = raw ? parseInt(raw, 10) : NaN;
	// pid 1 (init) is never a real launcher — guard against a stray value.
	if (!Number.isInteger(launcherPid) || launcherPid <= 1) return;

	let strikes = 0;
	const timer = setInterval(() => {
		if (alive(launcherPid)) {
			// Any live reading clears prior strikes — the launcher is still here.
			if (strikes > 0) {
				console.log(`[cellar] launcher pid ${launcherPid} responded again - staying up`);
				strikes = 0;
			}
			return;
		}
		strikes += 1;
		if (strikes < CONFIRM_STRIKES) {
			console.warn(
				`[cellar] launcher pid ${launcherPid} not found (${strikes}/${CONFIRM_STRIKES}) - confirming before exit`
			);
			return;
		}
		console.warn(
			`[cellar] launcher pid ${launcherPid} confirmed gone (${strikes}/${CONFIRM_STRIKES} checks) - exiting orphaned server (trigger: orphan self-exit)`
		);
		// Reap the (now also orphaned) Jupyter sidecar and drop the registry entry
		// before we go, so nothing is left behind listening.
		try {
			const e = readInstance(launcherPid);
			if (e?.jupyterPid) {
				try {
					process.kill(e.jupyterPid, 'SIGTERM');
				} catch {}
			}
			unregisterInstance(launcherPid);
		} catch {}
		process.exit(0);
	}, CHECK_MS);
	timer.unref?.();
}
