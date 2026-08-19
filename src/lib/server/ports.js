/**
 * Cellar - stable per-workspace ports.
 *
 * Cellar allocates an ephemeral port per run so concurrent instances in
 * different folders never collide. The cost is that a folder's address moves on
 * every restart: the browser tab you left open 404s, a bookmark goes stale, and
 * the raw `http://127.0.0.1:<port>/mcp` endpoint the sidebar publishes under
 * "Advanced" is only ever true for one run. This module makes a folder REMEMBER
 * the ports it got and ask for them again next time - while keeping the
 * collision-freedom that made them dynamic in the first place, because a
 * remembered port is a PREFERENCE that must be re-earned on every launch, never
 * a claim.
 *
 * ## What is remembered, and what deliberately is not
 *
 * The **app** and **MCP** ports are remembered; the **Jupyter** port is not. The
 * Jupyter sidecar is reached only by the launcher and the app, which learn its
 * port in-process and never publish it, so remembering it would buy nothing
 * while adding one more port to lose a race for on startup. Every remembered
 * port is a small liability (an unrelated process may have taken it while we
 * were down), so the set is kept to the ports that actually earn it.
 *
 * The two are NOT equally important, and the difference decides how hard this
 * file tries for each. The **app** port is the one a human holds onto - the URL
 * in the browser, the bookmark, the tab left open - and it is also the one that
 * is cheap to keep: measured against a real instance, adapter-node closes its
 * http server on SIGTERM so the app port is bindable again within milliseconds
 * of a Ctrl-C. The **MCP** port appears in no agent config at all (that is the
 * whole point of the `cellar mcp` stdio bridge - see runtime.js), and a bridge
 * that outlives a restart now re-attaches by itself (see mcp-bridge.js), so its
 * address is genuinely disposable; it is also the expensive one, held for ~7s
 * after a Ctrl-C because nothing closes the in-process MCP server. So the MCP
 * port is remembered on a best-effort basis and NOT waited for - see
 * PORT_RELEASE_GRACE_MS, which is sized for the first case and explicitly not
 * the second.
 *
 * ## Why a separate file from runtime.json
 *
 * `runtime.json` (runtime.js) is a LIVE-INSTANCE record - `clearRuntime` deletes
 * it on exit precisely so a dead instance can never be discovered - which is the
 * opposite of what a preference needs. So the preference lives beside it in
 * `<workspace>/.cellar/ports.json` and is never cleared. `.cellar/` is where
 * every other per-project, port-independent, git-ignored piece of state already
 * lives (checkpoints, ui-state), so this adds no new footprint: a deleted
 * worktree takes its preference with it, and nothing accumulates in $HOME for
 * folders that no longer exist.
 *
 * ## The rule (choosePort)
 *
 * An explicit `CELLAR_*_PORT` pin always wins - it is a deliberate instruction
 * (Docker publishing, a container port map), and a preference must never quietly
 * outrank it. Otherwise a remembered port is used only when it is not held by a
 * live registered instance, is bindable right now on the host this role's server
 * really binds, AND is free on the address the URL we hand the user connects to
 * (`reachHostsFor`: a wildcard bind and a loopback squatter coexist on macOS, and
 * the squatter WINS the demux - so "bindable" alone can hand back a port at which
 * someone else answers). Anything else
 * falls back to a fresh ephemeral port, which is then remembered so the NEXT
 * restart is stable again. A remembered port is never reclaimed from a live
 * instance - Cellar has a painful history of a launch disturbing someone else's
 * session, so this path only ever yields.
 *
 * Node builtins only, so `bin/cellar.js` can import it like `venv.js` /
 * `runtime.js`; it is in `package.json` `files` for the same reason.
 */
import { join } from 'node:path';
import { createServer } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { writeFileAtomic } from './write-file-atomic.js';

/** The ports a workspace remembers. Jupyter is deliberately absent (see header). */
export const REMEMBERED_PORTS = /** @type {const} */ (['appPort', 'mcpPort']);

/**
 * @typedef {{ appPort?: number, mcpPort?: number }} PortPrefs
 * @typedef {'pinned' | 'remembered' | 'fresh'} PortSource
 * @typedef {'not-sticky' | 'no-preference' | 'held-by-live-instance' | 'taken-by-this-launch' | 'port-unavailable' | 'address-unreachable'} FreshReason
 * @typedef {'held-by-live-instance' | 'taken-by-this-launch'} PortClaim
 * @typedef {{ port: number, source: PortSource, reason?: FreshReason }} PortChoice
 * @typedef {{ launcherPid?: number, appPid?: number, appPort?: number, mcpPort?: number, jupyterPort?: number }} InstanceEntry
 */

