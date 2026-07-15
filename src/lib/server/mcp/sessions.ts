/**
 * Cellar — MCP session lifecycle registry.
 *
 * Each connected `cellar mcp` bridge mints a Streamable-HTTP session that owns a
 * full `McpServer` (with ~30 registered tools) plus per-session state in the
 * service layer (its pinned working notebook). Historically only the transport
 * was removed on close, so the `McpServer` + its registrations + the pin leaked;
 * a SIGKILL'd bridge (which never fires `onclose`) leaked even the transport.
 * Claude Code relaunches the bridge once per task, so a long-lived Cellar
 * accumulated dead sessions indefinitely.
 *
 * This registry closes both holes:
 *   - `forget(sid)` does the COMPLETE teardown — closes the session's `McpServer`
 *     (which drops its tool registrations and closes the transport), removes the
 *     registry entry, and clears the per-session service state — in one path.
 *   - an `unref`'d idle reaper reclaims sessions whose bridge died uncleanly, via
 *     that SAME `forget` path, so an unclean disconnect leaks nothing either.
 *
 * SHARED-RESOURCE SAFETY (non-negotiable): kernels are per-notebook and shared
 * across sessions and the UI; the notebook document is shared. Forgetting a
 * session frees ONLY that session's `McpServer`, its registrations, and its pin —
 * the `forgetPerSessionState` hook (service.forgetSession) touches nothing but
 * the pin, and closing an `McpServer` closes only that session's transport. No
 * kernel is shut down, no document is closed, and no other session is disturbed.
 */

/** Idle window after which a session with no request is presumed dead and reaped. */
export const SESSION_IDLE_MS = 30 * 60 * 1000; // 30 minutes
/** How often the reaper scans for idle sessions. */
export const REAPER_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Structural shape of what a session owns. Kept intentionally minimal so the
 * registry stays decoupled from the concrete SDK types (and unit-testable with a
 * fake server): all the registry needs of the `McpServer` is `close()`, and all
 * it needs of the transport is to hand it back for request routing.
 */
export type SessionEntry<Server extends { close(): unknown } = { close(): unknown }, Transport = unknown> = {
	server: Server;
	transport: Transport;
	/** Epoch-ms of the last request seen on this session; drives idle reaping. */
	lastActivity: number;
};

/** Hook that clears a session's per-session state in the service layer. */
export type ForgetHook = (sessionId: string) => void;

export class McpSessionRegistry<Server extends { close(): unknown } = { close(): unknown }, Transport = unknown> {
	private readonly sessions = new Map<string, SessionEntry<Server, Transport>>();
	private reaper: ReturnType<typeof setInterval> | undefined;

	/** @param forgetPerSessionState called during `forget` to release service-layer state (the pin). */
	constructor(private readonly forgetPerSessionState: ForgetHook) {}

	register(sessionId: string, entry: SessionEntry<Server, Transport>): void {
		this.sessions.set(sessionId, entry);
	}

	get(sessionId: string): SessionEntry<Server, Transport> | undefined {
		return this.sessions.get(sessionId);
	}

	has(sessionId: string): boolean {
		return this.sessions.has(sessionId);
	}

	get size(): number {
		return this.sessions.size;
	}

	/** Bump a session's activity clock so an in-use session is never reaped. */
	touch(sessionId: string, now: number = Date.now()): void {
		const entry = this.sessions.get(sessionId);
		if (entry) entry.lastActivity = now;
	}

	/**
	 * Complete teardown for one session. Removes the entry FIRST, so the
	 * re-entrant `onclose` that `server.close()` triggers finds nothing and is a
	 * no-op (this is what breaks the close → onclose → forget recursion). Then
	 * closes the `McpServer` (dropping its tool registrations + transport) and
	 * clears the per-session service state. Idempotent and shared-resource-safe.
	 */
	forget(sessionId: string): boolean {
		const entry = this.sessions.get(sessionId);
		if (!entry) return false;
		this.sessions.delete(sessionId);
		try {
			// close() may be async; we neither await nor let a rejection escape —
			// teardown must not depend on, or be broken by, the socket close.
			void Promise.resolve(entry.server.close()).catch(() => {});
		} catch {
			/* already closed */
		}
		this.forgetPerSessionState(sessionId);
		return true;
	}

	/**
	 * Reap every session idle longer than `idleMs`. Snapshots the stale ids before
	 * calling `forget` so mutating the map mid-iteration is safe. Returns the
	 * reaped ids (for logging/tests).
	 */
	reapIdle(idleMs: number = SESSION_IDLE_MS, now: number = Date.now()): string[] {
		const stale: string[] = [];
		for (const [sid, entry] of this.sessions) {
			if (now - entry.lastActivity > idleMs) stale.push(sid);
		}
		for (const sid of stale) this.forget(sid);
		return stale;
	}

	/**
	 * Start the periodic idle reaper (idempotent — a second call is a no-op). The
	 * timer is `unref`'d so it never keeps the Node process alive on its own.
	 */
	startReaper(intervalMs: number = REAPER_INTERVAL_MS, idleMs: number = SESSION_IDLE_MS): void {
		if (this.reaper) return;
		this.reaper = setInterval(() => this.reapIdle(idleMs), intervalMs);
		this.reaper.unref?.();
	}

	stopReaper(): void {
		if (this.reaper) {
			clearInterval(this.reaper);
			this.reaper = undefined;
		}
	}
}
