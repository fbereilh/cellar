/**
 * Which kernel namespace the Variables panel's rows describe, and whether it
 * still exists.
 *
 * The panel lists a SNAPSHOT of one notebook's live namespace. A restart, a
 * shutdown, an idle cull or a venv rebind destroys that namespace, and the
 * page's OWN controls wipe the rows when they do it. A FOREIGN one (an agent's
 * `restart_kernel`, another tab's Shut down, jupyter's autorestart) used to
 * reach nothing, so the page went on listing variables that no longer existed.
 *
 * Rather than enumerate every way a namespace can die, the rows are TAGGED with
 * the (notebook, session) the probe actually read (`/api/kernel/variables`
 * reports both), and every signal the server already broadcasts about kernel
 * lifecycles is asked one question: is that namespace still alive? The session
 * id is the kernel epoch - bumped on every start, restart, autorestart and
 * teardown - so a namespace is alive exactly while its notebook's kernel still
 * carries the same session.
 *
 * Pure and DOM-free so the rule can be driven without a browser.
 */
import type { KernelListEntry } from '$lib/kernelBadge';
import type { SessionId } from '$lib/server/types';

/** The namespace a set of Variables rows was read from. */
export interface VarsNamespace {
	/** Workspace-relative notebook path, as `kernel:status` entries carry it. */
	path: string;
	session: SessionId;
}

const norm = (p: string) => p.replace(/\\/g, '/');

/**
 * Tag for a probe reply: the namespace it describes, or null when it describes
 * none (no kernel yet, or a reply from a server that does not report one).
 */
export function namespaceOf(body: { path?: unknown; session_id?: unknown } | null | undefined): VarsNamespace | null {
	if (!body || typeof body.path !== 'string' || !body.path) return null;
	if (typeof body.session_id !== 'number') return null;
	return { path: body.path, session: body.session_id };
}

/**
 * Does `ns` survive a `kernel:status` snapshot (the full per-notebook list)?
 *
 * Dead when its notebook has no kernel at all (shut down, culled, rebound, or
 * the server itself was replaced) or its kernel reports a DIFFERENT session
 * (restarted, autorestarted). A kernel whose session is not known yet (`null`,
 * still connecting) is not evidence of anything: a kernel that restarts keeps
 * its connection and so always reports a session, and one that was torn down
 * and is booting again announced its teardown through `kernel:shutdown` first.
 */
export function namespaceSurvives(ns: VarsNamespace, kernels: readonly KernelListEntry[]): boolean {
	const entry = kernels.find((k) => norm(k.path) === norm(ns.path));
	if (!entry) return false;
	if (entry.session_id == null) return true;
	return entry.session_id === ns.session;
}

/**
 * Did any notebook's kernel namespace die between two snapshots? True when a
 * notebook that had a known session either vanished or now reports a different
 * one. Used for everything the rows do NOT pin down: re-reading the badge (the
 * ACTIVE notebook's kernel may be the one that died) and superseding a probe
 * still in flight, whose reply may describe the namespace that just went away.
 */
export function anyNamespaceDied(
	prev: readonly KernelListEntry[],
	next: readonly KernelListEntry[]
): boolean {
	for (const before of prev) {
		if (before.session_id == null) continue;
		if (!namespaceSurvives({ path: before.path, session: before.session_id }, next)) return true;
	}
	return false;
}

/**
 * Does a `kernel:shutdown` event (notebook `rel`, dead `session`) end the
 * namespace `ns` describes? The event names the session that died, so a reply
 * from a NEWER kernel of the same notebook is never cleared by an older event;
 * an event that names no session is taken at its word for the whole notebook.
 */
export function shutdownEnds(ns: VarsNamespace, rel: string | null, session: unknown): boolean {
	if (!rel || norm(rel) !== norm(ns.path)) return false;
	return typeof session !== 'number' || session === ns.session;
}