/**
 * Why a port the user was told is stable had to move, in words rather than in
 * this file's vocabulary. Keyed by `FreshReason` so a new reason cannot be
 * announced without deciding what it SAYS: the announcement is the honesty
 * contract of the whole feature, and naming a live instance for a port this very
 * launch had already taken for another role reports a conflict that does not
 * exist.
 *
 * @type {Record<FreshReason, string>}
 */
export const MOVE_CAUSE = {
	'held-by-live-instance': 'another running Cellar instance is using it',
	'taken-by-this-launch': 'this launch had already taken it for another port',
	'port-unavailable': 'another process is using it',
	'address-unreachable':
		'another process holds the loopback address that URL connects to, so it would answer instead of Cellar',
	'no-preference': 'it is no longer a usable preference',
	'not-sticky': 'this launch is isolated'
};

/** Absolute path of the durable per-workspace port preference file. */
export function portPrefsPath(workspace) {
	return join(workspace, '.cellar', 'ports.json');
}

/**
 * Is `n` a port we are willing to REMEMBER and re-request?
 *
 * Deliberately stricter than the `CELLAR_*_PORT` pin rule, and it must stay so:
 * a pin is the user speaking, while this validates an untrusted file that a
 * previous run wrote, a hand edit may have mangled, or a merge may have
 * corrupted. Our own ephemeral allocator can only ever produce an unprivileged
 * port, so anything below 1024 (or out of range, or not an integer) is garbage
 * rather than a preference - refuse it up front instead of failing to bind it.
 */
export function isRememberablePort(n) {
	return Number.isInteger(n) && n >= 1024 && n <= 65535;
}

/**
 * Read `<workspace>/.cellar/ports.json`. Returns only the keys that are present
 * AND valid, so a truncated, hand-edited or partially-corrupt file degrades to
 * "no preference for that port" rather than to an error - this file is a
 * convenience, and a launch must never fail because of it.
 */
