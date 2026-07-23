<!--
  Sidebar → Databricks. The whole connection flow, from "nothing installed" to
  point-and-click table previews, in one section.

  Every state this renders is reachable WITHOUT a workspace:
    - no `~/.databrickscfg`        → how to create a profile
    - no databricks-sdk / -connect → an uv install button (+ the exact command)
    - no uv                        → the command to run by hand
    - a profile but no kernel venv → how to bind one
    - any SDK failure              → the workspace's own message, plus what to do
  so the section is useful (and never blank, never a crash) before the first
  successful connect. Error copy is keyed off the server's `code`, not its prose.

  Listing (profiles/clusters/catalogs/schemas/tables) is a server call; the
  session itself is built in the kernel. See `src/lib/server/databricks.js`.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { subscribeEvents } from '$lib/events-client';
	import { getUi, setUi, setUiNow } from '$lib/uiState';
	import { normalizeDatabricksHost } from '$lib/databricksHost';
	import {
		PROFILE_REAUTH_CODE,
		REAUTH_COMMAND_HEAD,
		REAUTH_PROFILE_FLAG,
		reauthCommand,
		reauthDetail,
		reauthExplanation
	} from '$lib/databricksReauth';
	import type { SessionId } from '$lib/server/types';

	// ---- Response shapes from src/routes/api/databricks/* --------------------
	// The routes are still .js and the server module doesn't export these, so the
	// shapes are declared locally and `res.json()` is narrowed into them at each
	// fetch boundary.
	/** The `{code, message}` error every failing Databricks route returns. */
	interface DbxError {
		code: string;
		message: string;
		/** Set for `profile_reauth_required`: the profile whose saved sign-in expired. */
		profile?: string;
	}
	interface DbxProfile {
		name: string;
		host?: string;
		hasToken?: boolean;
		authType?: string | null;
	}
	interface DbxConnection {
		connected: boolean;
		profile?: string;
		host?: string;
		clusterId?: string;
		clusterName?: string;
		sparkVersion?: string;
		/** Present when a live session ended because the kernel restarted. */
		lost?: { clusterName?: string };
		/**
		 * The Spark Connect session expired (idle timeout / cluster GC / a closed
		 * client) and could not be healed in place. Reported as `connected:false`
		 * with a `lost` cluster; Cellar is attempting a background reconnect.
		 */
		expired?: boolean;
		/**
		 * Still connected, but a `SELECT 1` liveness probe could not confirm the
		 * session (kernel busy, or a transient error). Not a dead session.
		 */
		livenessUnverified?: boolean;
	}
	interface DbxInstall {
		python: string | null;
		sdk: boolean;
		connect: boolean;
	}
	interface DbxStatus {
		connection?: DbxConnection;
		config?: { profiles?: DbxProfile[] };
		install?: DbxInstall;
		/** Whether uv is available to install packages. */
		uv?: boolean;
		/** Bare hosts this server process has completed a Cellar sign-in for (NORMALIZED). */
		signedInHosts?: string[];
		/** No-token external-browser profiles this server process has signed in for. */
		signedInProfiles?: string[];
	}
	/** What `POST /api/databricks/logout` reports, so the note can be honest about what was cleared. */
	interface DbxLogout {
		disconnected: number;
		clearedTokens: number;
		externalSkipped: number;
		/**
		 * The sign-out did not provably complete (a purge that could not run, a
		 * cache key that matched nothing, a notebook mid-connect). An incomplete
		 * sign-out must never be shown as a clean one, so this gets its own
		 * warning-toned message instead of the ordinary confirmation.
		 */
		incomplete?: boolean;
		incompleteReason?: string | null;
		/**
		 * WHICH part did not complete, so the advice can name the right remedy: a
		 * surviving token is a file the user can delete, a notebook mid-connect is
		 * not. Telling someone to remove a cache entry that was just deleted is
		 * exactly the "say more than the server verified" failure this feature keeps
		 * guarding against.
		 */
		purgeFailed?: number;
		purgeMissed?: number;
		sessionsFailed?: number;
		/** A connect was in flight, so the teardown never ran - it can simply be retried. */
		sessionsBusy?: number;
		/** The teardown FAILED, so the notebook is still bound and may rebuild `spark`. */
		sessionsStuck?: number;
	}
	interface DbxCluster {
		cluster_id: string;
		name: string;
		state: string;
		spark_version?: string;
	}
	/** A Unity Catalog child entry (a catalog/schema name, or a table with its full name). */
	interface DbxCatalogEntry {
		name: string;
		full_name?: string;
	}
	/** A lazily-loaded Unity Catalog tree node's child list + load state. */
	interface DbxNodeState {
		loading: boolean;
		error: DbxError | null;
		items: DbxCatalogEntry[] | null;
	}

	let {
		/**
		 * The ACTIVE notebook's absolute path. Databricks is per-notebook - `spark`/`w`
		 * live in each notebook's own kernel - so the panel reflects (and connect/
		 * disconnect act on) whichever notebook the user has focused. Null when no
		 * notebook tab is open, in which case requests target the server default.
		 */
		notebookPath = null,
		/**
		 * The active notebook's kernel session epoch. A change means that notebook's
		 * kernel restarted and replaced its namespace → its `spark` is gone; re-read.
		 */
		kernelSessionId = null,
		/** Insert a code cell into the active notebook and run it. Null when no notebook is open. */
		onInsertAndRun = null,
		/** Called after a successful connect/disconnect/reconnect so the shell refreshes its kernel + variables. */
		onSessionChange = null,
		/** Restart the active notebook's kernel - used to apply the Databricks-runtime toggle. */
		onRestartKernel = null
	}: {
		notebookPath?: string | null;
		kernelSessionId?: SessionId | null;
		onInsertAndRun?: ((source: string) => void) | null;
		onSessionChange?: (() => void) | null;
		onRestartKernel?: ((path: string) => void | Promise<void>) | null;
	} = $props();

	/** Let the section header's refresh button re-read status (bind:this in Sidebar). */
	export function refresh() {
		loadStatus();
	}

	// ---- Databricks-runtime card (advertise DATABRICKS_RUNTIME_VERSION) --------
	// Sets DATABRICKS_RUNTIME_VERSION in the kernel at start so a notebook's
	// import-time `IS_DATABRICKS` gate takes its `dbutils.widgets` path. Persisted
	// per workspace (server keys mirrored from `$lib/server/databricksRuntime.ts` -
	// a client component can't import a `$lib/server` module). The gate is
	// import-time, so a change takes effect only on the next kernel START; rather
	// than leave the user a manual "restart to apply" hint, Cellar APPLIES the
	// change immediately by restarting the kernel (which re-injects the env AND
	// rebuilds spark/w via the server's reconnect-after-restart path). Default ON,
	// scoped server-side to a CONNECTED notebook - so a purely-local kernel is never
	// told it is on Databricks, and CONNECTING auto-enables it (see `connect()`).
	const DBX_RUNTIME_KEY = 'cellar-databricks-runtime';
	const DBX_RUNTIME_VERSION_KEY = 'cellar-databricks-runtime-version';
	const DBX_RUNTIME_VERSION_DEFAULT = '15.4';
	let runtimeOn = $state(true);
	let runtimeVersion = $state(DBX_RUNTIME_VERSION_DEFAULT);
	// The version string currently LIVE in the kernel (set at each apply), so a
	// version edit only restarts when it actually changed from what is running.
	let appliedVersion = $state(DBX_RUNTIME_VERSION_DEFAULT);
	// True while a runtime change (toggle or version) is restarting the kernel, so
	// the Runtime card shows an "applying…" state and the transient post-restart
	// lost/expired flash is suppressed.
	let runtimeApplying = $state(false);
	// True from the moment an EXPECTED kernel restart is issued (connect, switch
	// cluster, or a runtime toggle/version apply - all go through `applyRuntime`)
	// until the session settles again (`settleConnection`). It is what distinguishes
	// an expected restart-in-progress from a genuine unexpected session loss: while
	// it is set, the "lost"/"expired" cards are suppressed and the connecting/connected
	// view is held, so the transient mid-restart "session lost" the epoch bump reports
	// never surfaces. Cleared on settle (connected) OR on the reconnect timing out, so
	// a reconnect that genuinely fails still falls through to the real lost/expired
	// state with its Reconnect button.
	let restarting = $state(false);
	onMount(() => {
		runtimeOn = getUi<boolean>(DBX_RUNTIME_KEY, true);
		runtimeVersion = getUi<string>(DBX_RUNTIME_VERSION_KEY, DBX_RUNTIME_VERSION_DEFAULT);
		appliedVersion = runtimeVersion;
	});

	/**
	 * Apply the runtime preference to the LIVE kernel: persist on/off (+ version)
	 * server-side FIRST (race-free via `setUiNow`, so the restart re-reads the new
	 * value), then restart the kernel so `initKernel` injects/omits the env for the
	 * fresh imports and `reconnectAfterKernelRestart` rebuilds spark/w. The one
	 * mechanism behind both connect-time auto-enable and the manual toggle - there is
	 * no second "apply runtime" path.
	 */
	async function applyRuntime(on: boolean): Promise<void> {
		runtimeOn = on; // optimistic
		const v = runtimeVersion.trim();
		await setUiNow(DBX_RUNTIME_KEY, on);
		await setUiNow(DBX_RUNTIME_VERSION_KEY, v === '' ? null : v);
		appliedVersion = v || DBX_RUNTIME_VERSION_DEFAULT;
		if (onRestartKernel && notebookPath) {
			// Mark the expected-restart window BEFORE issuing it, so the transient
			// mid-restart "session lost" the epoch bump reports is read as "connecting",
			// never "lost". `settleConnection` clears it once the session settles.
			restarting = true;
			await onRestartKernel(notebookPath);
		}
	}

	/** Toggle the runtime on/off; applies IMMEDIATELY by restarting the kernel. */
	async function toggleRuntime() {
		if (runtimeApplying || busy) return;
		runtimeApplying = true;
		try {
			await applyRuntime(!runtimeOn);
			await settleConnection();
		} finally {
			runtimeApplying = false;
			restarting = false; // definitive cleanup if applyRuntime threw before settleConnection
		}
	}
	function onVersionInput(e: Event) {
		// Reflect + persist as the user types; the actual apply (kernel restart) is
		// deferred to blur/Enter so a keystroke can't restart the kernel per character.
		const v = (e.currentTarget as HTMLInputElement).value.trim();
		runtimeVersion = v;
		setUi(DBX_RUNTIME_VERSION_KEY, v === '' ? null : v);
	}
	/** Commit a version edit (blur/Enter): restart to apply only if it truly changed. */
	async function commitVersion() {
		if (runtimeApplying || busy || !runtimeOn) return;
		if ((runtimeVersion.trim() || DBX_RUNTIME_VERSION_DEFAULT) === appliedVersion) return;
		runtimeApplying = true;
		try {
			await applyRuntime(true);
			await settleConnection();
		} finally {
			runtimeApplying = false;
			restarting = false; // definitive cleanup if applyRuntime threw before settleConnection
		}
	}

	/**
	 * A kernel restart rebuilds the Databricks session asynchronously (the server
	 * fires `reconnectAfterKernelRestart` detached and publishes `databricks:changed`
	 * on success, but the restart also bumps the kernel epoch, so a status read taken
	 * mid-restart transiently reports "session lost"). Poll - bounded - until the
	 * connection settles back to `connected`, and resolve ONLY then, so the caller's
	 * `busy`/`runtimeApplying` guard holds the connected/connecting view through the
	 * whole transient window and the panel never flashes the "lost" card. On timeout
	 * (the reconnect genuinely failed) it returns and the last status - which the
	 * poll left honest - shows the real state.
	 *
	 * The connected check reads THIS poll's own fetched body, never the shared
	 * `status`: a concurrent `loadStatus` (the kernelSessionId `$effect`) bumps
	 * `statusSeq` and can leave `status` momentarily holding the pre-restart
	 * "connected" while this poll's fresh "lost" read was discarded - reading `status`
	 * there released the gate early and the panel stuck on "lost". `restarting` is the
	 * explicit "an expected restart is in flight" flag (set in `applyRuntime` before
	 * the restart, cleared here on settle): while it is true the lost/expired cards are
	 * suppressed in favour of the connecting/connected view, so an unexpected loss and
	 * an expected restart-in-progress can never be confused.
	 */
	async function settleConnection(): Promise<void> {
		const deadline = Date.now() + 15000;
		try {
			// eslint-disable-next-line no-constant-condition
			while (true) {
				const body = await loadStatus();
				if (body?.connection?.connected) return;
				if (Date.now() >= deadline) return;
				await new Promise((r) => setTimeout(r, 400));
			}
		} finally {
			restarting = false;
		}
	}

	/** Query string carrying the active notebook path, so every per-notebook request targets it. */
	function pathQuery(): string {
		return notebookPath ? `?path=${encodeURIComponent(notebookPath)}` : '';
	}

	/** Normalize a thrown value (a route body, or an Error) into `{code, message}`. */
	function toDbxError(err: unknown): DbxError {
		const e = err as { code?: unknown; message?: unknown; profile?: unknown } | null | undefined;
		return {
			code: typeof e?.code === 'string' ? e.code : 'error',
			message: typeof e?.message === 'string' ? e.message : String(err),
			// Carried only by `profile_reauth_required`, where the remedy names it.
			...(typeof e?.profile === 'string' && e.profile ? { profile: e.profile } : {})
		};
	}

	/** Rows a table preview asks for. Kept small: this is a look, not a load. */
	const LIMITS = [10, 50, 100, 500];
	let limit = $state(50);

	// ---- Status (profiles + install + connection) ----------------------------
	let status = $state<DbxStatus | null>(null);
	let statusError = $state('');
	let busy = $state(''); // 'connect' | 'disconnect' | 'logout' | 'login' | 'reconnect' | 'install' | ''

	const connection = $derived<DbxConnection>(status?.connection ?? { connected: false });
	const connected = $derived(!!connection.connected);
	const profiles = $derived(status?.config?.profiles ?? []);
	const hasProfiles = $derived(profiles.length > 0);
	const install = $derived(status?.install ?? { python: null, sdk: false, connect: false });
	const installed = $derived(!!install.sdk && !!install.connect);
	/**
	 * Everything needed before a single SDK call can be attempted. A profile is
	 * NOT required: a teammate with no `~/.databrickscfg` can still type a host
	 * and sign in with OAuth, so readiness is only "the packages are importable".
	 */
	const ready = $derived(installed);

	let profile = $state('');
	let profileTouched = false;
	// (auth error shape declared with its $state below)

	// ---- Auth source: a config profile, or a typed workspace host -------------
	// `useHost` lets someone override the profile picker; with no profiles at all
	// the host field is the only way in.
	let useHost = $state(false);
	let hostInput = $state('');
	/** Signed in for the current selection this session (an OAuth token is usable). */
	let authed = $state(false);
	let authError = $state<DbxError | null>(null);
	/**
	 * Most named profiles are handed straight to the SDK, so they are never
	 * pre-gated - we try to list, and only if the SDK actually reports it needs a
	 * fresh interactive login (`oauth_login_required`, set by `loadClusters`) do we
	 * show the sign-in button. The exception, mirrored from the server, is a
	 * no-token `auth_type = external-browser` profile: it CAN pop a browser, so
	 * `profileNeedsSignIn` pre-gates it (no auto-listing) exactly like a bare typed
	 * host, which has no profile for the SDK to read and is always gated first.
	 */
	let oauthRequired = $state(false);

	const selectionMode = $derived(useHost || !hasProfiles ? 'host' : 'profile');
	const hostTrimmed = $derived(hostInput.trim());
	const hostLooksValid = $derived(/^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+/i.test(hostTrimmed));
	const haveSelection = $derived(selectionMode === 'profile' ? !!profile : hostLooksValid);
	/** The selected profile record, for its auth-shape fields. */
	const selectedProfile = $derived(profiles.find((p) => p.name === profile));
	/** A no-token external-browser profile: the SDK could pop a browser, so pre-gate it (same rule as the server's `profileNeedsSignIn`). */
	const profileNeedsSignIn = $derived(
		selectionMode === 'profile' && selectedProfile?.authType === 'external-browser' && !selectedProfile?.hasToken
	);
	/** Show the sign-in button instead of clusters: a bare host (always), a no-token external-browser profile, or a profile the SDK said needs OAuth. */
	const needsAuth = $derived(
		!connected &&
			haveSelection &&
			!authed &&
			(selectionMode === 'host' || profileNeedsSignIn || oauthRequired)
	);
	/** Identifies the current selection, so a change resets sign-in + cluster state. */
	const selectionKey = $derived(selectionMode === 'profile' ? `p:${profile}` : `h:${hostTrimmed}`);
	/**
	 * Could this selection's credential be one CELLAR minted? Mirrors the server's
	 * `hasCellarCachedOAuth`: only the two external-browser shapes Cellar signs in
	 * for itself (a bare typed host, a no-token external-browser profile). A PAT or
	 * a `databricks-cli` profile is the user's own credential, so there is nothing
	 * of ours to purge.
	 */
	const cellarOwnsAuth = $derived(selectionMode === 'host' || profileNeedsSignIn);
	/**
	 * Does Cellar hold a sign-in for this selection that Log out would clear? The
	 * server's recorded sets are the truth (they survive a reload); `authed` covers
	 * the window between signing in and the next status read. Hosts are matched
	 * NORMALIZED, the way the server records them - hence the shared normalizer.
	 */
	const cellarSignedIn = $derived(
		cellarOwnsAuth &&
			(authed ||
				(selectionMode === 'host'
					? (status?.signedInHosts ?? []).includes(normalizeDatabricksHost(hostTrimmed))
					: (status?.signedInProfiles ?? []).includes(profile)))
	);

	/**
	 * Does Cellar hold ANY recorded sign-in, process-wide? `logout()` is deliberately
	 * global - it purges every sign-in this server recorded, not just the selection
	 * this panel happens to show - so this, NOT the per-selection `cellarSignedIn`, is
	 * what the confirm copy and the button's visibility must key off. Keyed off the
	 * selection instead, the confirm would promise "nothing to clear" while a
	 * different recorded OAuth host's token is about to be deleted (sign in to a bare
	 * host, switch the picker to a PAT profile, connect, Log out), and the button
	 * would HIDE the only control that can purge that sign-in. `cellarSignedIn` is
	 * folded in for the window between signing in and the next status read.
	 */
	const cellarSignedInAnywhere = $derived(
		cellarSignedIn ||
			(status?.signedInHosts ?? []).length > 0 ||
			(status?.signedInProfiles ?? []).length > 0
	);

	/**
	 * What Log out will actually DO, said before the user commits. The button is
	 * always shown while connected (where it ends the session too), so it renders over
	 * a PAT/`databricks-cli` connection that may have no Cellar-minted credential
	 * anywhere - and promising to clear a saved sign-in there would have the
	 * pre-action confirm contradicting the post-action note, in the one place the
	 * user decides whether to proceed. The session half is global either way, which
	 * is the part worth confirming. The "your credentials live elsewhere" clause is
	 * the one genuinely per-selection bit, so it is gated on `cellarOwnsAuth`.
	 */
	const logoutConfirmCopy = $derived(
		cellarSignedInAnywhere
			? "Sign out of Databricks everywhere? This clears every saved sign-in and disconnects every notebook's Spark session app-wide - reconnecting can take minutes on a cold cluster."
			: "Sign out of Databricks everywhere? This disconnects every notebook's Spark session app-wide - reconnecting can take minutes on a cold cluster. There is no saved Cellar sign-in to clear anywhere" +
				(cellarOwnsAuth
					? '.'
					: ': this connection authenticates through ~/.databrickscfg or the databricks CLI, which Cellar leaves untouched.')
	);
	const logoutButtonTitle = $derived(
		cellarSignedInAnywhere
			? "Sign out of Databricks everywhere - clears the saved sign-ins and disconnects every notebook; you'll need to sign in again"
			: 'Sign out of Databricks everywhere - disconnects every notebook; there is no saved Cellar sign-in to clear'
	);

	/** The `{profile}|{host}` body/query a request should carry for the current selection. */
	function selectionParams(): Record<string, string> {
		return selectionMode === 'profile' ? { profile } : { host: hostTrimmed };
	}

	// Monotonic generations, one per loader. Responses are unordered: a status read
	// issued before a disconnect can resolve *after* it and clobber the UI back to
	// "connected", and a cluster list for profile A can land after profile B's. So
	// every write is gated on still being the newest word on its subject - the same
	// guard `+page.svelte` uses for `/api/kernel` (`kernelReqSeq`). Plain `let`, not
	// `$state`: a generation counter is bookkeeping, never rendered.
	let statusSeq = 0;
	let clustersSeq = 0;
	let catalogsSeq = 0;

	// RETURNS the body this call fetched (or null on failure), regardless of whether
	// it was the newest word on `status` (the `statusSeq` guard only decides whether
	// to APPLY it to the shared `status`). `settleConnection` polls on that returned
	// body, NOT the shared `status`: a concurrent `loadStatus` (the kernelSessionId
	// `$effect`, or an SSE-driven reload) bumps `statusSeq` and would otherwise make a
	// settle poll discard its own fresh read and re-check a STALE `status` - which is
	// exactly how a connect used to release its "connecting" gate against a leftover
	// "connected" while the real reconnect was mid-flight, then stick on "lost".
	async function loadStatus(): Promise<DbxStatus | null> {
		const seq = ++statusSeq;
		try {
			const res = await fetch(`/api/databricks${pathQuery()}`);
			const body = (await res.json()) as DbxStatus;
			if (!res.ok) throw new Error((body as { message?: string })?.message || 'failed to read Databricks status');
			if (seq !== statusSeq) return body; // superseded for `status`, but still a valid read for the caller
			status = body;
			statusError = '';
			// Default to DEFAULT, else the first profile - until the user picks one.
			if (!profileTouched) {
				const names: string[] = (body.config?.profiles ?? []).map((p: DbxProfile) => p.name);
				profile = body.connection?.profile || (names.includes('DEFAULT') ? 'DEFAULT' : (names[0] ?? ''));
			}
			return body;
		} catch (err) {
			if (seq === statusSeq) statusError = toDbxError(err).message;
			return null;
		}
	}

	onMount(() => {
		loadStatus();
		// Another tab (or this one) connected/disconnected; and every SSE reconnect
		// is a chance we missed one.
		return subscribeEvents((ev) => {
			if (ev.type === 'databricks:changed' || ev.type === 'sse:open') loadStatus();
		});
	});

	// Re-read the connection whenever the FOCUSED notebook changes (Databricks is
	// per-notebook, so the panel must switch to that notebook's session) OR its
	// kernel session epoch changes (a restart replaced the namespace: whatever
	// `spark` was, it is gone). The server decides from the per-notebook epoch.
	// `lastKey`/`lastSession` are deliberately NOT `$state`: this effect must depend
	// on the path + epoch alone. Reading `status` here (which `loadStatus` writes)
	// would loop.
	let lastKey: string | null | undefined;
	let lastSession: SessionId | null | undefined;
	$effect(() => {
		const key = notebookPath;
		const sid = kernelSessionId;
		if (lastKey === undefined) {
			lastKey = key; // onMount already loaded the first status
			lastSession = sid;
			return;
		}
		if (lastKey === key && lastSession === sid) return;
		lastKey = key;
		lastSession = sid;
		loadStatus();
	});

	// ---- Clusters ------------------------------------------------------------
	let clusters = $state<DbxCluster[] | null>(null);
	let clustersError = $state<DbxError | null>(null);
	let clustersLoading = $state(false);
	let connectingId = $state('');
	/** Name of the cluster being connected, for the Cluster card's "Connecting…" state. */
	let connectingName = $state('');
	/** Switch-cluster: show the picker again while a session is live. */
	let switching = $state(false);

	// Clusters load whenever the selection is not showing the sign-in button
	// (`needsAuth`). For a bare host - and for a no-token external-browser profile -
	// that means "only after sign-in", so a listing subprocess can never be the
	// thing that pops the OAuth browser. Every other named profile is not pre-gated:
	// its listing runs immediately (the SDK reads its own token cache), and only a
	// genuine `oauth_login_required` flips `needsAuth`.
	const showClusters = $derived(ready && haveSelection && !needsAuth && (!connected || switching));
	/** Plain (non-reactive) memo of the selection the cluster list belongs to. */
	let clustersFor: string | null = null;

	$effect(() => {
		const key = selectionKey;
		if (!showClusters || clustersFor === key) return;
		clustersFor = key;
		loadClusters();
	});

	async function loadClusters() {
		const seq = ++clustersSeq;
		clustersLoading = true;
		clustersError = null;
		oauthRequired = false;
		try {
			const q = new URLSearchParams(selectionParams());
			const res = await fetch(`/api/databricks/clusters?${q}`);
			const body = await res.json();
			if (!res.ok) throw body;
			if (seq !== clustersSeq) return; // a newer selection's list superseded this one
			clusters = body.clusters;
		} catch (err) {
			if (seq !== clustersSeq) return;
			clusters = null;
			const e = toDbxError(err);
			clustersError = e;
			// The SDK reports this selection needs a fresh interactive login (a bare
			// host we lost the in-process sign-in flag for, or a profile whose cached
			// OAuth token is gone/absent): fall back to the sign-in button.
			if (e.code === 'oauth_login_required') {
				authed = false;
				oauthRequired = true;
			}
		} finally {
			if (seq === clustersSeq) clustersLoading = false;
		}
	}

	function refreshClusters() {
		clustersFor = null;
		if (haveSelection) {
			clustersFor = selectionKey;
			loadClusters();
		}
	}

	/**
	 * A new selection: forget the old sign-in + cluster list, and the log-out
	 * feedback with it. The note deliberately OUTLIVES the connected→picker card
	 * swap a log out causes (it is rendered ungated by `cellarSignedInAnywhere`), but it
	 * describes ONE selection - once the user picks another profile or types
	 * another host it would be claiming something about a selection it no longer
	 * describes. `logoutDatabricks` calls this BEFORE it writes its own note.
	 */
	function resetSelection() {
		authed = false;
		oauthRequired = false;
		authError = null;
		clusters = null;
		clustersError = null;
		clustersFor = null;
		clearLogoutFeedback();
		// An armed confirm belongs to the selection it was armed on: changing the
		// selection disarms it rather than leaving a primed global sign-out behind.
		confirmLogout = false;
	}

	function pickProfile(name: string) {
		profileTouched = true;
		profile = name;
		resetSelection();
	}

	function toggleUseHost() {
		useHost = !useHost;
		resetSelection();
	}

	// ---- Sign in (OAuth U2M via the SDK; only reached when auth needs a browser) ----
	async function signIn() {
		if (busy) return;
		busy = 'login';
		authError = null;
		// A fresh sign-in falsifies the log-out feedback as surely as a selection change
		// does - and this path never runs `resetSelection`, so it has to drop it itself.
		clearLogoutFeedback();
		try {
			const res = await fetch('/api/databricks/login', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(selectionParams())
			});
			const body = await res.json();
			if (!res.ok) throw body;
			authed = true;
			oauthRequired = false;
			// Force the cluster effect to reload: a profile that surfaced
			// `oauth_login_required` already ran a (failed) listing, so `clustersFor`
			// still points at this selection and the effect's guard would skip it.
			clustersError = null;
			clustersFor = null;
		} catch (err) {
			authError = toDbxError(err);
		} finally {
			busy = '';
		}
	}

	// ---- Connect / disconnect / reconnect ------------------------------------
	let connectError = $state<DbxError | null>(null);
	// Reconnect is a distinct, bound-but-not-live recovery: its feedback lives in the
	// expired/lost box, so it keeps its own error + note separate from the picker's.
	let reconnectError = $state<DbxError | null>(null);
	let reconnectNote = $state('');
	// Log out keeps its own feedback too: it is the one action that reports on the
	// AUTH, not the session, so its outcome must not be mistaken for a connect error.
	let logoutError = $state<DbxError | null>(null);
	let logoutNote = $state('');
	// An INCOMPLETE sign-out is not a quieter success: the cached token may still be
	// on disk, so it gets its own warning-toned line rather than the confirmation.
	let logoutWarning = $state('');
	// Log out is the most destructive control in the panel - it signs out EVERYWHERE
	// and disconnects every notebook app-wide - and it sits right below the everyday
	// Disconnect, so a misclick on the common action must not land on the rare one.
	// Two-step inline confirm, the same idiom as the kernel wipe / checkpoint restore.
	let confirmLogout = $state(false);

	/**
	 * Drop the log-out feedback. It deliberately OUTLIVES the connected→picker card
	 * swap a log out causes, but it describes one moment in time: a selection change,
	 * a fresh sign-in, or a connect all falsify it, and leaving it up would render
	 * "signed out everywhere" under a live cluster.
	 */
	function clearLogoutFeedback() {
		logoutNote = '';
		logoutWarning = '';
		logoutError = null;
	}

	async function connect(cluster: DbxCluster) {
		if (busy) return;
		busy = 'connect';
		connectingId = cluster.cluster_id;
		connectingName = cluster.name;
		connectError = null;
		reconnectNote = '';
		reconnectError = null;
		// Same reason as `signIn`: a live session is the loudest possible contradiction
		// of "signed out everywhere", and connecting is not a selection change.
		clearLogoutFeedback();
		try {
			const res = await fetch('/api/databricks/connect', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ...selectionParams(), clusterId: cluster.cluster_id, clusterName: cluster.name, path: notebookPath ?? undefined })
			});
			const body = await res.json();
			if (!res.ok) throw body;
			switching = false;
			await loadStatus();
			onSessionChange?.();
			// Connecting ALWAYS enables the Databricks runtime and restarts the kernel
			// so the `IS_DATABRICKS`/`dbutils.widgets` path is live immediately - no
			// manual restart. `applyRuntime(true)` persists the ON preference then
			// restarts (which re-injects the env AND rebuilds spark/w). Kept inside the
			// connect spinner, and `settleConnection` waits for the rebuilt session so
			// the panel never flashes the "session lost" card.
			await applyRuntime(true);
			await settleConnection();
		} catch (err) {
			connectError = toDbxError(err);
		} finally {
			busy = '';
			connectingId = '';
			connectingName = '';
			restarting = false; // definitive cleanup if applyRuntime threw before settleConnection
		}
	}

	async function disconnect() {
		if (busy) return;
		busy = 'disconnect';
		connectError = null;
		reconnectNote = '';
		reconnectError = null;
		// The last "user moved on" action. It is also literally the remedy a
		// sessions-only incomplete sign-out advises, so leaving the warning up here
		// would have it still claiming the sign-out is unfinished right after the
		// user finished it.
		clearLogoutFeedback();
		try {
			const res = await fetch(`/api/databricks/connect${pathQuery()}`, { method: 'DELETE' });
			if (!res.ok) throw await res.json();
			resetBrowser();
			await loadStatus();
			onSessionChange?.();
		} catch (err) {
			connectError = toDbxError(err);
		} finally {
			busy = '';
		}
	}

	/**
	 * The advice line for an incomplete sign-out, built from WHICH part did not
	 * complete rather than one fixed remedy. A surviving cached token is a file the
	 * user can delete (and the server's reason already names the directory, so this
	 * never repeats the path); a notebook mid-connect is not - telling someone to
	 * remove a cache entry that was just deleted is the same "assert more than the
	 * server verified" mistake the honest-reporting rule exists to prevent. The two
	 * session failures differ the same way: a refused teardown resolves itself once
	 * the connect ends, a FAILED one leaves the notebook bound with nothing to wait
	 * for. When several apply, each is said.
	 */
	function incompleteWarning(out: DbxLogout): string {
		const advice: string[] = [];
		if (out.purgeFailed || out.purgeMissed) {
			advice.push('Your saved sign-in may still be usable - try again, or remove the cached sign-in yourself.');
		}
		if (out.sessionsBusy) {
			advice.push('Disconnect that notebook once its connect finishes.');
		}
		if (out.sessionsStuck) {
			// A teardown that FAILED, not one that was refused: the notebook keeps its
			// reconnect intent, so waiting for a connect to finish is not the remedy -
			// there is no connect, and a retry fails the same way until its kernel is back.
			advice.push('That notebook is still bound to its cluster - disconnect it once its kernel is reachable again, or its session may rebuild on the next kernel restart.');
		}
		if (!out.sessionsBusy && !out.sessionsStuck && out.sessionsFailed) {
			advice.push('Disconnect that notebook by hand.');
		}
		const reason = out.incompleteReason ?? 'part of it could not be verified';
		return [`Sign-out may be incomplete: ${reason}.`, ...advice].join(' ');
	}

	/**
	 * Sign out of Databricks - the deliberate sibling of `disconnect`, not a louder
	 * version of it. Disconnect ends the Spark session and leaves you
	 * authenticated; this ALSO drops Cellar's own cached sign-in, so the next
	 * connect has to authenticate again.
	 *
	 * It signs out EVERYWHERE: every sign-in this server recorded and every bound
	 * notebook, not just the current selection - otherwise another notebook's
	 * reconnect intent would silently rebuild `spark` after the user was told they
	 * signed out. The copy says so rather than leaving the blast radius implicit.
	 *
	 * The server decides what is Cellar's to clear: only the token Cellar's own
	 * browser sign-in minted. A PAT in `~/.databrickscfg`, an OS keyring entry, the
	 * databricks CLI's own token cache - those are the user's, and the note below
	 * says so rather than implying a purge that never happened. And a sign-out that
	 * did NOT provably complete reports as incomplete, never as a clean one: the
	 * cached token may have survived, in which case the next sign-in is a silent
	 * cache hit and the user needs to know.
	 */
	async function logoutDatabricks() {
		if (busy) return;
		busy = 'logout';
		clearLogoutFeedback();
		connectError = null;
		reconnectError = null;
		reconnectNote = '';
		try {
			const res = await fetch('/api/databricks/logout', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ...selectionParams(), path: notebookPath ?? undefined })
			});
			const body = await res.json();
			if (!res.ok) throw body;
			const out = body as DbxLogout;
			// Back to the signed-out state: forget the in-session sign-in flag and the
			// cluster list it unlocked, so the picker re-gates behind "Sign in".
			switching = false;
			resetSelection();
			resetBrowser();
			await loadStatus();
			onSessionChange?.();
			if (out.incomplete) {
				logoutWarning = incompleteWarning(out);
			} else {
				logoutNote = out.clearedTokens
					? "Signed out everywhere. Cellar's saved Databricks sign-ins were cleared and every notebook was disconnected - the next connect signs in again."
					: out.externalSkipped
						? "Signed out of Cellar everywhere, and every notebook was disconnected. This profile's credentials live in ~/.databrickscfg or the databricks CLI, so they were left untouched."
						: // No purge was verified here (the only target was this selection, which
							// Cellar holds no recorded sign-in for), so say what was actually done
							// rather than claiming a token deletion the server could not confirm.
							"Signed out everywhere - every notebook was disconnected and Cellar's saved sign-in state was cleared. There was no recorded Cellar sign-in to delete.";
			}
		} catch (err) {
			logoutError = toDbxError(err);
		} finally {
			busy = '';
			// Disarm on BOTH outcomes: a failed sign-out must be re-armed deliberately,
			// never left one stray click from firing again.
			confirmLogout = false;
		}
	}

	/**
	 * One-click recovery when the notebook is BOUND but its session is not live
	 * (`expired` / `lost`). Reuses the server's ONE reconnect ladder via
	 * `reconnectSession` (the SAME path auto-reconnect and the agent tool walk) - no
	 * new reconnect flow. On success it reloads status and, if a databricks-connect
	 * re-pin restarted the kernel, warns that the namespace was cleared.
	 */
	async function reconnect() {
		if (busy) return;
		busy = 'reconnect';
		reconnectError = null;
		reconnectNote = '';
		try {
			const res = await fetch('/api/databricks/reconnect', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ path: notebookPath ?? undefined })
			});
			const body = await res.json();
			if (!res.ok) throw body;
			// The kernel had to be restarted (a version re-pin), so every variable is gone.
			if (body.kernel_restarted) reconnectNote = 'Reconnected, but the kernel was restarted - your variables are gone. Re-run your cells.';
			await loadStatus();
			onSessionChange?.();
		} catch (err) {
			reconnectError = toDbxError(err);
		} finally {
			busy = '';
		}
	}

	// ---- Install -------------------------------------------------------------
	let version = $state('');
	let installError = $state<DbxError | null>(null);

	async function installDeps() {
		if (busy) return;
		busy = 'install';
		installError = null;
		try {
			const res = await fetch('/api/databricks/install', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ version: version.trim() || undefined })
			});
			const body = await res.json();
			if (!res.ok) throw body;
			await loadStatus();
		} catch (err) {
			installError = toDbxError(err);
		} finally {
			busy = '';
		}
	}

	const installCommand = $derived(
		`uv pip install databricks-sdk databricks-connect${version.trim() ? `==${version.trim()}.*` : ''}`
	);

	// ---- Unity Catalog browser (lazy: one level per expand) -------------------
	// `nodes[id]` is the loaded child list for an expanded node; `open[id]` is
	// whether it is expanded. Ids are `c:<catalog>` and `s:<catalog>.<schema>`.
	let catalogs = $state<DbxCatalogEntry[] | null>(null);
	let catalogsError = $state<DbxError | null>(null);
	let catalogsLoading = $state(false);
	let nodes = $state<Record<string, DbxNodeState>>({});
	let openNodes = $state<Record<string, boolean>>({});
	let catalogsFor: string | null = null;

	function resetBrowser() {
		catalogs = null;
		catalogsError = null;
		nodes = {};
		openNodes = {};
		catalogsFor = null;
	}

	$effect(() => {
		const key = connected ? `${connection.profile ?? connection.host}:${connection.clusterId}` : null;
		if (!key || catalogsFor === key) return;
		catalogsFor = key;
		loadCatalogs();
	});

	/** The `{profile}|{host}` the live connection used, for its Unity Catalog listings. */
	function connectionParams(): Record<string, string> {
		return connection.profile ? { profile: connection.profile } : { host: connection.host ?? '' };
	}

	async function loadCatalogs() {
		// Bumping the generation also invalidates every child fetch still in flight
		// against the OLD tree (see `toggleNode`).
		const seq = ++catalogsSeq;
		catalogsLoading = true;
		catalogsError = null;
		// A different profile or cluster is a different tree. Drop the expanded
		// children too, or a schema loaded from the previous workspace keeps showing
		// under a catalog that no longer contains it.
		nodes = {};
		openNodes = {};
		try {
			const body = await getLevel({ level: 'catalogs' });
			if (seq !== catalogsSeq) return;
			catalogs = body.catalogs;
		} catch (err) {
			if (seq !== catalogsSeq) return;
			catalogs = null;
			catalogsError = toDbxError(err);
		} finally {
			if (seq === catalogsSeq) catalogsLoading = false;
		}
	}

	async function getLevel(params: Record<string, string>) {
		const q = new URLSearchParams({ ...connectionParams(), ...params });
		const res = await fetch(`/api/databricks/catalog?${q}`);
		const body = await res.json();
		if (!res.ok) throw { code: body?.code ?? 'error', message: body?.message ?? 'request failed' } as DbxError;
		return body;
	}

	/** Expand/collapse a node, fetching its children the first time it opens. */
	async function toggleNode(id: string, fetcher: () => Promise<DbxCatalogEntry[]>) {
		if (openNodes[id]) {
			openNodes[id] = false;
			return;
		}
		openNodes[id] = true;
		// Loaded children are cached; a node whose load FAILED retries on reopen, so a
		// transient error is not permanent until the whole tree is rebuilt.
		if (nodes[id] && !nodes[id].error) return;
		// Children belong to the tree that was current when the fetch started. If the
		// connection changed meanwhile, `loadCatalogs` cleared `nodes` - writing this
		// late response would resurrect a node from the previous workspace.
		const gen = catalogsSeq;
		nodes[id] = { loading: true, error: null, items: null };
		try {
			const items = await fetcher();
			if (gen !== catalogsSeq) return;
			nodes[id] = { loading: false, error: null, items };
		} catch (err) {
			if (gen !== catalogsSeq) return;
			nodes[id] = { loading: false, error: toDbxError(err), items: null };
		}
	}

	const toggleCatalog = (name: string) =>
		toggleNode(`c:${name}`, async () => (await getLevel({ level: 'schemas', catalog: name })).schemas);
	const toggleSchema = (catalog: string, schema: string) =>
		toggleNode(`s:${catalog}.${schema}`, async () => (await getLevel({ level: 'tables', catalog, schema })).tables);

	/**
	 * The reproducible form of a preview: the cell the user keeps.
	 *
	 * `fullName` is workspace data, not our data, and Unity Catalog permits quotes
	 * and backslashes in a quoted identifier - so it is embedded as a python string
	 * *literal* rather than pasted between two quote characters. `JSON.stringify`
	 * emits `"…"` whose escapes are all valid python, the same trick `pyLiteral`
	 * uses server-side. For an ordinary name the output is byte-identical to naive
	 * interpolation; for a hostile one it stays inside the string.
	 */
	const previewCode = (fullName: string) => `spark.read.table(${JSON.stringify(fullName)}).limit(${limit}).toPandas()`;

	function previewTable(fullName: string | undefined) {
		if (!fullName) return;
		onInsertAndRun?.(previewCode(fullName));
	}

	// ---- Presentation --------------------------------------------------------
	/** RUNNING is the only state you can attach to right away; PENDING will get there. */
	function clusterDotClass(state: string | undefined) {
		if (state === 'RUNNING') return 'bg-success';
		if (state === 'PENDING' || state === 'RESTARTING' || state === 'RESIZING') return 'bg-warning';
		if (state === 'ERROR') return 'bg-error';
		return 'bg-base-content/30';
	}
	/** A cluster still spinning up gets a ping halo (like a busy kernel row). */
	function clusterPending(state: string | undefined) {
		return state === 'PENDING' || state === 'RESTARTING' || state === 'RESIZING';
	}

	// A single muted "profile · host · spark" line replacing the connected card's
	// former <dl> grid - shorter and calmer, still complete.
	const connMeta = $derived(
		[
			connection.profile,
			connection.host ? connection.host.replace(/^https?:\/\//, '') : null,
			connection.sparkVersion
		]
			.filter(Boolean)
			.join(' · ')
	);

	/** What the user should DO about a failure. The server's own message follows it. */
	const REMEDY: Record<string, string> = {
		not_connected: 'Connect to a cluster first.',
		sdk_missing: 'Install databricks-sdk into this workspace’s Python environment.',
		connect_missing: 'Install databricks-connect into this workspace’s Python environment.',
		profile_missing: 'That profile is not in your ~/.databrickscfg. Pick another, or add it.',
		oauth_login_required: 'Sign in to Databricks first - click “Sign in with Databricks” to authenticate in your browser.',
		login_failed: 'Sign-in did not complete. Click “Sign in with Databricks” to try again.',
		auth_failed: 'Databricks rejected these credentials. For a token profile, refresh the token; for OAuth, sign in again.',
		permission_denied: 'Your account cannot see this. Ask a workspace admin for access.',
		not_found: 'Not found in this workspace.',
		timeout: 'The workspace did not respond. Check the host in this profile, and your VPN.',
		no_python: 'Bind a Python environment in Settings → Python environment.',
		no_uv: 'Cellar installs packages with uv. Install uv, or install the packages yourself.',
		session_failed: 'The cluster refused the Spark session. Check that databricks-connect matches the cluster’s runtime version, and that the cluster allows Databricks Connect.',
		version_mismatch: 'databricks-connect is newer than the cluster’s runtime. Cellar re-pins a matching client automatically on your next connect - just click the cluster again.',
		read_failed: 'Spark could not read that table.',
		kernel_unavailable: 'Cellar could not reach the Python kernel. Restart Cellar, then connect again.',
		busy: 'Another Databricks operation is still running.'
	};

	/**
	 * The profile a `profile_reauth_required` failure is about. The server names it
	 * (it resolved the auth that failed); the current picker selection is only the
	 * fallback for an older body, so the command is never hardcoded.
	 */
	function reauthProfile(err: DbxError): string {
		return err.profile || profile;
	}

	// Copy-the-command affordance for the re-auth box - the same idiom as the
	// sidebar's "Connect an agent" panel. Keyed by the box's own `key`, NOT its
	// testid: a testid is a SELECTOR, not an identity - `databricks-node-error` is
	// rendered once per catalog-tree node, and one expired profile fails every one
	// of them at once, so keying the tick off it flipped the checkmark in every
	// sibling box. Each rendered box therefore passes a key unique to it.
	let copiedReauth = $state('');
	let copyReauthTimer: ReturnType<typeof setTimeout>;
	async function copyReauth(key: string, text: string) {
		try {
			await navigator.clipboard.writeText(text);
			copiedReauth = key;
			clearTimeout(copyReauthTimer);
			copyReauthTimer = setTimeout(() => (copiedReauth = ''), 1400);
		} catch {
			/* a denied clipboard permission must not break the error box */
		}
	}
</script>

<!--
  The one auth failure Cellar cannot fix for the user: a NAMED profile whose
  CLI-managed sign-in expired. "Sign in with Databricks" runs Cellar's OWN browser
  OAuth, which mints a token this profile never reads - a dead end - so this box
  shows the exact command instead, with the real profile name. See
  $lib/databricksReauth for why Cellar does not run it for them.
-->
{#snippet reauthBox(err: DbxError, testid: string, key: string)}
	{@const name = reauthProfile(err)}
	{@const command = reauthCommand(name)}
	<p class="text-[11px] font-medium leading-relaxed text-base-content/80" data-testid="{testid}-explain">
		{reauthExplanation(name)}
	</p>
	<!-- The command WRAPS rather than truncating: in a ~200px box the tail is the
	     profile name, i.e. the one part of it the user must read. The flag is held
	     in a no-wrap span because a browser breaks after a hyphen, which split
	     `--profile` into `-` / `-profile` - a command a reader could mistype. -->
	<div class="mt-1.5 flex items-start gap-1 rounded-md border border-base-300 bg-base-100 p-1">
		<code class="min-w-0 flex-1 px-1 py-0.5 font-mono text-[11px] leading-snug text-primary [overflow-wrap:break-word]" title={command} data-testid="{testid}-command">{REAUTH_COMMAND_HEAD} <span class="whitespace-nowrap">{REAUTH_PROFILE_FLAG}</span> {name}</code>
		<button
			class="btn btn-ghost btn-xs btn-square shrink-0 text-base-content/50 hover:text-base-content"
			onclick={() => copyReauth(key, command)}
			title="Copy command"
			aria-label="Copy command"
			data-testid="{testid}-copy"
		>
			{#if copiedReauth === key}
				<svg class="h-3.5 w-3.5 text-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
			{:else}
				<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
			{/if}
		</button>
	</div>
{/snippet}

<!--
  `testid` is the SELECTOR (deliberately repeated across the catalog tree's node
  boxes, which tests address as one); `key` is the box's IDENTITY, used only for
  per-box UI state like the copy tick. They coincide everywhere a box is rendered
  once, so `key` defaults to the testid; a box inside an `{#each}` must pass its
  own.
-->
{#snippet errorBox(err: DbxError, testid: string, key: string = testid)}
	<div class="mt-2 rounded-lg border border-error/30 bg-error/10 p-2" data-testid={testid}>
		{#if err.code === PROFILE_REAUTH_CODE}
			{@render reauthBox(err, `${testid}-reauth`, key)}
			<!-- The SDK's own text only; the head of the server message is what the
			     box above already says in full, so repeating it would state the same
			     remedy three times. -->
			{@const detail = reauthDetail(err.message)}
			{#if detail}
				<p class="mt-1.5 break-words font-mono text-[10px] leading-relaxed text-base-content/50">{detail}</p>
			{/if}
		{:else}
			{#if REMEDY[err.code]}
				<p class="text-[11px] font-medium leading-relaxed text-base-content/80">{REMEDY[err.code]}</p>
			{/if}
			<p class="mt-0.5 break-words font-mono text-[10px] leading-relaxed text-base-content/50">{err.message}</p>
		{/if}
	</div>
{/snippet}

{#snippet hint(text: string)}
	<p class="mt-1.5 text-[11px] leading-relaxed text-base-content/40">{text}</p>
{/snippet}

<!-- One-click recovery for the bound-but-not-live states (expired / lost). Wired to
     `reconnectSession` via /api/databricks/reconnect - the SAME ladder auto-reconnect
     walks; the cluster picker below stays as the manual "pick another cluster" fallback. -->
{#snippet reconnectButton()}
	<button
		class="btn btn-primary btn-xs mt-2 w-full gap-1"
		onclick={reconnect}
		disabled={!!busy}
		data-testid="databricks-reconnect"
	>
		{#if busy === 'reconnect'}
			<span class="loading loading-spinner loading-xs"></span>Reconnecting…
		{:else}
			<svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /></svg>Reconnect
		{/if}
	</button>
	{#if reconnectNote}
		<p class="mt-1.5 text-[11px] leading-relaxed text-base-content/60" data-testid="databricks-reconnect-note">{reconnectNote}</p>
	{/if}
	{#if reconnectError}{@render errorBox(reconnectError, 'databricks-reconnect-error')}{/if}
{/snippet}

<!-- Sign out of Databricks. Deliberately QUIETER than Disconnect: Disconnect is the
     everyday outlined action that ends the session, this is the rarer one that also
     drops the saved sign-in. Shown whenever there is a sign-in to clear, and always
     while connected (where it ends the session too). It is also the panel's most
     destructive control and sits right below Disconnect, so it takes a two-step
     inline confirm whose copy names the blast radius: this signs out EVERYWHERE and
     disconnects every notebook, not just the selection this panel is showing. Both
     the visibility gate and the confirm/tooltip copy therefore key off
     `cellarSignedInAnywhere`, NOT the per-selection `cellarSignedIn` - matching the
     scope of what the action does, so the button can never hide the one control that
     would purge a sign-in recorded for a different selection, nor promise a purge
     that will not happen - see `logoutConfirmCopy`. -->
{#snippet logoutRow(always: boolean)}
	{#if always || cellarSignedInAnywhere}
		{#if confirmLogout}
			<div
				class="mt-1.5 rounded border border-warning/40 bg-warning/10 px-2 py-1.5"
				data-testid="databricks-logout-confirm-box"
			>
				<p class="text-[11px] leading-relaxed text-base-content/80">{logoutConfirmCopy}</p>
				<div class="mt-1.5 flex justify-end gap-1">
					<button
						class="btn btn-ghost btn-xs h-5 min-h-0 px-1.5 text-[11px] font-normal text-base-content/60"
						onclick={() => (confirmLogout = false)}
						data-testid="databricks-logout-cancel"
					>
						Cancel
					</button>
					<button
						class="btn btn-warning btn-xs h-5 min-h-0 px-1.5 text-[11px]"
						onclick={logoutDatabricks}
						disabled={!!busy || runtimeApplying}
						data-testid="databricks-logout-confirm"
					>
						{#if busy === 'logout'}<span class="loading loading-spinner loading-xs"></span>Signing out…{:else}Sign out everywhere{/if}
					</button>
				</div>
			</div>
		{:else}
			<div class="mt-1.5 flex justify-end">
				<button
					class="btn btn-ghost btn-xs h-5 min-h-0 px-1 text-[11px] font-normal text-base-content/50 hover:text-error"
					onclick={() => (confirmLogout = true)}
					disabled={!!busy || runtimeApplying}
					title={logoutButtonTitle}
					data-testid="databricks-logout"
				>
					Log out
				</button>
			</div>
		{/if}
	{/if}
	<!-- The outcome is NOT gated on the button still being shown: a successful log out
	     is exactly what makes `cellarSignedInAnywhere` false, and the confirmation has to
	     survive that (and the card swap it triggers). -->
	{#if logoutNote}
		<!-- One notch stronger than the surrounding hint copy (/50): this is feedback
		     on an action just taken, and it lands in a card full of static hints. -->
		<p class="mt-1.5 text-[11px] leading-relaxed text-base-content/70" data-testid="databricks-logout-note">{logoutNote}</p>
	{/if}
	{#if logoutWarning}
		<!-- A sign-out that did not provably finish. Warning-toned, NEVER the ordinary
		     confirmation: the cached token may still be on disk, which would make the
		     next sign-in a silent cache hit for a user who believes they signed out. -->
		<p
			class="mt-1.5 rounded border border-warning/40 bg-warning/10 px-2 py-1.5 text-[11px] leading-relaxed text-base-content/80"
			data-testid="databricks-logout-warning"
		>
			{logoutWarning}
		</p>
	{/if}
	{#if logoutError}{@render errorBox(logoutError, 'databricks-logout-error')}{/if}
{/snippet}

{#snippet cardLabel(text: string)}
	<span class="text-[10px] font-semibold uppercase tracking-wide text-base-content/40">{text}</span>
{/snippet}

<!-- The connect form: pick an auth source (a saved profile, or a typed workspace
     host), sign in if needed, then pick a cluster. Reused by the disconnected
     Cluster card, the "Switch cluster" sub-panel, and the expired/lost cards. -->
{#snippet picker()}
	<!-- Auth source: a config profile, or a workspace host typed by hand. -->
	{#if selectionMode === 'profile'}
		{#if profiles.length > 1}
			<label class="block">
				<span class="text-[10px] uppercase tracking-wide text-base-content/40">profile</span>
				<select
					class="select select-xs select-bordered mt-0.5 w-full font-mono text-[11px]"
					value={profile}
					onchange={(e) => pickProfile(e.currentTarget.value)}
					disabled={!!busy}
					data-testid="databricks-profile"
				>
					{#each profiles as p (p.name)}
						<option value={p.name}>{p.name}{p.hasToken ? '' : ' (OAuth)'}</option>
					{/each}
				</select>
			</label>
		{:else}
			<p class="text-[11px] text-base-content/40">
				profile <span class="font-mono text-base-content/60" data-testid="databricks-profile">{profile}</span>
			</p>
		{/if}
		{#if hasProfiles}
			<button class="mt-1 text-[10px] text-primary/70 hover:text-primary hover:underline" onclick={toggleUseHost} disabled={!!busy} data-testid="databricks-use-host">
				or connect to a workspace host…
			</button>
		{/if}
	{:else}
		<label class="block">
			<span class="text-[10px] uppercase tracking-wide text-base-content/40">workspace host</span>
			<input
				type="text"
				class="input input-xs input-bordered mt-0.5 w-full font-mono text-[11px]"
				placeholder="https://dbc-….cloud.databricks.com"
				bind:value={hostInput}
				oninput={() => resetSelection()}
				disabled={!!busy}
				data-testid="databricks-host"
			/>
		</label>
		{#if hasProfiles}
			<button class="mt-1 text-[10px] text-primary/70 hover:text-primary hover:underline" onclick={toggleUseHost} disabled={!!busy} data-testid="databricks-use-profile">
				use a saved profile instead
			</button>
		{:else}
			{@render hint('No profile in ~/.databrickscfg. Enter your workspace URL and sign in - Cellar authenticates you through your browser, no token needed.')}
		{/if}
	{/if}

	<!-- A bare host signs in first; a profile lists straight away and only shows this if the SDK asks for a login. -->
	{#if needsAuth}
		<button
			class="btn btn-primary btn-xs mt-2 w-full gap-1"
			onclick={signIn}
			disabled={!!busy || !haveSelection}
			data-testid="databricks-signin"
		>
			{#if busy === 'login'}<span class="loading loading-spinner loading-xs"></span>Opening browser…{:else}Sign in with Databricks{/if}
		</button>
		{@render hint('Opens your browser to authenticate with Databricks (OAuth). No access token required. The sign-in is cached locally by the Databricks SDK - use Log out to clear it.')}
		{#if authError}{@render errorBox(authError, 'databricks-auth-error')}{/if}
	{:else if haveSelection}
		<div class="mt-2 flex items-center justify-between">
			<span class="text-[10px] uppercase tracking-wide text-base-content/40">clusters</span>
			<button class="btn btn-ghost btn-xs h-5 min-h-0 px-1 text-[11px] font-normal text-base-content/50 hover:text-base-content" onclick={refreshClusters} disabled={clustersLoading} data-testid="databricks-refresh-clusters">
				{clustersLoading ? 'loading…' : 'refresh'}
			</button>
		</div>

		{#if clustersError}
			{@render errorBox(clustersError, 'databricks-clusters-error')}
		{:else if clustersLoading && !clusters}
			<p class="px-2 py-2 text-xs text-base-content/40">loading clusters…</p>
		{:else if clusters?.length}
			<div class="max-h-56 space-y-0.5 overflow-y-auto">
				{#each clusters as c (c.cluster_id)}
					<button
						class="group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-base-300/40 disabled:opacity-50"
						onclick={() => connect(c)}
						disabled={!!busy}
						title="Connect 'spark' to {c.name}"
						data-testid="databricks-cluster"
					>
						<span class="relative flex h-2 w-2 shrink-0" title={c.state.toLowerCase()}>
							{#if clusterPending(c.state)}<span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-warning opacity-60"></span>{/if}
							<span class="relative inline-flex h-2 w-2 rounded-full {clusterDotClass(c.state)}"></span>
						</span>
						<span class="min-w-0 flex-1">
							<span class="block truncate text-xs text-base-content/80">{c.name}</span>
							{#if c.spark_version}<span class="block truncate font-mono text-[10px] text-base-content/40">{c.spark_version}</span>{/if}
						</span>
						{#if connectingId === c.cluster_id}
							<span class="loading loading-spinner loading-xs shrink-0 text-primary"></span>
						{:else}
							<span class="shrink-0 text-[10px] uppercase tracking-wide text-base-content/40">{c.state.toLowerCase()}</span>
						{/if}
					</button>
				{/each}
			</div>
			<!-- Behavior consequence: connecting enables the Databricks runtime and
			     restarts the kernel to make it live immediately (variables cleared). -->
			<p class="mt-1.5 flex items-start gap-1 text-[11px] leading-relaxed text-base-content/40" data-testid="databricks-connect-note">
				<svg class="mt-px h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" /></svg>
				<span>Connecting enables the Databricks runtime and restarts the kernel - variables are cleared.</span>
			</p>
		{:else if clusters}
			<p class="px-2 py-2 text-xs text-base-content/40">no clusters in this workspace</p>
		{/if}
	{/if}

	{#if connectError}{@render errorBox(connectError, 'databricks-connect-error')}{/if}
{/snippet}

<!-- The Runtime card: advertise DATABRICKS_RUNTIME_VERSION so this notebook's
     IS_DATABRICKS-gated code takes its dbutils.widgets path. A separate card from
     the connection, applied LIVE - toggling (or a version edit) restarts the kernel
     to take effect immediately. Green (toggle-success) is a deliberate Databricks
     cue, unlike Files' primary toggle. -->
{#snippet runtimeCard()}
	<div class="rounded-lg border border-base-300 bg-base-100 p-2.5" data-testid="databricks-runtime-card">
		<div class="flex items-center justify-between gap-2">
			{@render cardLabel('runtime')}
			{#if runtimeApplying}
				<span class="flex items-center gap-1 text-[10px] text-base-content/40" data-testid="databricks-runtime-applying">
					<span class="loading loading-spinner loading-xs"></span>restarting…
				</span>
			{:else if runtimeOn}
				<span class="flex items-center gap-1 text-[10px] uppercase tracking-wide text-success" data-testid="databricks-runtime-active">
					<span class="inline-block h-1.5 w-1.5 rounded-full bg-success"></span>active
				</span>
			{:else}
				<span class="text-[10px] uppercase tracking-wide text-base-content/30" data-testid="databricks-runtime-inactive">off</span>
			{/if}
		</div>
		<label
			class="mt-1.5 flex cursor-pointer items-center gap-2 text-[11px] text-base-content/70"
			title="Advertises a Databricks runtime (sets DATABRICKS_RUNTIME_VERSION) so notebook code that gates on IS_DATABRICKS takes its dbutils.widgets path. Affects all libraries (e.g. mlflow) and restarts the kernel to apply. It does not connect a cluster - use Databricks Connect for spark/Unity Catalog."
		>
			<input
				type="checkbox"
				class="toggle toggle-xs toggle-success"
				checked={runtimeOn}
				onchange={toggleRuntime}
				disabled={runtimeApplying || !!busy}
				data-testid="databricks-runtime-toggle"
			/>
			<span>Databricks runtime (<code class="font-mono text-[10px]">dbutils.widgets</code>)</span>
		</label>
		{#if runtimeOn}
			<label class="mt-1.5 flex items-center gap-2 text-[11px] text-base-content/50">
				<span class="shrink-0">version</span>
				<input
					type="text"
					class="input input-xs input-bordered h-5 min-h-0 w-20 py-0 font-mono text-[10px]"
					value={runtimeVersion}
					oninput={onVersionInput}
					onchange={commitVersion}
					onkeydown={(e) => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur(); }}
					placeholder={DBX_RUNTIME_VERSION_DEFAULT}
					disabled={runtimeApplying}
					data-testid="databricks-runtime-version"
				/>
			</label>
		{/if}
		<p class="mt-1.5 text-[11px] leading-relaxed text-base-content/40">
			{#if runtimeOn}
				<code class="font-mono text-[10px]">IS_DATABRICKS</code>-gated code takes the Databricks path. Toggling restarts the kernel - variables are cleared.
			{:else}
				Notebook code runs its non-Databricks path. Turning it on restarts the kernel - variables are cleared.
			{/if}
		</p>
	</div>
{/snippet}

<!-- Unity Catalog browser: catalog > schema > table, one level per expand.
     Subordinate to the two cards above (a labeled region, not a card of its own). -->
{#snippet dataBrowser()}
	<div class="pt-1" data-testid="databricks-browser">
		<div class="flex items-center justify-between gap-2">
			<span class="text-[10px] uppercase tracking-wide text-base-content/40">data</span>
			<label class="flex items-center gap-1 text-[10px] text-base-content/40">
				preview
				<!-- `pe-7` clears daisyUI's chevron: at `pe-5` a 3-digit limit renders underneath it. -->
				<select class="select select-xs select-bordered h-5 min-h-0 py-0 pe-7 ps-1.5 font-mono text-[10px]" bind:value={limit} data-testid="databricks-limit">
					{#each LIMITS as n (n)}<option value={n}>{n}</option>{/each}
				</select>
				rows
			</label>
		</div>

		{#if catalogsError}
			{@render errorBox(catalogsError, 'databricks-catalogs-error')}
		{:else if catalogsLoading}
			<p class="px-2 py-2 text-xs text-base-content/40">loading catalogs…</p>
		{:else if catalogs?.length}
			<div class="max-h-72 overflow-y-auto pt-1">
				{#each catalogs as cat (cat.name)}
					{@const cid = `c:${cat.name}`}
					<button class="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-xs hover:bg-base-300/50" onclick={() => toggleCatalog(cat.name)} data-testid="databricks-catalog">
						<svg class="h-3 w-3 shrink-0 text-base-content/40 transition-transform {openNodes[cid] ? 'rotate-90' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
						<span class="truncate text-base-content/80">{cat.name}</span>
					</button>

					{#if openNodes[cid]}
						{@const node = nodes[cid]}
						<div class="ml-3">
							{#if node?.loading}
								<p class="px-2 py-0.5 text-[11px] text-base-content/40">loading…</p>
							{:else if node?.error}
								{@render errorBox(node.error, 'databricks-node-error', cid)}
							{:else if node?.items?.length}
								{#each node.items as sch (sch.name)}
									{@const sid = `s:${cat.name}.${sch.name}`}
									<button class="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-xs hover:bg-base-300/50" onclick={() => toggleSchema(cat.name, sch.name)} data-testid="databricks-schema">
										<svg class="h-3 w-3 shrink-0 text-base-content/40 transition-transform {openNodes[sid] ? 'rotate-90' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
										<span class="truncate text-base-content/70">{sch.name}</span>
									</button>

									{#if openNodes[sid]}
										{@const tnode = nodes[sid]}
										<div class="ml-3">
											{#if tnode?.loading}
												<p class="px-2 py-0.5 text-[11px] text-base-content/40">loading…</p>
											{:else if tnode?.error}
												{@render errorBox(tnode.error, 'databricks-node-error', sid)}
											{:else if tnode?.items?.length}
												{#each tnode.items as tbl (tbl.name)}
													<button
														class="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs hover:bg-base-300/50 disabled:cursor-not-allowed disabled:opacity-40"
														onclick={() => previewTable(tbl.full_name)}
														disabled={!onInsertAndRun}
														title={onInsertAndRun ? `Preview ${limit} rows of ${tbl.full_name}` : 'Open a notebook to preview a table'}
														data-testid="databricks-table"
													>
														<svg class="h-3 w-3 shrink-0 text-base-content/30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M3 15h18M9 3v18" /></svg>
														<span class="truncate text-base-content/70">{tbl.name}</span>
													</button>
												{/each}
											{:else}
												<p class="px-2 py-0.5 text-[11px] text-base-content/40">no tables</p>
											{/if}
										</div>
									{/if}
								{/each}
							{:else}
								<p class="px-2 py-0.5 text-[11px] text-base-content/40">no schemas</p>
							{/if}
						</div>
					{/if}
				{/each}
			</div>
			{#if !onInsertAndRun}
				{@render hint('Open a notebook to preview a table.')}
			{/if}
		{:else if catalogs}
			<p class="px-2 py-2 text-xs text-base-content/40">no catalogs visible to this profile</p>
		{/if}
	</div>
{/snippet}

<div class="px-2 pb-3" data-testid="databricks-body">
	{#if statusError}
		{@render errorBox({ code: 'error', message: statusError }, 'databricks-status-error')}

		<!-- 1. Loading, then: the kernel's venv cannot import the SDK. A profile is
		     NOT required to get past here - a host can be typed in step 3. -->
	{:else if !status}
		<p class="px-1 text-xs text-base-content/40">loading…</p>
	{:else if !installed}
		<div class="rounded-lg border border-dashed border-base-300 bg-base-100 p-2.5" data-testid="databricks-not-installed">
			<div class="text-sm font-medium text-base-content/50">Packages missing</div>
			{@render hint(
				install.python
					? `This workspace’s Python environment has neither databricks-sdk nor databricks-connect.`
					: 'No Python environment is bound to this workspace.'
			)}
			{#if install.python}
				<label class="mt-2 block">
					<span class="text-[10px] uppercase tracking-wide text-base-content/40">runtime version (optional)</span>
					<input
						type="text"
						class="input input-xs input-bordered mt-0.5 w-full font-mono text-[11px]"
						placeholder="16.1"
						bind:value={version}
						data-testid="databricks-version"
					/>
				</label>
				{@render hint('databricks-connect must match your cluster’s Databricks Runtime. Leave blank for the latest.')}
				<button
					class="btn btn-primary btn-xs mt-2 w-full gap-1"
					onclick={installDeps}
					disabled={!!busy || !status.uv}
					data-testid="databricks-install"
				>
					{#if busy === 'install'}<span class="loading loading-spinner loading-xs"></span>Installing…{:else}Install with uv{/if}
				</button>
				<p class="mt-1.5 text-[10px] uppercase tracking-wide text-base-content/40">or run it yourself</p>
				<pre class="mt-0.5 whitespace-pre-wrap break-all rounded border border-base-300 p-2 font-mono text-[10px] text-base-content/60">{installCommand}</pre>
			{:else}
				{@render hint('Launch Cellar with `cellar`, or pick one in Settings → Python environment.')}
			{/if}
			{#if installError}{@render errorBox(installError, 'databricks-install-error')}{/if}
		</div>

		<!-- 3. Ready: the connection (Cluster card) + a separate Runtime card + the
		     subordinate Unity Catalog browser. Two clearly separated cards. -->
	{:else}
		<div class="space-y-2">
			{#if busy === 'connect' || (restarting && !runtimeApplying)}
				<!-- Connecting: one calm state in the Cluster card, held until the rebuilt
				     session settles - so the panel never flashes the "session lost" card.
				     Shown for a connect/switch (`busy === 'connect'`) AND for any other
				     expected restart still in flight (`restarting`, e.g. the gate outliving
				     `busy` for a tick), EXCEPT a runtime toggle - that keeps the connected
				     card with its "restarting" pill (the next branch). Because `restarting`
				     is true for the whole expected-restart window, the lost/expired branches
				     below are unreachable during it: an expected restart can never be
				     mistaken for an unexpected loss. -->
				<div class="rounded-lg border border-base-300 bg-base-100 p-2.5" data-testid="databricks-connecting">
					{@render cardLabel('cluster')}
					<div class="mt-1.5 flex items-center gap-2">
						<span class="loading loading-spinner loading-xs shrink-0 text-primary"></span>
						<span class="min-w-0 flex-1 truncate text-sm font-medium" title={connectingName}>
							{connectingName ? `Connecting to ${connectingName}…` : 'Reconnecting…'}
						</span>
					</div>
					{@render hint('Enabling the Databricks runtime and starting the session. A terminated cluster can take a few minutes.')}
					{#if connectError}{@render errorBox(connectError, 'databricks-connect-error')}{/if}
				</div>
			{:else if connected || runtimeApplying}
				<!-- Cluster card. Kept mounted through a runtime-toggle restart
				     (runtimeApplying) so the two-card view never flickers to "lost". -->
				<div class="rounded-lg border border-base-300 bg-base-100 p-2.5" data-testid="databricks-connected">
					<div class="flex items-center justify-between gap-2">
						{@render cardLabel('cluster')}
						{#if runtimeApplying}
							<span class="flex items-center gap-1 text-[10px] uppercase tracking-wide text-base-content/40">
								<span class="loading loading-spinner loading-xs"></span>restarting
							</span>
						{:else}
							<span class="badge badge-success badge-xs shrink-0 gap-1" data-testid="databricks-connection-status">
								<span class="inline-block h-1.5 w-1.5 rounded-full bg-current"></span>connected
							</span>
						{/if}
					</div>
					<div class="mt-1.5 flex items-center gap-2">
						<span class="relative flex h-2 w-2 shrink-0" title="connected"><span class="inline-flex h-2 w-2 rounded-full bg-success"></span></span>
						<span class="min-w-0 flex-1 truncate text-sm font-medium" title={connection.clusterName ?? connection.lost?.clusterName ?? ''}>{connection.clusterName ?? connection.lost?.clusterName ?? ''}</span>
					</div>
					{#if connMeta}
						<p class="mt-1 truncate font-mono text-[11px] text-base-content/50" title={connMeta}>{connMeta}</p>
					{/if}
					<p class="mt-1.5 text-[11px] leading-relaxed text-base-content/50">
						<code class="font-mono text-[10px] text-primary">spark</code> and
						<code class="font-mono text-[10px] text-primary">w</code> are ready in the kernel.
					</p>
					{#if reconnectNote}
						<p class="mt-1.5 text-[11px] leading-relaxed text-base-content/60" data-testid="databricks-reconnect-note">{reconnectNote}</p>
					{/if}
					{#if connection.livenessUnverified}
						<p class="mt-1 text-[11px] leading-relaxed text-base-content/40" data-testid="databricks-unverified">
							Liveness not confirmed (kernel busy or a transient error) - not a dead session.
						</p>
					{/if}
					<div class="mt-2 flex gap-1.5">
						<button class="btn btn-outline btn-xs flex-1" onclick={() => { switching = !switching; reconnectNote = ''; }} disabled={!!busy || runtimeApplying} data-testid="databricks-switch">
							{switching ? 'Cancel' : 'Switch cluster'}
						</button>
						<button class="btn btn-outline btn-xs flex-1" onclick={disconnect} disabled={!!busy || runtimeApplying} data-testid="databricks-disconnect">
							{#if busy === 'disconnect'}<span class="loading loading-spinner loading-xs"></span>{:else}Disconnect{/if}
						</button>
					</div>
					{@render logoutRow(true)}
					{#if switching}
						<div class="mt-2 border-t border-base-300 pt-2">
							{@render picker()}
						</div>
					{/if}
				</div>

				<!-- Runtime card: a SEPARATE card from the connection (requirement #1). -->
				{@render runtimeCard()}

				<!-- Data browser: subordinate to the two cards above. -->
				{@render dataBrowser()}
			{:else if connection.expired}
				<div class="rounded-lg border border-warning/30 bg-warning/10 p-2.5" data-testid="databricks-expired">
					<div class="flex items-center justify-between gap-2">
						{@render cardLabel('cluster')}
						<span class="flex items-center gap-1 text-[10px] uppercase tracking-wide text-warning">
							<span class="inline-block h-1.5 w-1.5 rounded-full bg-warning"></span>expired
						</span>
					</div>
					<p class="mt-1.5 text-[11px] leading-relaxed text-base-content/70">
						The Spark Connect session on <span class="font-mono">{connection.lost?.clusterName}</span> expired (idle timeout or a closed client). Cellar is reconnecting automatically; if it doesn't recover, use Reconnect.
					</p>
					{@render reconnectButton()}
					<div class="mt-2 border-t border-warning/20 pt-2">
						{@render picker()}
						{@render logoutRow(false)}
					</div>
				</div>
			{:else if connection.lost}
				<div class="rounded-lg border border-warning/30 bg-warning/10 p-2.5" data-testid="databricks-lost">
					<div class="flex items-center justify-between gap-2">
						{@render cardLabel('cluster')}
						<span class="flex items-center gap-1 text-[10px] uppercase tracking-wide text-warning">
							<span class="inline-block h-1.5 w-1.5 rounded-full bg-warning"></span>lost
						</span>
					</div>
					<p class="mt-1.5 text-[11px] leading-relaxed text-base-content/70">
						The session on <span class="font-mono">{connection.lost.clusterName}</span> ended when the kernel restarted. Reconnect to restore <code class="font-mono text-[10px]">spark</code> and <code class="font-mono text-[10px]">w</code>.
					</p>
					{@render reconnectButton()}
					<div class="mt-2 border-t border-warning/20 pt-2">
						{@render picker()}
						{@render logoutRow(false)}
					</div>
				</div>
			{:else}
				<!-- Disconnected: the Cluster card in its connect-form. -->
				<div class="rounded-lg border border-base-300 bg-base-100 p-2.5" data-testid="databricks-picker">
					{@render cardLabel('cluster')}
					<div class="mt-1.5">
						{@render picker()}
						{@render logoutRow(false)}
					</div>
				</div>
			{/if}
		</div>
	{/if}
</div>
