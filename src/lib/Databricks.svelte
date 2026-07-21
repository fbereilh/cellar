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
	import { getUi, setUi } from '$lib/uiState';
	import type { SessionId } from '$lib/server/types';

	// ---- Response shapes from src/routes/api/databricks/* --------------------
	// The routes are still .js and the server module doesn't export these, so the
	// shapes are declared locally and `res.json()` is narrowed into them at each
	// fetch boundary.
	/** The `{code, message}` error every failing Databricks route returns. */
	interface DbxError {
		code: string;
		message: string;
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
		/** Called after a successful connect/disconnect so the shell refreshes its kernel + variables. */
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

	// ---- Databricks-runtime toggle (advertise DATABRICKS_RUNTIME_VERSION) -----
	// Sets DATABRICKS_RUNTIME_VERSION in the kernel at start so a notebook's
	// import-time `IS_DATABRICKS` gate takes its `dbutils.widgets` path. Persisted
	// per workspace (server keys mirrored from `$lib/server/databricksRuntime.ts` -
	// a client component can't import a `$lib/server` module). Applies at kernel
	// START only (the gate is import-time), so toggling shows a "restart to apply"
	// hint rather than acting live. Default ON - scoped server-side to a CONNECTED
	// notebook, so a purely-local kernel is never told it is on Databricks.
	const DBX_RUNTIME_KEY = 'cellar-databricks-runtime';
	const DBX_RUNTIME_VERSION_KEY = 'cellar-databricks-runtime-version';
	const DBX_RUNTIME_VERSION_DEFAULT = '15.4';
	let runtimeOn = $state(true);
	let runtimeVersion = $state(DBX_RUNTIME_VERSION_DEFAULT);
	// Set when the toggle/version changes so the "restart to apply" hint shows; the
	// change only takes effect on the next kernel start.
	let runtimeDirty = $state(false);
	// Set on a FRESH connect (the not-connected -> connected transition, in
	// `connect()`): the kernel already started WITHOUT the runtime env, so an
	// import-time IS_DATABRICKS gate has already run. Surfacing the same "restart to
	// apply" hint prompts the user to restart so the default-ON runtime actually
	// takes effect. Cleared when the user acts (restart) or turns the toggle off; it
	// never re-fires after a restart because the post-restart reconnect is handled
	// server-side and does not re-enter `connect()`.
	let connectHint = $state(false);
	onMount(() => {
		runtimeOn = getUi<boolean>(DBX_RUNTIME_KEY, true);
		runtimeVersion = getUi<string>(DBX_RUNTIME_VERSION_KEY, DBX_RUNTIME_VERSION_DEFAULT);
	});
	function toggleRuntime() {
		runtimeOn = !runtimeOn; // optimistic
		setUi(DBX_RUNTIME_KEY, runtimeOn);
		runtimeDirty = true;
		if (!runtimeOn) connectHint = false; // turning it off clears the connect prompt
	}
	function onVersionInput(e: Event) {
		const v = (e.currentTarget as HTMLInputElement).value.trim();
		runtimeVersion = v;
		// Persist a non-empty value; an empty field falls back to the default on read.
		setUi(DBX_RUNTIME_VERSION_KEY, v === '' ? null : v);
		runtimeDirty = true;
	}
	async function restartToApply() {
		runtimeDirty = false;
		connectHint = false;
		if (onRestartKernel && notebookPath) await onRestartKernel(notebookPath);
	}

	/** Query string carrying the active notebook path, so every per-notebook request targets it. */
	function pathQuery(): string {
		return notebookPath ? `?path=${encodeURIComponent(notebookPath)}` : '';
	}

	/** Normalize a thrown value (a route body, or an Error) into `{code, message}`. */
	function toDbxError(err: unknown): DbxError {
		const e = err as { code?: unknown; message?: unknown } | null | undefined;
		return {
			code: typeof e?.code === 'string' ? e.code : 'error',
			message: typeof e?.message === 'string' ? e.message : String(err)
		};
	}

	/** Rows a table preview asks for. Kept small: this is a look, not a load. */
	const LIMITS = [10, 50, 100, 500];
	let limit = $state(50);

	// ---- Status (profiles + install + connection) ----------------------------
	let status = $state<DbxStatus | null>(null);
	let statusError = $state('');
	let busy = $state(''); // 'connect' | 'disconnect' | 'install' | ''

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

	async function loadStatus() {
		const seq = ++statusSeq;
		try {
			const res = await fetch(`/api/databricks${pathQuery()}`);
			const body = await res.json();
			if (!res.ok) throw new Error(body?.message || 'failed to read Databricks status');
			if (seq !== statusSeq) return; // superseded while in flight
			status = body;
			statusError = '';
			// Default to DEFAULT, else the first profile - until the user picks one.
			if (!profileTouched) {
				const names: string[] = (body.config?.profiles ?? []).map((p: DbxProfile) => p.name);
				profile = body.connection?.profile || (names.includes('DEFAULT') ? 'DEFAULT' : (names[0] ?? ''));
			}
		} catch (err) {
			if (seq !== statusSeq) return;
			statusError = toDbxError(err).message;
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

	/** A new selection: forget the old sign-in + cluster list. */
	function resetSelection() {
		authed = false;
		oauthRequired = false;
		authError = null;
		clusters = null;
		clustersError = null;
		clustersFor = null;
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

	// ---- Connect / disconnect ------------------------------------------------
	let connectError = $state<DbxError | null>(null);

	async function connect(cluster: DbxCluster) {
		if (busy) return;
		busy = 'connect';
		connectingId = cluster.cluster_id;
		connectError = null;
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
			// Fresh connect on a kernel that started without the runtime env: prompt a
			// restart so the default-ON runtime takes effect (import-time gate).
			if (runtimeOn) connectHint = true;
			onSessionChange?.();
		} catch (err) {
			connectError = toDbxError(err);
		} finally {
			busy = '';
			connectingId = '';
		}
	}

	async function disconnect() {
		if (busy) return;
		busy = 'disconnect';
		connectError = null;
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
	function clusterBadge(state: string | undefined) {
		if (state === 'RUNNING') return 'badge-success';
		if (state === 'PENDING' || state === 'RESTARTING' || state === 'RESIZING') return 'badge-warning';
		if (state === 'ERROR') return 'badge-error';
		return 'badge-ghost';
	}

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
</script>

{#snippet errorBox(err: DbxError, testid: string)}
	<div class="mt-2 rounded-lg border border-error/30 bg-error/10 p-2" data-testid={testid}>
		{#if REMEDY[err.code]}
			<p class="text-[11px] font-medium leading-relaxed text-base-content/80">{REMEDY[err.code]}</p>
		{/if}
		<p class="mt-0.5 break-words font-mono text-[10px] leading-relaxed text-base-content/50">{err.message}</p>
	</div>
{/snippet}

{#snippet hint(text: string)}
	<p class="mt-1.5 text-[11px] leading-relaxed text-base-content/40">{text}</p>
{/snippet}

<div class="px-3 pb-3" data-testid="databricks-body">
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

		<!-- 3. Ready: profile + cluster picker, or the live session. -->
	{:else}
		{#if connected}
			<div class="rounded-lg border border-success/30 bg-success/10 p-2.5" data-testid="databricks-connected">
				<div class="flex items-center justify-between gap-2">
					<span class="min-w-0 break-words text-sm font-medium" title={connection.clusterName}>{connection.clusterName}</span>
					<span class="badge badge-success badge-sm shrink-0 gap-1" data-testid="databricks-connection-status">
						<span class="inline-block h-1.5 w-1.5 rounded-full bg-current"></span>connected
					</span>
				</div>
				<dl class="mt-2 space-y-0.5 text-[11px] text-base-content/50">
					{#if connection.profile}
						<div class="flex justify-between gap-2"><dt>profile</dt><dd class="truncate font-mono text-base-content/70">{connection.profile}</dd></div>
					{/if}
					{#if connection.host}
						<div class="flex justify-between gap-2"><dt>host</dt><dd class="truncate font-mono text-base-content/70" title={connection.host}>{connection.host.replace(/^https?:\/\//, '')}</dd></div>
					{/if}
					{#if connection.sparkVersion}
						<div class="flex justify-between gap-2"><dt>spark</dt><dd class="truncate font-mono text-base-content/70">{connection.sparkVersion}</dd></div>
					{/if}
				</dl>
				<p class="mt-2 border-t border-success/20 pt-2 text-[11px] leading-relaxed text-base-content/50">
					<code class="font-mono text-[10px] text-primary">spark</code> and
					<code class="font-mono text-[10px] text-primary">w</code> are ready in the kernel.
				</p>
				{#if connection.livenessUnverified}
					<p class="mt-1 text-[11px] leading-relaxed text-base-content/40" data-testid="databricks-unverified">
						Liveness not confirmed (kernel busy or a transient error) - not a dead session.
					</p>
				{/if}
				<div class="mt-2 flex gap-1.5">
					<button class="btn btn-outline btn-xs flex-1" onclick={() => (switching = !switching)} disabled={!!busy} data-testid="databricks-switch">
						{switching ? 'Cancel' : 'Switch cluster'}
					</button>
					<button class="btn btn-outline btn-xs flex-1" onclick={disconnect} disabled={!!busy} data-testid="databricks-disconnect">
						{#if busy === 'disconnect'}<span class="loading loading-spinner loading-xs"></span>{:else}Disconnect{/if}
					</button>
				</div>
				<!-- Databricks-runtime toggle: advertise DATABRICKS_RUNTIME_VERSION so this
				     notebook's IS_DATABRICKS-gated code takes its dbutils.widgets path.
				     Shown only when connected; applies at kernel START (import-time gate),
				     so a change surfaces a "restart to apply" hint. -->
				<div class="mt-2 border-t border-success/20 pt-2">
					<label
						class="flex cursor-pointer items-center gap-2 text-[11px] text-base-content/70"
						title="Advertises a Databricks runtime (sets DATABRICKS_RUNTIME_VERSION) so notebook code that gates on IS_DATABRICKS takes its dbutils.widgets path. Affects all libraries (e.g. mlflow), requires a kernel restart, and does not connect a cluster - use Databricks Connect for spark/Unity Catalog."
					>
						<input
							type="checkbox"
							class="toggle toggle-xs toggle-success"
							checked={runtimeOn}
							onchange={toggleRuntime}
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
								placeholder={DBX_RUNTIME_VERSION_DEFAULT}
								data-testid="databricks-runtime-version"
							/>
						</label>
					{/if}
					{#if runtimeDirty || (connectHint && runtimeOn)}
						<p class="mt-1.5 text-[11px] leading-relaxed text-base-content/60" data-testid="databricks-runtime-hint">
							Takes effect on the next kernel start.
							{#if onRestartKernel && notebookPath}
								<button
									class="text-primary/80 hover:text-primary hover:underline"
									onclick={restartToApply}
									data-testid="databricks-runtime-restart"
								>Restart the kernel to apply now.</button>
							{:else}
								Restart the kernel to apply now.
							{/if}
						</p>
					{/if}
				</div>
			</div>
		{:else if connection.expired}
			<div class="mb-2 rounded-lg border border-warning/30 bg-warning/10 p-2 text-[11px] leading-relaxed text-base-content/70" data-testid="databricks-expired">
				The Spark Connect session on <span class="font-mono">{connection.lost?.clusterName}</span> expired (idle timeout or a closed client). Cellar is reconnecting; if it does not recover, reconnect below.
			</div>
		{:else if connection.lost}
			<div class="mb-2 rounded-lg border border-warning/30 bg-warning/10 p-2 text-[11px] leading-relaxed text-base-content/70" data-testid="databricks-lost">
				The session on <span class="font-mono">{connection.lost.clusterName}</span> ended when the kernel restarted. Reconnect below.
			</div>
		{/if}

		{#if !connected || switching}
			<div class="{connected ? 'mt-2 border-t border-base-300 pt-2' : ''}">
				<!-- 3a. Auth source: a config profile, or a workspace host typed by hand. -->
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

				<!-- 3b. A bare host signs in first; a profile lists straight away and only shows this if the SDK asks for a login. -->
				{#if needsAuth}
					<button
						class="btn btn-primary btn-xs mt-2 w-full gap-1"
						onclick={signIn}
						disabled={!!busy || !haveSelection}
						data-testid="databricks-signin"
					>
						{#if busy === 'login'}<span class="loading loading-spinner loading-xs"></span>Opening browser…{:else}Sign in with Databricks{/if}
					</button>
					{@render hint('Opens your browser to authenticate with Databricks (OAuth). No access token required, and Cellar stores nothing.')}
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
						<p class="px-1 py-2 text-xs text-base-content/40">loading clusters…</p>
					{:else if clusters?.length}
						<div class="max-h-56 space-y-1 overflow-y-auto">
							{#each clusters as c (c.cluster_id)}
								<button
									class="flex w-full items-center gap-1.5 rounded border border-base-300 px-1.5 py-1 text-left hover:border-primary/50 hover:bg-base-300/40 disabled:opacity-50"
									onclick={() => connect(c)}
									disabled={!!busy}
									title="Connect 'spark' to {c.name}"
									data-testid="databricks-cluster"
								>
									<span class="min-w-0 flex-1">
										<span class="block truncate text-xs text-base-content/80">{c.name}</span>
										{#if c.spark_version}<span class="block truncate font-mono text-[10px] text-base-content/40">{c.spark_version}</span>{/if}
									</span>
									{#if connectingId === c.cluster_id}
										<span class="loading loading-spinner loading-xs shrink-0 text-primary"></span>
									{:else}
										<span class="badge badge-xs shrink-0 {clusterBadge(c.state)}">{c.state.toLowerCase()}</span>
									{/if}
								</button>
							{/each}
						</div>
						{#if busy === 'connect'}
							{@render hint('Connecting… starting a terminated cluster can take a few minutes.')}
						{/if}
					{:else if clusters}
						<p class="px-1 py-2 text-xs text-base-content/40">no clusters in this workspace</p>
					{/if}
				{/if}

				{#if connectError}{@render errorBox(connectError, 'databricks-connect-error')}{/if}
			</div>
		{/if}

		<!-- 4. Unity Catalog browser: catalog > schema > table, one level per expand. -->
		{#if connected}
			<div class="mt-3 border-t border-base-300 pt-2" data-testid="databricks-browser">
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
					<p class="px-1 py-2 text-xs text-base-content/40">loading catalogs…</p>
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
										{@render errorBox(node.error, 'databricks-node-error')}
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
														{@render errorBox(tnode.error, 'databricks-node-error')}
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
					<p class="px-1 py-2 text-xs text-base-content/40">no catalogs visible to this profile</p>
				{/if}
			</div>
		{/if}
	{/if}
</div>