export function readPortPrefs(workspace) {
	const file = portPrefsPath(workspace);
	if (!existsSync(file)) return {};
	let raw;
	try {
		raw = JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return {};
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
	/** @type {PortPrefs} */
	const out = {};
	for (const key of REMEMBERED_PORTS) {
		if (isRememberablePort(raw[key])) out[key] = raw[key];
	}
	return out;
}

/**
 * Merge `prefs` into the workspace's remembered ports.
 *
 * Merges rather than replaces so a run that pinned one port (and therefore
 * records nothing for it - a pin is not a preference) cannot erase the
 * remembered value of the other. Writes NOTHING when the merged result already
 * matches what is on disk, so an ordinary restart that reuses both ports leaves
 * the file's mtime alone. Best effort: a read-only workspace loses stickiness,
 * never the launch.
 *
 * @param {string} workspace
 * @param {PortPrefs} prefs
 * @returns {{ written: boolean, prefs: PortPrefs }}
 */
export function writePortPrefs(workspace, prefs) {
	const current = readPortPrefs(workspace);
	const next = { ...current };
	for (const key of REMEMBERED_PORTS) {
		if (isRememberablePort(prefs?.[key])) next[key] = prefs[key];
	}
	const changed = REMEMBERED_PORTS.some((k) => next[k] !== current[k]);
	if (!changed) return { written: false, prefs: next };
	try {
		writeFileAtomic(portPrefsPath(workspace), JSON.stringify(next, null, 2) + '\n');
		return { written: true, prefs: next };
	} catch {
		return { written: false, prefs: next };
	}
}

/**
 * Every port currently held by a LIVE registered instance, across all
 * workspaces. This is the "check the running instances ports" half: it is what
 * lets a remembered port yield to whoever actually holds it instead of racing
 * for it, and it catches an instance that is registered but not yet listening
 * (mid-boot), which a bind probe alone cannot see.
 *
 * Liveness is a pid check rather than an HTTP probe: this runs on the launch
 * path before anything is serving, it must be cheap and synchronous, and over-
 * reporting a port as held costs only a fresh port while under-reporting would
 * mean racing a live instance.
 *
 * `entries` are registry records (`instances.js` `listInstances()`); `isAlive`
 * and `excludePid` are injected so this stays pure and testable.
 *
 * @param {(InstanceEntry | null | undefined)[] | undefined} entries
 * @param {{ isAlive?: (e: InstanceEntry) => boolean, excludePid?: number }} [opts]
 * @returns {Set<number>}
 */
export function portsHeldByLiveInstances(entries, { isAlive, excludePid } = {}) {
	/** @type {Set<number>} */
	const held = new Set();
	for (const e of entries ?? []) {
		if (excludePid != null && e?.launcherPid === excludePid) continue;
		if (isAlive && !isAlive(e)) continue;
		for (const p of [e?.appPort, e?.mcpPort, e?.jupyterPort]) {
			if (Number.isInteger(p)) held.add(p);
		}
	}
	return held;
}

/**
 * How long to keep re-probing a remembered port that is momentarily busy.
 *
 * Deliberately SHORT, and the measurement is why. The launcher SIGTERMs its
 * children and exits immediately (`shutdown()` in `bin/cellar.js`), so a Ctrl-C
 * followed straight away by `cellar` races the previous run letting go. Measured
 * against a real instance, twice, the two ports behave completely differently:
 *
 *   - the APP port is free at ~0ms - adapter-node handles SIGTERM by closing its
 *     own http server promptly, so the address the user actually cares about
 *     (the URL in their browser, the bookmark, the open tab) needs no waiting at
 *     all and stays stable for free; and
 *   - the MCP port stays held for ~5-7s, because nothing closes the in-process
 *     MCP http server and it carries `timeout = 0`, so it is released only when
 *     the app process finally exits - which on the Ctrl-C path is the ORPHAN
 *     self-exit in `parent-watch.ts` (`CONFIRM_STRIKES` consecutive dead
 *     readings at `CHECK_MS`), something the new launch cannot hurry along: the
 *     previous launcher already unregistered itself and cleared `runtime.json`,
 *     so the take-over sweep finds nothing to await.
 *
 * So this window covers scheduling jitter around the FIRST case, and explicitly
 * does NOT try to wait out the second. **Do not "fix" that by raising it.**
 * Stalling every restart by seven-odd seconds to preserve the MCP port would be
 * a bad trade: that port appears in no config (see runtime.js) and `cellar mcp`
 * now re-attaches by itself across a restart (see mcp-bridge.js), so its address
 * is genuinely disposable - whereas launch latency on the everyday
 * stop-and-start gesture is not. Deliberate non-goal, recorded here because it
 * has been proposed and rejected twice.
 *
 * That non-goal is affordable only because the app now RELEASES the MCP listening
 * socket on SIGTERM (`mcp/server.ts`): nothing used to close it, so the port
 * stayed bound until the process itself exited and this window could never have
 * covered it. Closed at the source, the port is free again by the time the next
 * launch asks - which is why waiting for it buys nothing rather than why the
 * move is hidden. Every move is still announced (see `resolveWorkspacePorts`).
 *
 * Bounded, and paid only when the remembered port is actually busy: a free port
 * answers on the first probe, and a port genuinely held by something else costs
 * this once, because the fresh port we fall back to is then remembered instead.
 * A port held by a live REGISTERED instance never reaches here at all - that is
 * a settled answer, not a transient one.
 */
export const PORT_RELEASE_GRACE_MS = 500;
const PORT_RETRY_MS = 50;

/**
 * How many ephemeral ports to ask for before giving up on finding one nothing
 * else has claimed. Generous, because each attempt is a kernel-assigned port and
 * a repeat is a coincidence: reaching the bound means the machine really has
 * nothing to give, which is a launch failure rather than something to paper over.
 */
const FRESH_PORT_ATTEMPTS = 50;

/**
 * Can we bind `port` on `host` right now?
 *
 * `host` MUST be the address the server that will own this port actually binds,
 * because on macOS a `SO_REUSEADDR` bind of `127.0.0.1:P` SUCCEEDS while another
 * process holds `0.0.0.0:P` (measured; the reverse is permissive too). A probe
 * on the wrong host therefore answers a different question than the one asked:
 * probing loopback reported the app port free while adapter-node still held it
 * on the wildcard, which would hand the app a port its own `listen()` cannot
 * take. Each role passes its real host - see `BIND_HOSTS`.
 *
 * Carries the SAME known TOCTOU as `freePort()` in the launcher: the probe
 * socket is closed before the port is handed to the real `listen()`, so it is
 * briefly unclaimed. That exposure is unchanged rather than widened - a
 * remembered port is asked for by exactly one folder, and the caller falls back
 * cleanly on a lost race - and the harden-if-it-ever-flakes options are the
 * ones documented at `freePort`.
 *
 * @param {number | null | undefined} port
 * @param {string} [host]
 * @returns {Promise<boolean>}
 */
export function canBindPort(port, host = '127.0.0.1') {
	return new Promise((resolve) => {
		if (!isRememberablePort(port)) return resolve(false);
		const srv = createServer();
		srv.unref();
		srv.on('error', () => resolve(false));
		srv.listen(port, host, () => srv.close(() => resolve(true)));
	});
}

/**
 * The address each role's server really binds, which is what its probe must ask
 * about (see `canBindPort`). These mirror the real listen sites and must move
 * with them - and the APP has TWO, because the launcher spawns a different
 * server per branch:
 *   - app (default)  - `node build/index.js`, i.e. adapter-node: `HOST` or its
 *                      `0.0.0.0` default; the launcher sets only `PORT`, so in
 *                      practice the wildcard.
 *   - app (`--dev`)  - `vite dev --port <appPort> --strictPort`, spawned with no
 *                      `--host`, so vite's `resolveHostname` default applies and
 *                      `HOST` is not read at all. That default is the literal
 *                      string `'localhost'`, which vite hands to `listen()` for
 *                      NODE to resolve - and Node 18+ resolves verbatim, so on a
 *                      dual-stack machine `localhost` is `::1` first and vite
 *                      binds `[::1]:P`. So the probe passes the SAME STRING
 *                      rather than a hand-picked address: any concrete choice
 *                      asks a different question than the one that matters, and
 *                      `127.0.0.1` reports free while `[::1]:P` is held (both
 *                      verified locally). Getting it wrong is not merely
 *                      suboptimal here - the remembered port is kept, `vite`
 *                      fails `--strictPort`, the app child exits and the launch
 *                      dies, and because the remembered path "succeeded" the
 *                      preference is rewritten so every later `--dev` launch in
 *                      that folder fails the same way. A name that will not
 *                      resolve simply fails the probe, which falls back to a
 *                      fresh port: the safe direction.
 *   - mcp            - `startMcpServer` (`CELLAR_MCP_HOST || '127.0.0.1'`).
 *   - jupyter        - the sidecar spawn's `--ServerApp.ip=127.0.0.1`.
 *
 * `dev` is threaded in from the launcher rather than guessed here, because only
 * the launcher knows which of the two app servers this run will spawn.
 *
 * @param {Record<string, string | undefined>} env
 * @param {{ dev?: boolean }} [opts]
 * @returns {{ app: string, mcp: string, jupyter: string }}
 */
export function bindHosts(env = process.env, { dev = false } = {}) {
	return {
		app: dev ? 'localhost' : env.HOST || '0.0.0.0',
		mcp: env.CELLAR_MCP_HOST || '127.0.0.1',
		jupyter: '127.0.0.1'
	};
}

/** The wildcard spellings `listen()` accepts, i.e. "every address of this family". */
const WILDCARD_HOSTS = new Map([
	['0.0.0.0', '127.0.0.1'],
	['::', '::1'],
	['[::]', '::1'],
	['::0', '::1']
]);

/**
 * Addresses that must ALSO be free before a port is usable, beyond the one the
 * role's server binds.
 *
 * "Can we listen here" and "will the URL we print reach us" are two questions,
 * and a WILDCARD bind is exactly where they diverge. The launcher prints (and
 * opens) `http://localhost:<appPort>`, adapter-node binds `0.0.0.0`, and on
 * macOS/BSD a `SO_REUSEADDR` bind of `127.0.0.1:P` and one of `0.0.0.0:P`
 * coexist - with the MORE SPECIFIC binding winning the demux. So a loopback-only
 * squatter leaves the wildcard probe answering "free", Cellar takes the port and
 * starts perfectly well, and every connection to the address the user was handed
 * lands on the squatter instead. Nothing in the launch fails; the app is simply
 * not where it says it is.
 *
 * That is NEW with remembered ports and is why the check belongs here: the app
 * port always used to come from `freePort()`, which binds `127.0.0.1`, so a
 * loopback squatter could never be handed out in the first place.
 *
 * The extra address is always the LOOPBACK OF THE FAMILY THE BIND HOST ALREADY
 * SERVES, which is what makes this safe to require rather than merely prefer: a
 * machine that can bind the IPv4 wildcard has `127.0.0.1`, and one that can bind
 * the IPv6 wildcard has `::1`, so this can never veto every port on a machine
 * that lacks an address family and turn a hijack risk into a launch failure.
 * A CONCRETE bind host is already the address people connect to, so it adds
 * nothing - including `--dev`'s `localhost`, which is the very name the printed
 * URL uses, resolved the same way by the same Node.
 *
 * Stated residual, deliberately not chased: with the IPv4-wildcard default Cellar
 * serves no IPv6 at all, so a squatter on `[::1]:P` would still win an
 * IPv6-preferring client's first attempt at `http://localhost:P`. Probing `::1`
 * under an IPv4 bind is the one thing that could refuse every candidate port on
 * an IPv6-less machine, and the case is unchanged by this feature anyway -
 * `freePort()` could always hand back a `::1`-squatted port.
 *
 * @param {string} bindHost
 * @returns {string[]}
 */
export function reachHostsFor(bindHost) {
	const loopback = WILDCARD_HOSTS.get(bindHost);
	return loopback ? [loopback] : [];
}

/**
 * Decide one port.
 *
 * Pure apart from the three injected effects, so the whole rule is unit-testable
 * without booting a server:
 *   - `canBind(port, host)` - can we actually listen on it right now, asked
 *                             about the host this role's server really binds,
 *                             and then about each address in `reachHostsFor` -
 *                             see there for why a wildcard bind is not enough
 *   - `claimedBy(port)`     - cheap synchronous "who has already claimed this",
 *                             answering `'held-by-live-instance'`,
 *                             `'taken-by-this-launch'` or null. It returns the
 *                             CLAIMANT rather than a boolean because the two are
 *                             announced to the user, and a launch that had merely
 *                             taken the port for another of its own roles must
 *                             not be reported as a live instance holding it.
 *   - `freePort()`          - the ephemeral fallback
 *
 * Returns `{ port, source, reason }`. `source` is 'pinned' | 'remembered' |
 * 'fresh'; on a fresh port `reason` says WHY the preference was not honoured, so
 * the launcher can tell the user their stable port moved and what took it -
 * silently changing an address the user was told is stable is exactly the
 * confusion this feature exists to remove.
 *
 * @param {{
 *   pinned?: string | undefined,
 *   remembered?: number | null | undefined,
 *   sticky?: boolean,
 *   host?: string,
 *   canBind?: (port: number, host: string) => Promise<boolean> | boolean,
 *   claimedBy?: (port: number) => PortClaim | null | undefined,
 *   freePort: () => Promise<number> | number,
 *   bindGraceMs?: number,
 *   sleep?: (ms: number) => Promise<void>
 * }} opts
 * @returns {Promise<PortChoice>}
 */
export async function choosePort({
	pinned,
	remembered,
	sticky = true,
	host = '127.0.0.1',
	canBind = canBindPort,
	claimedBy = () => null,
	freePort,
	bindGraceMs = PORT_RELEASE_GRACE_MS,
	sleep = (ms) => new Promise((r) => setTimeout(r, ms))
}) {
	// An explicit pin is an instruction, not a preference: honour it verbatim and
	// never probe it. Deliberately the SAME lenient rule the launcher has always
	// applied (`/^\d+$/`), so pinning behaves byte-for-byte as before - including
	// failing loudly at listen() if the port is busy, which is the right outcome
	// for a port the user named.
	if (pinned && /^\d+$/.test(pinned)) {
		return { port: Number(pinned), source: 'pinned' };
	}

	const reachHosts = reachHostsFor(host);

	/**
	 * Is `port` unusable for this role right now, and if so why?
	 *
	 * Two questions in ONE place so the remembered path and the fresh fallback can
	 * never answer them differently: can this role's server LISTEN on it (the bind
	 * host), and would the address people CONNECT to actually reach that server
	 * (`reachHostsFor` - see there). They fail for different reasons and are
	 * announced differently, so the answer is the cause rather than a boolean.
	 *
	 * @param {number} port
	 * @returns {Promise<FreshReason | null>} null = usable
	 */
	const unusable = async (port) => {
		if (!(await canBind(port, host))) return 'port-unavailable';
		for (const reach of reachHosts) {
			if (!(await canBind(port, reach))) return 'address-unreachable';
		}
		return null;
	};

	/** @param {FreshReason} reason @returns {Promise<PortChoice>} */
	const fresh = async (reason) => {
		// Guard the fallback against a port this launch has already claimed for
		// another role: `freePort()` probes and releases, so two calls could in
		// principle agree, and a hand-edited preference could name one port twice.
		//
		// Then probe it on THIS ROLE's own bind host, for exactly the reason the
		// remembered path does (see `canBindPort`): the launcher's `freePort()` asks
		// the kernel for a free `127.0.0.1` port, while adapter-node binds the
		// wildcard - and on macOS a loopback bind succeeds against a wildcard holder,
		// so a kernel-assigned port can still be one the app's own `listen()` cannot
		// take. One probe per candidate, no grace loop: an ephemeral port that is
		// already busy is a coincidence to step over, not a previous run letting go.
		for (let i = 0; i < FRESH_PORT_ATTEMPTS; i++) {
			const port = await freePort();
			if (claimedBy(port)) continue;
			if (await unusable(port)) continue;
			return { port, source: 'fresh', reason };
		}
		// Never hand back a port we KNOW is taken - that is the one outcome this
		// loop exists to prevent, and it would surface much later as two roles
		// racing for one address. Refusing to launch is the honest failure.
		throw new Error(
			`could not find a free port after ${FRESH_PORT_ATTEMPTS} attempts - every port offered is already ` +
				`claimed by a live instance, by another role of this launch, or unusable on ` +
				[host, ...reachHosts].join(' / ') +
				'.'
		);
	};

	// Isolated / `--new` launches never use the sticky path: they exist so
	// concurrent instances (e2e at workers:2, throwaway mkdtemp workspaces, a
	// deliberate second instance in a folder that already has one) cannot collide,
	// and a remembered port is precisely a port another instance is likely to hold.
	if (!sticky) return fresh('not-sticky');
	if (!isRememberablePort(remembered)) return fresh('no-preference');
	// Yield to whoever already has it rather than race them. Never reclaim - and
	// report WHICH of the two claimants it was, because they are different facts
	// with different messages (see MOVE_CAUSE).
	const claim = claimedBy(remembered);
	if (claim) return fresh(claim);
	// Re-probe until it frees or the window runs out: the previous run may still
	// be letting go (see PORT_RELEASE_GRACE_MS). Costs one probe when the port is
	// already free, and returns the instant it binds rather than sleeping out the
	// window - the port coming back IS the old process exiting.
	const deadline = Date.now() + Math.max(0, bindGraceMs);
	for (;;) {
		const why = await unusable(remembered);
		if (!why) return { port: remembered, source: 'remembered' };
		if (Date.now() >= deadline) return fresh(why);
		await sleep(PORT_RETRY_MS);
	}
}

/**
 * Resolve all three of a launch's ports and persist the preference.
 *
 * The whole policy lives here rather than in `bin/cellar.js` so it is reachable
 * without booting a server - which is what lets the isolated/`--new` guarantee
 * (never sticky, so concurrent instances cannot collide) be a tested behavior
 * instead of a claim about a line of launcher code.
 *
 * `sticky` is the launcher's `!forceNew` - the SAME gate as the single-instance
 * lock and the reap sweep, and `CELLAR_ISOLATED` implies it. A non-sticky launch
 * neither reads nor writes the preference: it must not adopt a port another
 * instance probably holds, and it must not overwrite the folder's memory with
 * the throwaway ports it happened to get.
 *
 * Returns each role's full `choosePort` result alongside the plain port numbers.
 *
 * @param {{
 *   workspace: string,
 *   sticky: boolean,
 *   dev?: boolean,
 *   env?: Record<string, string | undefined>,
 *   freePort: () => Promise<number> | number,
 *   instances?: (InstanceEntry | null | undefined)[],
 *   isAlive?: (e: InstanceEntry) => boolean,
 *   excludePid?: number,
 *   canBind?: (port: number, host: string) => Promise<boolean> | boolean,
 *   bindGraceMs?: number,
 *   log?: (msg: string) => void
 * }} opts
 * @returns {Promise<{ appPort: number, mcpPort: number, jupyterPort: number, app: PortChoice, mcp: PortChoice, jupyter: PortChoice }>}
 */
export async function resolveWorkspacePorts({
	workspace,
	sticky,
	dev = false,
	env = process.env,
	freePort,
	instances = [],
	isAlive,
	excludePid,
	canBind = canBindPort,
	bindGraceMs = PORT_RELEASE_GRACE_MS,
	log = () => {}
}) {
	const prefs = sticky ? readPortPrefs(workspace) : {};
	// Ports a live registered instance holds. Never reclaimed - we always yield.
	//
	// Consulted on the ISOLATED path too, which does not weaken its guarantee:
	// what an isolated launch must never touch is the PREFERENCE (read above,
	// written below, both still gated on `sticky`), and this is a read-only
	// registry lookup. It only makes a collision less likely - which matters
	// because a bind probe races (and, on macOS, a loopback probe cannot even see
	// a wildcard holder), while the registry answers before anything is serving.
	const heldByInstances = portsHeldByLiveInstances(instances, { isAlive, excludePid });
	// Ports THIS launch has already handed to one of its own roles. Kept apart
	// from the set above rather than folded into it: both make a port unusable,
	// but only one of them is a live instance, and the move is ANNOUNCED - a
	// merged set told the user "another running Cellar instance is using it" about
	// a conflict with this very launch, naming an instance that does not exist.
	/** @type {Set<number>} */
	const takenHere = new Set();
	/** @param {number} p @returns {PortClaim | null} */
	const claimedBy = (p) =>
		heldByInstances.has(p) ? 'held-by-live-instance' : takenHere.has(p) ? 'taken-by-this-launch' : null;
	/** @param {string} pinnedEnv @param {Partial<Parameters<typeof choosePort>[0]>} opts */
	const take = async (pinnedEnv, opts) => {
		const r = await choosePort({
			pinned: env[pinnedEnv],
			claimedBy,
			canBind,
			freePort,
			bindGraceMs,
			...opts
		});
		takenHere.add(r.port);
		return r;
	};

	// ORDER IS LOAD-BEARING: the sticky roles are resolved FIRST and Jupyter last.
	// Jupyter is deliberately never sticky (see the module header), so it takes a
	// kernel-assigned ephemeral port and claims it - and an ephemeral port can land
	// on the very port this folder remembers. Resolved first, that pushed the
	// sticky role off its remembered address and then PERSISTED the replacement,
	// losing the stable address this whole file exists to keep. Last, it simply
	// skips whatever the sticky roles took, which its own `fresh()` already does.
	const hosts = bindHosts(env, { dev });
	const app = await take('CELLAR_APP_PORT', {
		sticky,
		remembered: prefs.appPort,
		host: hosts.app
	});
	const mcp = await take('CELLAR_MCP_PORT', {
		sticky,
		remembered: prefs.mcpPort,
		host: hosts.mcp
	});
	const jupyter = await take('CELLAR_JUPYTER_PORT', {
		sticky: false,
		host: hosts.jupyter
	});

	if (sticky) {
		// Say so when a port the user was told is stable had to move, and why - a
		// silently different address is the confusion this feature exists to remove.
		//
		// EVERY move speaks, including the MCP role's. The routine Ctrl-C relaunch
		// used to move that port reliably, which made this line the commonest thing
		// the feature said and turned an honest notice into noise - but the cause was
		// the app never releasing the MCP listening socket on SIGTERM, and that is
		// fixed at the source (`mcp/server.ts` now closes it), so the port is free
		// again by the time the next launch asks. A routine restart is therefore
		// silent because NOTHING MOVED, which is what the user was promised - not
		// because a real move was suppressed.
		/** @type {[string, PortChoice, number | undefined][]} */
		const moved = [
			['app', app, prefs.appPort],
			['MCP', mcp, prefs.mcpPort]
		];
		for (const [label, r, want] of moved) {
			if (r.source === 'fresh' && want != null)
				log(
					`[cellar] ${label} port ${want} was unavailable (${MOVE_CAUSE[r.reason] ?? r.reason}); ` +
						`using ${r.port} and remembering it.`
				);
		}
		// Remember only what we CHOSE. A pinned port is not a preference -
		// recording it would let an explicit pin silently outlive the run that
		// asked for it, and reappear on a later launch that pinned nothing.
		writePortPrefs(workspace, {
			...(app.source === 'pinned' ? {} : { appPort: app.port }),
			...(mcp.source === 'pinned' ? {} : { mcpPort: mcp.port })
		});
	}

	return {
		appPort: app.port,
		mcpPort: mcp.port,
		jupyterPort: jupyter.port,
		app,
		mcp,
		jupyter
	};
}
