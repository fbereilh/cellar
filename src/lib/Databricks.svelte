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
	import { onMount, untrack } from 'svelte';
	import { subscribeEvents } from '$lib/events-client';
	import { getUi, setUi, setUiNow } from '$lib/uiState';
	import { getUserSettingText, onUserSettingsChange } from '$lib/userSettings';
	import { UPLOAD_PREFIX_DEFAULT_KEY, UPLOAD_POSTFIX_DEFAULT_KEY } from '$lib/uploadDefaults';
	import { normalizeDatabricksHost } from '$lib/databricksHost';
	import { SDK_DBUTILS_FOREIGN_WARNING, type SdkDbutilsState } from '$lib/dbutilsShim';
	import {
		PROFILE_REAUTH_CODE,
		REAUTH_COMMAND_HEAD,
		REAUTH_PROFILE_FLAG,
		reauthCommand,
		reauthDetail,
		reauthExplanation
	} from '$lib/databricksReauth';
	import {
		DEFAULT_PROFILE_CONSEQUENCE,
		DEFAULT_PROFILE_REMEDY,
		SWITCH_COMMAND_HEAD,
		SWITCH_PROFILE_FLAG,
		defaultProfileNoticeApplies,
		defaultProfileProblem,
		switchDefaultProfileCommand,
		type DefaultProfileVerdict
	} from '$lib/databricksDefaultProfile';
	import {
		UPLOAD_DATE_TOKENS,
		expandDateTokens,
		resolveUploadName,
		unknownAffixTokens,
		unknownTokenWarning
	} from '$lib/databricksUploadName';
	import { insertTokenIntoField, tokenField } from '$lib/uploadTokenField';
	import { databricksPanelState } from '$lib/databricksPanelState';
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
		 * The session is down only because the kernel is mid-restart and the server is
		 * rebuilding it (`restartingAfterKernelRestart` in `databricks.ts`). Set for as
		 * long as that rebuild is actually in flight - which is seconds, not
		 * milliseconds: it runs a cluster probe, an install check and a whole Spark
		 * Connect session build. The panel reads this exactly like its own in-panel
		 * `restarting` flag - hold the connecting presentation - so a restart never
		 * flashes the "lost" card. The moment the outcome is known (healed, or gave up)
		 * the server stops setting it and the real state shows.
		 */
		restarting?: boolean;
		/**
		 * Set only when a reconnect proved this notebook's session is down because the
		 * profile's CLI-managed sign-in died - the one case the automatic retry can
		 * never recover from, and the one the sidebar's own sign-in button cannot fix.
		 * It rides every not-live shape (expired / lost / plain disconnected), because
		 * a failed self-heal clears the connection and drops the panel to the picker;
		 * `sessionReauthBox` renders it on whichever card is showing.
		 */
		reauth?: DbxError;
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
		config?: {
			profiles?: DbxProfile[];
			/**
			 * Would a bare `Config()` - the kind a user's own library builds - resolve
			 * any credentials on this machine? Read from `~/.databrickscfg` server-side;
			 * see `$lib/databricksDefaultProfile`. Absent on an older server payload,
			 * which reads as "say nothing".
			 */
			defaultProfile?: DefaultProfileVerdict;
		};
		install?: DbxInstall;
		/** Whether uv is available to install packages. */
		uv?: boolean;
		/** Bare hosts this server process has completed a Cellar sign-in for (NORMALIZED). */
		signedInHosts?: string[];
		/** No-token external-browser profiles this server process has signed in for. */
		signedInProfiles?: string[];
		/**
		 * What the notebook's LIVE kernel session was actually started with for the
		 * Databricks runtime - never the stored preference. The env is read at import
		 * time, so it is fixed for a session: a toggle flipped since, or a connect that
		 * bound a kernel which started unbound, legitimately diverge from it. The Runtime
		 * card's state pill reads THIS, so it can never claim "active" over a kernel that
		 * does not advertise the runtime.
		 *
		 * `envForced` says WHO decides: `true`/`false` when `CELLAR_DATABRICKS_RUNTIME`
		 * forces it, `null` when the stored preference does. The client cannot read the
		 * server's env, so this is the only way it knows the toggle (and a restart) cannot
		 * change the outcome. `versionEnvForced` is the same fact for the VERSION
		 * (`CELLAR_DATABRICKS_RUNTIME_VERSION`) - a separate field because the two overrides
		 * are independent, so the card names whichever is actually in force.
		 */
		runtime?: {
			kernelStarted: boolean;
			liveVersion: string | null;
			/** The STORED on/off preference - what the toggle shows; see its re-seed effect. */
			preference?: boolean;
			envForced?: boolean | null;
			versionEnvForced?: string | null;
			/**
			 * Which `dbutils` the SDK import path (`from databricks.sdk.runtime import
			 * dbutils`) resolves to in the running kernel. `foreign` is the one state
			 * with something to say: the SDK's own object renders parameter widgets and
			 * then discards every entered value on re-declaration, so the feature looks
			 * like it works while doing nothing. Anything else - including a state the
			 * server could not determine (`unknown`) - is silent.
			 */
			sdkDbutils?: SdkDbutilsState;
		};
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
		onRestartKernel = null,
		/**
		 * Whether the sidebar section is EXPANDED right now. The panel stays MOUNTED
		 * when it is collapsed (so the connection, the cluster list and a half-expanded
		 * catalog tree survive a fold), so this prop is the only thing that can tell it
		 * not to spend work on something nobody can see - today, the upload preview's
		 * clock. Defaults to true so a standalone mount behaves as if it were open.
		 */
		visible = true
	}: {
		notebookPath?: string | null;
		kernelSessionId?: SessionId | null;
		onInsertAndRun?: ((source: string) => void) | null;
		onSessionChange?: (() => void) | null;
		onRestartKernel?: ((path: string) => void | Promise<void>) | null;
		visible?: boolean;
	} = $props();

	/** Let the section header's refresh button re-read status (bind:this in Sidebar). */
	export function refresh() {
		loadStatus();
	}

	// ---- Databricks-runtime card (advertise DATABRICKS_RUNTIME_VERSION) --------
	// Sets DATABRICKS_RUNTIME_VERSION in the kernel at start so notebook code that
	// checks for a Databricks runtime takes its `dbutils.widgets` path. Persisted
	// per workspace (server keys mirrored from `$lib/server/databricksRuntime.ts` -
	// a client component can't import a `$lib/server` module). The check is made at
	// import time, so a change takes effect only on the next kernel START; rather
	// than leave the user a manual "restart to apply" hint, Cellar APPLIES the
	// change immediately by restarting the kernel (which re-injects the env AND
	// rebuilds spark/w via the server's reconnect-after-restart path).
	//
	// Default OFF, and scoped server-side to a CONNECTED notebook. CONNECTING a
	// cluster deliberately leaves it off and does NOT restart the kernel (see
	// `connect()`): the toggle is the one opt-in, and the one thing that restarts.
	const DBX_RUNTIME_KEY = 'cellar-databricks-runtime';
	const DBX_RUNTIME_VERSION_KEY = 'cellar-databricks-runtime-version';
	const DBX_RUNTIME_VERSION_DEFAULT = '15.4';
	let runtimeOn = $state(false);
	let runtimeVersion = $state(DBX_RUNTIME_VERSION_DEFAULT);
	// The version string currently LIVE in the kernel (set at each apply), so a
	// version edit only restarts when it actually changed from what is running.
	let appliedVersion = $state(DBX_RUNTIME_VERSION_DEFAULT);
	// True while a runtime change (toggle or version) is restarting the kernel, so
	// the Runtime card shows an "applying…" state and the transient post-restart
	// lost/expired flash is suppressed.
	let runtimeApplying = $state(false);
	// True from the moment an EXPECTED kernel restart is issued (a runtime toggle or
	// version apply - both go through `applyRuntime`; a connect no longer restarts)
	// until the session settles again (`settleConnection`). It is what distinguishes
	// an expected restart-in-progress from a genuine unexpected session loss: while
	// it is set, the "lost"/"expired" cards are suppressed and the connecting/connected
	// view is held, so the transient mid-restart "session lost" the epoch bump reports
	// never surfaces. Cleared on settle (connected) OR on the reconnect timing out, so
	// a reconnect that genuinely fails still falls through to the real lost/expired
	// state with its Reconnect button.
	let restarting = $state(false);
	/**
	 * The notebook the panel's OWN in-flight transition (a connect, or the kernel
	 * restart an `applyRuntime` issues) was latched for. This panel is ONE long-lived
	 * component whose `notebookPath` follows the active tab while `busy`/`restarting`/
	 * `runtimeApplying`/`connectOverLive` are panel-wide, so without it a connect that
	 * can run to MINUTES held the whole connected view over whichever notebook the user
	 * tabbed to next - one with no session of its own. Same idiom as
	 * `uploadToWorkspace`'s `const target = notebookPath`; the rule that reads it is
	 * `panelOwnsTransition` in `$lib/databricksPanelState`.
	 *
	 * Set at the start of every transition and deliberately NEVER cleared: it is only
	 * ever consulted while a transition flag is set, and clearing it in a `finally`
	 * would let a connect settling on notebook A wipe the ownership a runtime apply
	 * started on B in the meantime.
	 */
	let transitionPath = $state<string | null | undefined>(undefined);
	onMount(() => {
		// `=== true` mirrors the server's `databricksRuntimeEnabled` exactly: only an
		// explicit stored true is ON, so the toggle can never render on over a value the
		// kernel would read as off.
		runtimeOn = getUi<unknown>(DBX_RUNTIME_KEY, false) === true;
		runtimeVersion = getUi<string>(DBX_RUNTIME_VERSION_KEY, DBX_RUNTIME_VERSION_DEFAULT);
		appliedVersion = runtimeVersion;
		// The upload affixes are seeded by their own effect (`seedUploadAffixes`), not
		// here: a one-shot mount read is exactly what left a default set in Settings
		// invisible to a panel that was already open.
	});

	/**
	 * Re-seed the toggle from the SERVER's copy of the preference whenever a status
	 * lands, the same lesson as `seedUploadAffixes` one field over: a one-shot mount
	 * read is only correct while this panel is the sole writer, and it is not - the
	 * `databricks_runtime` MCP tool writes the same preference server-side (as would a
	 * second Cellar instance, or a hand-edited store).
	 *
	 * A stale toggle here is destructive rather than cosmetic. `toggleRuntime` applies
	 * `!runtimeOn`, so a toggle still showing OFF over an already-ON preference
	 * restarts the kernel, clears every variable, and leaves the state exactly where it
	 * was - the "a control that cannot do its work must not claim it did" defect the
	 * card's env-forced and no-notebook states exist to avoid.
	 *
	 * Guarded on nothing being in flight: `applyRuntime` sets `runtimeOn` optimistically
	 * before its awaited write lands, so a status read resolving inside that window
	 * would bounce the toggle back to the value being replaced. Deliberately NOT
	 * extended to the version INPUT - that binds a field the user may be typing in, and
	 * its stored value is written per keystroke, so seeding it would clobber an edit in
	 * progress. What makes that residual purely cosmetic is the rule one function down:
	 * a plain toggle (and "Apply now") never WRITES the version key, so a stale input
	 * cannot clobber a version an agent set through `databricks_runtime` - it merely
	 * displays the old value until a reload, while the card's live pill and
	 * `runtimeEffectiveVersion` report what is really in force.
	 *
	 * `appliedVersion` IS re-seeded here, from the version the running kernel actually
	 * carries: it exists solely as `commitVersion`'s "did the version really change"
	 * comparand, so it has to track what was applied by ANY writer, not just by this
	 * panel. A kernel carrying none (off, or not started) leaves it alone - there is no
	 * live value to learn from, and clearing it would make the next edit restart to
	 * apply a version that is already stored.
	 */
	$effect(() => {
		const stored = status?.runtime?.preference;
		const live = runtimeLiveVersion;
		if (runtimeApplying || busy) return;
		untrack(() => {
			if (typeof stored === 'boolean') runtimeOn = stored;
			if (live) appliedVersion = live;
		});
	});

	/**
	 * Apply the runtime preference to the LIVE kernel: persist on/off server-side FIRST
	 * (race-free via `setUiNow`, so the restart re-reads the new value), then restart the
	 * kernel so `initKernel` injects/omits the env for the fresh imports and
	 * `reconnectAfterKernelRestart` rebuilds spark/w. The one and only "apply runtime"
	 * path: the toggle, "Apply now" and a version edit are its callers, and connecting a
	 * cluster deliberately is not.
	 *
	 * `writeVersion` is the load-bearing half, and it is opt-in for exactly ONE caller.
	 * The version key may only be written by a deliberate version EDIT (`commitVersion`),
	 * never by an on/off toggle and never by "Apply now": neither is a statement about
	 * the version, and this panel's `runtimeVersion` is a mount-time snapshot that the
	 * re-seed effect above deliberately does not refresh. Writing it unconditionally
	 * meant the user's next toggle silently reverted a version an agent had set through
	 * `databricks_runtime` and restarted the kernel onto the stale one. A toggle flips
	 * the ADVERTISEMENT only; whatever version is stored is the one it applies.
	 */
	async function applyRuntime(on: boolean, { writeVersion = false } = {}): Promise<void> {
		// Whose restart this is, for the same reason `connect` latches it: the panel
		// follows the active tab, the restart does not follow with it.
		transitionPath = notebookPath;
		runtimeOn = on; // optimistic
		await setUiNow(DBX_RUNTIME_KEY, on);
		if (writeVersion) {
			const v = runtimeVersion.trim();
			await setUiNow(DBX_RUNTIME_VERSION_KEY, v === '' ? null : v);
			// Optimistic, like `runtimeOn`: the re-seed effect confirms it from the version
			// the restarted kernel really carries.
			appliedVersion = v || DBX_RUNTIME_VERSION_DEFAULT;
		}
		if (onRestartKernel && notebookPath) {
			// Mark the expected-restart window BEFORE issuing it, so the transient
			// mid-restart "session lost" the epoch bump reports is read as "connecting",
			// never "lost". `settleConnection` clears it once the session settles.
			restarting = true;
			await onRestartKernel(notebookPath);
		}
	}

	/**
	 * Toggle the runtime on/off; applies IMMEDIATELY by restarting the kernel.
	 *
	 * Refused where the restart cannot happen (`runtimeRestartable`) as well as where it
	 * cannot decide anything (`runtimeEnvControlled`). With no notebook path `applyRuntime`
	 * writes the preference and silently skips the restart, so the card would sit with the
	 * toggle off beside a live "active" pill, under a hint claiming variables were cleared
	 * by a restart that never ran. The toggle is disabled in both states for the same
	 * reason "Apply now" is: a control that cannot do its work must not claim it did.
	 *
	 * It flips the ADVERTISEMENT only - no `writeVersion`, so it can never revert a
	 * version set elsewhere (see `applyRuntime`).
	 */
	async function toggleRuntime() {
		if (runtimeApplying || busy || runtimeEnvControlled || !runtimeRestartable) return;
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
	/**
	 * Apply an already-ON preference the RUNNING kernel does not carry (the `pending`
	 * state): restart so `initKernel` injects the env for the fresh imports. It writes
	 * the SAME stored value it reads, so the preference is unchanged - this only asks
	 * for the restart the pending copy says is needed, instead of leaving the toggle's
	 * off-then-on double restart as the only route. Third caller of `applyRuntime`,
	 * same shape as the other two, so the restart, the suppressed lost-flash and the
	 * settle handling are identical - and, like the toggle, it is not a version edit,
	 * so it passes no `writeVersion` and applies whatever version is stored.
	 *
	 * Guarded by `runtimeApplicable`, so it can only ever run where a restart really
	 * applies the runtime: an env-forced decision and a missing notebook path both make
	 * the restart a no-op that still costs the user their namespace.
	 */
	async function applyPendingRuntime() {
		if (runtimeApplying || busy || !runtimeApplicable) return;
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
	 * Commit a version edit (blur/Enter): restart to apply only if it truly changed.
	 *
	 * Same rule as the toggle - refused when `CELLAR_DATABRICKS_RUNTIME_VERSION` holds the
	 * version (the restart would advertise the override's value again) or when there is no
	 * kernel to restart. The input is disabled in both states, so this is the backstop.
	 *
	 * The ONE caller that passes `writeVersion`, because it is the only one stating
	 * anything about the version. Its "did it really change" comparand is
	 * `appliedVersion`, which the re-seed effect keeps tracking the running kernel, so
	 * an agent-set version is compared against too.
	 */
	async function commitVersion() {
		if (runtimeApplying || busy || !runtimeEffectiveOn) return;
		if (runtimeVersionEnvControlled || !runtimeRestartable) return;
		if ((runtimeVersion.trim() || DBX_RUNTIME_VERSION_DEFAULT) === appliedVersion) return;
		runtimeApplying = true;
		try {
			// Pass the STORED preference, not `true`: under an env override the runtime is
			// on without the user having opted in, and a version edit must not silently
			// write an opt-in they never made.
			await applyRuntime(runtimeOn, { writeVersion: true });
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
	let busy = $state(''); // 'connect' | 'disconnect' | 'logout' | 'login' | 'reconnect' | 'install' | 'upload' | ''

	const connection = $derived<DbxConnection>(status?.connection ?? { connected: false });
	const connected = $derived(!!connection.connected);
	/**
	 * The Databricks runtime the RUNNING kernel actually carries, straight from the
	 * server (`getStatus().runtime`) - deliberately NOT `runtimeOn`, which is only the
	 * stored preference this panel just wrote. The env is read at import time, so the
	 * two honestly diverge whenever the kernel started before the preference applied:
	 * a toggle is applied by a restart, but a kernel that started while the notebook
	 * was still unbound (the scope gate) stays without the env until it restarts. The
	 * card reports reality and names the divergence rather than hiding it.
	 */
	const runtimeLiveVersion = $derived(status?.runtime?.liveVersion ?? null);
	const runtimeActive = $derived(runtimeLiveVersion !== null);
	const runtimeKernelStarted = $derived(!!status?.runtime?.kernelStarted);
	/**
	 * `CELLAR_DATABRICKS_RUNTIME` forces the decision (`true`/`false`), so neither the
	 * toggle nor a kernel restart can change it. The card must say so rather than
	 * present a state the user can act on: with a forced-OFF override over a stored
	 * `true` (the carried-over preference this build deliberately does not migrate) the
	 * card would otherwise sit in `pending` forever, offering an "Apply now" that wipes
	 * the namespace and returns to `pending` on every click.
	 */
	const runtimeEnvForced = $derived(status?.runtime?.envForced ?? null);
	const runtimeEnvControlled = $derived(runtimeEnvForced !== null);
	/**
	 * `CELLAR_DATABRICKS_RUNTIME_VERSION` forces the advertised VERSION. Independent of
	 * the on/off override - either can be set alone - so it is its own flag: with it set,
	 * a version edit's apply-restart would clear the namespace to advertise a value the
	 * override discards, so the input states who holds it instead of offering the edit.
	 */
	const runtimeVersionEnvForced = $derived(status?.runtime?.versionEnvForced ?? null);
	const runtimeVersionEnvControlled = $derived(runtimeVersionEnvForced !== null);
	/** What is actually in force: the override when there is one, else the preference. */
	const runtimeEffectiveOn = $derived(runtimeEnvForced ?? runtimeOn);
	/**
	 * The version actually in force: the override, else what the running kernel carries,
	 * else the stored preference. Only ever DISPLAYED where the input is not editable, so
	 * the card shows the value that is real rather than one the environment discards.
	 */
	const runtimeEffectiveVersion = $derived(
		runtimeVersionEnvForced ?? runtimeLiveVersion ?? runtimeVersion
	);
	/** The runtime is meant to be on, but the running kernel does not (yet) carry it. */
	const runtimePending = $derived(runtimeEffectiveOn && !runtimeActive);
	/**
	 * There is a kernel this panel can actually restart. `applyRuntime`'s restart is
	 * guarded on `notebookPath`/`onRestartKernel` (the Sidebar passes the ACTIVE notebook,
	 * which is null with no notebook tab open), so without this every write control on the
	 * card would persist a preference, silently skip the restart, and then be described by
	 * copy that claims the restart happened. Every control that applies through a restart
	 * is gated on it.
	 */
	const runtimeRestartable = $derived(!!notebookPath && !!onRestartKernel);
	/**
	 * A restart would genuinely apply the runtime: it is pending, a kernel is running to
	 * restart, the decision is the user's (not the environment's), and there is a
	 * notebook to restart.
	 */
	const runtimeApplicable = $derived(
		runtimePending && runtimeKernelStarted && !runtimeEnvControlled && runtimeRestartable
	);
	/**
	 * The running kernel advertises the runtime, a cell has imported
	 * `databricks.sdk.runtime`, and its `dbutils` is NOT Cellar's shim - so widget
	 * values entered through that import are being thrown away on every
	 * re-declaration. Surfaced because it is otherwise INVISIBLE: the SDK draws the
	 * same controls, so a user reads rendered widgets as proof the parameters work.
	 * Reported only for the state the server actually observed - `unknown` (no
	 * kernel, a busy one, a failed probe) says nothing.
	 */
	const runtimeSdkForeign = $derived(status?.runtime?.sdkDbutils === 'foreign');
	const profiles = $derived(status?.config?.profiles ?? []);
	const hasProfiles = $derived(profiles.length > 0);
	/**
	 * The default-profile notice, decided by `$lib/databricksDefaultProfile`'s
	 * `defaultProfileNoticeApplies` - the ONE owner of that rule (which states the
	 * two halves and why `expired` counts while `lost`/`restarting` does not). Kept
	 * out of this component deliberately: it is a decision rather than a rendering,
	 * and only the unit suite runs in CI and in the gate, so a rule living here as an
	 * expression could be deleted and merge green.
	 */
	const defaultProfile = $derived(status?.config?.defaultProfile);
	const needsDefaultProfile = $derived(defaultProfileNoticeApplies(defaultProfile, connection));
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
		// The upload feedback names a workspace path THIS notebook was copied to, so
		// it must not follow the panel onto another one - least of all the pending
		// replace confirm, which would then overwrite on behalf of a different file.
		// A mere epoch change is not a notebook change: the uploaded copy is still there.
		if (lastKey !== key) clearUploadFeedback();
		lastKey = key;
		lastSession = sid;
		loadStatus();
	});

	/**
	 * While the server reports `restarting`, poll it - this panel has no periodic poll
	 * of its own, and nothing else guarantees another read. A reconnect that SUCCEEDS
	 * publishes `databricks:changed` and re-reads on its own, but one that FAILS (or is
	 * never attempted - a torn-down kernel, a connect already in flight) publishes
	 * nothing, so without this the panel would sit on "Reconnecting…" forever instead
	 * of falling through to the honest lost card.
	 *
	 * It is a poll rather than a single delayed re-check because the flag is no longer
	 * a ~1s window: it now lasts as long as the rebuild is genuinely in flight (a
	 * cluster probe + install check + Spark Connect session build, i.e. seconds).
	 *
	 * It is SELF-DRIVING, and that is load-bearing: a FAILED read leaves `status`
	 * untouched (`loadStatus`'s catch only writes `statusError`), so an effect that
	 * re-armed only when a read APPLIED would break its own chain on the first flaky
	 * GET and sit on the spinner forever - the exact stuck state this poll exists to
	 * prevent. So each tick bumps `restartRecheckTick` AFTER its read settles, which
	 * re-runs this effect whatever the read did (and never overlaps two reads). It
	 * converges by construction: the first status that is not `restarting` (or a
	 * notebook switch, or unmount) fails the guard and no further timer is armed.
	 *
	 * Backoff is a second safeguard on top of the server's memoized workspace probes:
	 * the window is unbounded (a cold-cluster reconnect is minutes), so a long one
	 * settles into an idle-ish cadence instead of a fixed 1.2s drumbeat.
	 */
	const RESTART_RECHECK_MS = 1200;
	const RESTART_RECHECK_MAX_MS = 5000;
	let restartRecheckTick = $state(0);
	let restartRecheckAttempts = 0;
	$effect(() => {
		void restartRecheckTick; // a real dependency: re-arm on every tick, failed reads included
		if (!connection.restarting) {
			restartRecheckAttempts = 0;
			return;
		}
		const delay = Math.min(RESTART_RECHECK_MS * 2 ** restartRecheckAttempts, RESTART_RECHECK_MAX_MS);
		const t = setTimeout(() => {
			restartRecheckAttempts++;
			void loadStatus().finally(() => restartRecheckTick++);
		}, delay);
		return () => clearTimeout(t);
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
	/**
	 * A connect was issued over a session that was ALREADY live - i.e. a cluster
	 * SWITCH rather than a first connect. LATCHED at the click rather than read off
	 * `connected` each frame, because a switch to an older-DBR cluster makes
	 * `ensurePinnedConnect` restart the kernel mid-connect, and the status read that
	 * follows reports the session momentarily lost. That frame is exactly the one
	 * that must NOT unmount the panel, so the latch (not the live flag) is what
	 * `holdsConnectedView` keys off (see `$lib/databricksPanelState`). Cleared in
	 * `connect`'s `finally`, so a connect that FAILS falls straight back to whatever
	 * the honest state is.
	 */
	let connectOverLive = $state(false);

	/**
	 * Which card the connection area renders, and which face the Cluster card wears.
	 * The rule itself lives in `$lib/databricksPanelState` - see its header for THE
	 * FLICKER RULE and why it may not live here (vitest cannot mount this component,
	 * and e2e runs in neither CI nor the no-mistakes gate).
	 */
	const panel = $derived(
		databricksPanelState({
			notebookPath,
			transitionPath,
			busy,
			connected,
			restarting,
			serverRestarting: !!connection.restarting,
			runtimeApplying,
			connectOverLive,
			expired: !!connection.expired,
			lost: !!connection.lost
		})
	);

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
		// Latched BEFORE the await: from here on `connected` may honestly go false
		// (a re-pin kernel restart), and this is what keeps the panel from unmounting
		// around that frame. See `holdsConnectedView` in `$lib/databricksPanelState`.
		connectOverLive = connected;
		// ...and WHOSE frame it is. A connect can run to minutes, so the user may well
		// tab to another notebook while it does; that notebook must show its own state,
		// not this one's held connected view. See `panelOwnsTransition`.
		transitionPath = notebookPath;
		// Collapse the picker on the CLICK, not on the reply. The list has served its
		// purpose the moment a cluster is chosen, and the card above now names the
		// target, so leaving it open (disabled) only means the panel jumps at the very
		// instant the session lands - after a wait that can run to minutes. Closing it
		// here instead leaves the panel a fixed height for that whole wait. Reopened by
		// the `catch`, which is where the error box and the retry list belong.
		switching = false;
		connectingId = cluster.cluster_id;
		connectingName = cluster.name;
		connectError = null;
		reconnectNote = '';
		reconnectError = null;
		// Same reason as `signIn`: a live session is the loudest possible contradiction
		// of "signed out everywhere", and connecting is not a selection change.
		clearLogoutFeedback();
		// A pending replace confirm names a path in the workspace we are leaving, so
		// acting on it after the switch would overwrite in the wrong one.
		clearUploadFeedback();
		try {
			const res = await fetch('/api/databricks/connect', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ...selectionParams(), clusterId: cluster.cluster_id, clusterName: cluster.name, path: notebookPath ?? undefined })
			});
			const body = await res.json();
			if (!res.ok) throw body;
			await loadStatus();
			onSessionChange?.();
			// Connecting binds `spark`/`w` in the LIVE kernel and stops there: it does not
			// touch the Databricks-runtime preference and does not restart the kernel, so
			// the user's namespace survives a connect. Advertising a runtime changes what
			// every library believes about its environment, so it stays an explicit opt-in
			// via the Runtime toggle - the only thing that restarts the kernel for it.
		} catch (err) {
			connectError = toDbxError(err);
			// Reopen the picker a successful connect would have left closed: it carries
			// the one connect-error box, and the list to retry from. Only meaningful over
			// a live session (the connected card); disconnected, the picker is the card.
			if (connectOverLive) switching = true;
		} finally {
			busy = '';
			connectOverLive = false;
			connectingId = '';
			connectingName = '';
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
		clearUploadFeedback();
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

	// ---- Upload the open notebook to the workspace ----------------------------
	// Workspace FILES only: it copies the notebook into `/Users/<you>/` through the
	// same authenticated WorkspaceClient every listing uses, and never touches
	// compute (nothing here starts, stops or restarts a cluster).
	let uploadError = $state<DbxError | null>(null);
	/**
	 * The outcome of the last upload, kept STRUCTURED rather than as one sentence so
	 * the workspace path can be rendered on its own line in mono. In a ~200px panel a
	 * path interpolated into prose has to break mid-segment (`…/not` / `ebook`), which
	 * is exactly the part of the message the user needs to read.
	 */
	let uploadDone = $state<{ headline: string; path: string; url: string } | null>(null);
	/**
	 * The workspace path an upload found ALREADY OCCUPIED, which arms the inline
	 * replace confirm. Nothing was written when this is set - the server reports
	 * `status:'exists'` and writes nothing - so the only way to overwrite is this
	 * second, deliberate click.
	 */
	let uploadExistsPath = $state('');

	// ---- The uploaded name: an optional prefix + postfix around the notebook's own
	// The rule (assembly, date tokens, the separator refusal) is NOT here - it is
	// `$lib/databricksUploadName`, shared with the server, so the name previewed
	// below and the name the workspace receives cannot drift apart.
	const DBX_UPLOAD_PREFIX_KEY = 'cellar-databricks-upload-prefix';
	const DBX_UPLOAD_POSTFIX_KEY = 'cellar-databricks-upload-postfix';
	let uploadPrefix = $state('');
	let uploadPostfix = $state('');
	/**
	 * This project's affix, or the user's cross-project DEFAULT when this project has
	 * never had one of its own.
	 *
	 * The direction is the whole rule and must not be inverted: the per-project store
	 * is authoritative wherever it has an answer, and the global default only supplies
	 * one where it does not. A default that overrode would silently rewrite naming a
	 * user set deliberately, project by project, the first time they changed it.
	 *
	 * "Has an answer" is `typeof === 'string'`, so an EXPLICITLY EMPTY affix counts -
	 * which is why the input persists `''` rather than deleting the key. Clearing the
	 * field is an edit like any other ("no prefix on this project"), and deleting would
	 * make it indistinguishable from never having set one, so the default would come
	 * back on the next load and undo exactly what the user just did.
	 *
	 * Both are raw text, never expanded: a default is a PATTERN reused across projects
	 * and days, so storing what it resolved to on the day it was set would stamp every
	 * later upload with a stale date.
	 */
	function storedAffix(key: string, defaultKey: string): string {
		const own = getUi<unknown>(key, undefined);
		if (typeof own === 'string') return own;
		return getUserSettingText(defaultKey);
	}
	/**
	 * Re-read both affixes from the stores.
	 *
	 * Deliberately RE-readable rather than a one-shot mount seed: this panel is
	 * mounted lazily and then kept mounted for the session, so a default set in
	 * Settings afterwards reached it only on a reload - the field sat empty while the
	 * Settings copy promised it applied to every project that had not set its own.
	 *
	 * Safe to run at any time precisely BECAUSE of the direction: a project with an
	 * answer of its own always wins, and every keystroke writes that answer through
	 * `setUi` (which updates the client cache synchronously), so a re-read while the
	 * user is typing returns exactly what they typed and can never clobber it.
	 *
	 * A seed that MOVES an affix drops the previous attempt's feedback, exactly as
	 * typing does (`setUploadAffix`): the "uploaded to" note and the armed replace
	 * confirm each name a workspace path built from the OLD affixes, so a default
	 * changed in Settings would otherwise leave the box naming one path while the
	 * preview a line above named another. The guard is what makes it callable from
	 * both triggers - most seeds change nothing (reopening the section, a change to
	 * some OTHER setting), and dismissing a still-accurate note there would be the
	 * same defect with the sign flipped.
	 *
	 * An upload IN FLIGHT DEFERS the whole seed rather than clearing over it. The
	 * attempt pinned its own affixes at the click, and clearing bumps `uploadSeq` -
	 * which makes `uploadToWorkspace` discard the settled reply as superseded: the
	 * replace really happened, the panel said nothing about it, and the box vanished
	 * mid-flight, the same silent clobber Cancel is deliberately inert for. Deferring
	 * self-heals because the effect below tracks that gate, so the seed lands the
	 * moment the attempt settles.
	 *
	 * A deferred seed then keeps WHATEVER the attempt it waited on produced, and the
	 * asymmetry with typing is the point. The "uploaded to"/"replaced" note (or an
	 * error) is a past-tense record of an attempt the user themself confirmed and is
	 * the very thing they are still waiting to read. An armed replace confirm survives
	 * for a stronger reason still: a `status:'exists'` reply leaves both of those null,
	 * so the box IS the entire outcome, and dropping it would leave NOTHING on screen
	 * for an attempt that has just settled - indistinguishable from an upload that
	 * silently did nothing. That the box names a path built from the OLD affixes is not
	 * a reason to drop it either: `uploadExistsAffixes` PINS them, so Replace overwrites
	 * exactly the path the box names, which is what makes keeping it self-consistent.
	 * An IMMEDIATE seed - nothing was in flight, so nothing arrived - still clears
	 * everything, exactly as typing does.
	 */
	let uploadSeedDeferred = false;
	let uploadSeedDeferredAt = 0;
	function seedUploadAffixes() {
		const prefix = storedAffix(DBX_UPLOAD_PREFIX_KEY, UPLOAD_PREFIX_DEFAULT_KEY);
		const postfix = storedAffix(DBX_UPLOAD_POSTFIX_KEY, UPLOAD_POSTFIX_DEFAULT_KEY);
		if (prefix === uploadPrefix && postfix === uploadPostfix) {
			uploadSeedDeferred = false;
			return;
		}
		if (uploadConfirmBusy) {
			// Recorded ONCE per deferral: re-reading it on every re-run while still gated
			// would forget that an outcome arrived in between.
			if (!uploadSeedDeferred) {
				uploadSeedDeferred = true;
				uploadSeedDeferredAt = uploadFeedbackSeq;
			}
			return;
		}
		const arrived = uploadSeedDeferred && uploadFeedbackSeq !== uploadSeedDeferredAt;
		uploadSeedDeferred = false;
		uploadPrefix = prefix;
		uploadPostfix = postfix;
		// Whatever arrived while this seed waited is kept, armed confirm included - see
		// the note above for why the `exists` shape is the case that decides this.
		if (!arrived) clearUploadFeedback();
	}
	$effect(() => {
		// The SUBSCRIPTION is the case that matters: the Settings modal sits OVER an
		// expanded sidebar, so nothing about this panel changes while the default is
		// being edited, and without a change signal it would still catch up only on a
		// reload - which is exactly what the reported gap was. Registered ONCE: the
		// callback reads (and writes) the affixes, so tracking it here would tear the
		// listener down and re-register it on every keystroke, an effect whose own
		// write feeds its own dependencies.
		return onUserSettingsChange(() => untrack(seedUploadAffixes));
	});
	$effect(() => {
		// The catch-up triggers, read explicitly so the untracked seed still re-runs on
		// them: the section being reopened (the panel stays mounted while folded away,
		// so this is the closest it has to being opened afresh), and the in-flight gate
		// lifting, which is what applies a deferred seed.
		void visible;
		void uploadConfirmBusy;
		untrack(seedUploadAffixes);
	});
	/**
	 * The affixes the ARMED replace confirm was resolved with, pinned at the moment
	 * it armed. Replace re-sends these rather than re-resolving, for the same reason
	 * `uploadSeq` exists: the box names one workspace path, and a `{YYYY-MM-DD}`
	 * prefix crossing midnight (or an edit to the fields) between the two clicks
	 * would otherwise overwrite a different one than the user confirmed.
	 */
	let uploadExistsAffixes: { prefix: string; postfix: string } | null = null;

	/**
	 * The clock the PREVIEW resolves its date tokens against.
	 *
	 * It has to be reactive state, not a `new Date()` inside the derived: that one is
	 * captured whenever a dependency last changed and then never moves, so a panel
	 * left open across a date boundary previewed yesterday's name while the click
	 * (which resolves fresh, and must - the user uploading today wants today's date)
	 * sent today's. Preview == upload is the entire point of showing a preview, so the
	 * preview is what has to catch up.
	 *
	 * Refreshed on a coarse tick AND on wake, and the wake half is the one that
	 * matters: a laptop is far more often asleep across midnight than awake, and a
	 * suspended machine fires no timers. The tick only has to notice a date rollover,
	 * so a minute is ample; the tokens carry no time of day, so nothing finer is
	 * observable. Armed only while the section is EXPANDED (the panel stays mounted
	 * when it is folded away) and torn down with the component.
	 *
	 * The tick alone would still leave a gap on an AWAKE machine: for up to one
	 * interval after a rollover the preview names yesterday while the click resolves
	 * today. So `uploadToWorkspace` reads the clock once and moves this onto that same
	 * instant, which closes the gap without ever letting a stale preview decide what is
	 * uploaded.
	 */
	const UPLOAD_CLOCK_TICK_MS = 60_000;
	let uploadNow = $state(new Date());
	$effect(() => {
		if (!visible) return;
		// Catch up FIRST: reopening the section (or returning to the tab) is exactly the
		// moment the held value is most likely to be from another day.
		const wake = () => {
			uploadNow = new Date();
		};
		wake();
		const tick = setInterval(wake, UPLOAD_CLOCK_TICK_MS);
		window.addEventListener('focus', wake);
		document.addEventListener('visibilitychange', wake);
		return () => {
			clearInterval(tick);
			window.removeEventListener('focus', wake);
			document.removeEventListener('visibilitychange', wake);
		};
	});

	/** The open notebook's file name - what the workspace name is built from. */
	const uploadFileName = $derived(notebookPath ? (notebookPath.split(/[\\/]/).pop() ?? '') : '');
	/**
	 * The name this upload would land under, resolved live as the user types. The
	 * placeholder stands in only when no notebook is named (nothing to preview, but
	 * an unusable affix is still worth refusing); `uploadPreview` is what decides
	 * whether a name is actually shown.
	 */
	const uploadResolved = $derived(
		resolveUploadName(
			uploadFileName || 'notebook',
			{ prefix: uploadPrefix, postfix: uploadPostfix },
			uploadNow
		)
	);
	/** The final name to show before the click, or '' when the notebook is unnamed. */
	const uploadPreview = $derived(uploadFileName ? uploadResolved.name : '');
	/** Why the affixes cannot be used, or ''. Blocks the button rather than repairing them. */
	const uploadNameError = $derived(uploadResolved.error ?? '');
	/**
	 * Braced runs in either affix that are NOT date tokens, and so will upload exactly
	 * as typed.
	 *
	 * This is the reported bug's real shape: the vocabulary is small and
	 * case-sensitive, so `{YYYYMM}` (or `{MMDD}`, or `{yyyy}`) is a reasonable guess
	 * from someone who has seen `{YYYYMMDD}` work - and leaving it literal, which is
	 * the right thing to DO with it, previewed as `{YYYYMM}_analysis`, which reads as
	 * a token waiting to expand rather than one that never will. Naming it is the
	 * whole fix; nothing about the expansion rule changes.
	 *
	 * A WARNING, never a refusal: the name is legal and the literal braces may be
	 * meant. It also yields to `uploadNameError`, which blocks the upload outright -
	 * two messages about the same two fields at once is noise, and only one of them
	 * is the reason nothing can be sent.
	 */
	const uploadUnknownTokens = $derived(
		uploadNameError ? [] : unknownAffixTokens({ prefix: uploadPrefix, postfix: uploadPostfix }, uploadNow)
	);
	const uploadTokenWarning = $derived(
		unknownTokenWarning(uploadUnknownTokens, 'The dropdown beside each field lists the ones that expand.')
	);
	/** Ties that reason to both affix fields, so it is announced and not merely shown. */
	const uploadNameErrorId = $props.id();
	/**
	 * The token vocabulary, for the fields' tooltip. Each example is the token's REAL
	 * expansion against the same clock the preview uses, never a stored string - a
	 * literal example goes stale on the next New Year and then advertises a date the
	 * expander would never produce.
	 */
	const uploadTokenHelp = $derived(
		`Date tokens: ${UPLOAD_DATE_TOKENS.map((t) => `${t} → ${expandDateTokens(t, uploadNow)}`).join(', ')}. Anything else in braces stays literal.`
	);

	/**
	 * The generation guard for an upload, the same shape as `statusSeq` above and
	 * for the same reason: a reply that is no longer the newest word on its subject
	 * must not be applied. Here that is load-bearing rather than cosmetic - a stale
	 * reply arming the replace confirm would name a path belonging to a notebook the
	 * panel has since left, while Replace posts the CURRENT `notebookPath`, so the
	 * user would confirm one path and overwrite another. Bumped by every clear too,
	 * which is what makes Cancel (and the notebook-switch clear) authoritative
	 * against a request that is still in flight.
	 */
	let uploadSeq = 0;

	/**
	 * How many settled upload outcomes this panel has rendered.
	 *
	 * Bumped wherever a reply survives the guard above and becomes something on
	 * screen, so a DEFERRED affix seed can tell "the outcome I was waiting for has
	 * arrived" from "nothing happened while I waited" - the first must not be cleared
	 * away the instant it lands, the second is exactly what the clear is for. It is a
	 * different question from `uploadSeq`, which counts attempts and supersessions.
	 */
	let uploadFeedbackSeq = 0;

	/**
	 * Whether an upload can neither be started nor interrupted right now - the ONE
	 * owner of that rule, so every upload control (the plain button and both of the
	 * confirm box's) reads it instead of re-deriving it. Cancel shares Replace's
	 * condition rather than carrying its own: the overwrite request cannot be
	 * recalled once sent, so a Cancel that merely dismissed the box would present a
	 * replace that IS happening as one the user aborted - exactly the silent clobber
	 * this feature exists to prevent. While it is in flight the box stays mounted and
	 * the settled reply renders the outcome (the note with its path and link, or the
	 * error); with nothing in flight Cancel is live again - before the first click,
	 * and after a failed replace, so the box is never a dead end.
	 */
	const uploadConfirmBusy = $derived(!!busy || runtimeApplying);

	/** Drop the previous attempt's feedback: it describes one moment, not a standing state. */
	function clearUploadFeedback() {
		uploadSeq++;
		uploadError = null;
		uploadDone = null;
		uploadExistsPath = '';
		uploadExistsAffixes = null;
	}

	/**
	 * Reflect + persist an affix as it is typed, and drop the previous attempt's
	 * feedback: both the "uploaded to" note and the armed replace confirm name a
	 * workspace path built from the OLD affixes, so leaving them up would show a
	 * path this panel would no longer upload to. Persisted per project (the same
	 * `.cellar/` store as every other preference here, never `localStorage`) so a
	 * regular pattern survives a relaunch on a new port.
	 */
	function setUploadAffix(which: 'prefix' | 'postfix', v: string) {
		if (which === 'prefix') uploadPrefix = v;
		else uploadPostfix = v;
		// The literal string, EMPTY INCLUDED - see `storedAffix`. Deleting the key on an
		// empty field would read back as "this project never set one", so the global
		// default would re-seed it on the next load and undo the clearing.
		setUi(which === 'prefix' ? DBX_UPLOAD_PREFIX_KEY : DBX_UPLOAD_POSTFIX_KEY, v);
		clearUploadFeedback();
	}

	function onUploadAffixInput(which: 'prefix' | 'postfix', e: Event) {
		setUploadAffix(which, (e.currentTarget as HTMLInputElement).value);
	}

	/**
	 * The two affix inputs, so a token pick can be written AT THE CARET.
	 *
	 * The token dropdowns need the ELEMENT, not just the state: the insertion point is
	 * the caret, which only the DOM node knows, and the caret has to be put back after
	 * the write or a second pick would append to the end of what the first one
	 * inserted instead of continuing where the user was.
	 *
	 * There is no "which field was last focused" any more: each affix carries its OWN
	 * dropdown, so the target is named by the control rather than inferred from focus.
	 * That is what the per-field control buys beyond looks - the previous shared button
	 * row had to guess, and guessed wrong for anyone who reached for it before touching
	 * a field.
	 */
	let uploadPrefixEl = $state<HTMLInputElement | null>(null);
	let uploadPostfixEl = $state<HTMLInputElement | null>(null);

	/**
	 * Insert a date token into `which` affix, at that field's caret.
	 *
	 * The braces are what the expander recognises and they are easy to miss (the
	 * placeholder is the only other place they appear, and a placeholder disappears
	 * the moment anything is typed) - so the dropdown is how the syntax is LEARNED:
	 * picking an option writes the exact braced form, which the preview immediately
	 * resolves, and after seeing that once the user can type the rest by hand. Each
	 * option names its live expansion beside the token, so the vocabulary AND what it
	 * becomes are read together.
	 *
	 * The field keeps the TOKEN, never its expansion: it is a reusable pattern that
	 * persists between sessions, so a field holding today's literal date would upload
	 * under a stale name tomorrow - the one failure the tokens exist to prevent.
	 *
	 * INSERT rather than replace, which is what keeps the field "fully editable by
	 * hand": a pick lands beside whatever is already typed (`{YYYY-MM}` then `_` then
	 * `{DD}`), and an affix built entirely by hand is never overwritten by reaching for
	 * one token.
	 */
	function insertUploadDateToken(which: 'prefix' | 'postfix', token: string) {
		if (uploadConfirmBusy || !token) return;
		insertTokenIntoField(
			which === 'prefix' ? uploadPrefixEl : uploadPostfixEl,
			which === 'prefix' ? uploadPrefix : uploadPostfix,
			token,
			(value) => setUploadAffix(which, value)
		);
	}

	/**
	 * A token COMMITTED from an affix's dropdown, by whichever gesture committed it.
	 *
	 * The select is an ACTION, not a value: it holds no state of its own, so it is
	 * reset to its placeholder immediately. Without that reset the same token could not
	 * be picked twice in a row (no `change` fires when the value does not move), and
	 * the closed control would sit there reading like a setting - claiming one token is
	 * "the" affix while the field beside it says otherwise.
	 *
	 * Reading the token BEFORE that reset is the load-bearing order: reversed, `token`
	 * is the empty placeholder and every pick silently does nothing. It is also what
	 * makes a commit IDEMPOTENT - a second one in the same gesture reads the blanked
	 * value and returns - which is what lets the two commit paths below overlap in the
	 * browsers where they both fire.
	 */
	function commitUploadToken(which: 'prefix' | 'postfix', el: HTMLSelectElement) {
		const token = el.value;
		el.value = '';
		insertUploadDateToken(which, token);
	}

	/**
	 * Whether a key that moves a CLOSED select's own value is being handled right now.
	 *
	 * A `change` is NOT by itself a pick. On Windows and Linux, arrowing over a closed
	 * select changes its value and fires `change` on every press, so a keyboard user
	 * who merely tabs to this control and presses Down would insert a token they never
	 * chose - a real regression from the row of buttons this replaced, which only ever
	 * acted on Enter or Space. So a token is inserted only on an EXPLICIT pick.
	 *
	 * The discriminator is that a browser dispatches key events to the page only while
	 * its option list is CLOSED: once the list is open (macOS always, elsewhere via
	 * Alt+Down/F4/Space) the keystrokes belong to it, and the `change` that ends it
	 * arrives with no keydown of ours in the same task. So a `change` that lands in the
	 * same task as a key we saw is that key moving a closed select, and is ignored;
	 * anything else - a mouse pick, a commit out of an open list, assistive technology
	 * setting the value - is a pick. The flag is therefore cleared on the next task,
	 * never held across one: kept sticky it would swallow the genuine pick that follows
	 * the Down which OPENED the list, i.e. it would make the control unusable by
	 * keyboard, which is worse than the surprise being fixed here.
	 *
	 * Enter is the other half, and the one that keeps the closed-select flow usable:
	 * having arrowed to a token the user commits it, exactly as they always could.
	 *
	 * Shared by both dropdowns deliberately - the window is one task, so no user can
	 * have a keystroke in one and a commit in the other inside it.
	 */
	let uploadTokenKeyNav = false;

	function onUploadTokenKeydown(which: 'prefix' | 'postfix', e: KeyboardEvent) {
		if (e.key === 'Enter') {
			commitUploadToken(which, e.currentTarget as HTMLSelectElement);
			return;
		}
		uploadTokenKeyNav = true;
		setTimeout(() => (uploadTokenKeyNav = false), 0);
	}

	function onUploadTokenChange(which: 'prefix' | 'postfix', e: Event) {
		if (uploadTokenKeyNav) return;
		commitUploadToken(which, e.currentTarget as HTMLSelectElement);
	}

	/**
	 * Leaving the control without committing discards what was arrowed past, so the
	 * closed select is back to its placeholder rather than sitting there naming a token
	 * that was never inserted - the same reason a commit resets it.
	 */
	function onUploadTokenBlur(e: FocusEvent) {
		(e.currentTarget as HTMLSelectElement).value = '';
	}

	/**
	 * Upload the open notebook into the connected user's own workspace folder as a
	 * cells-intact Databricks notebook.
	 *
	 * `overwrite` is never implicit: the first click asks for it without it, and a
	 * notebook already at that path comes back as `exists` (nothing written) so the
	 * user gets a Replace confirm rather than a silent clobber.
	 *
	 * Date tokens are expanded HERE, once, and the resulting literal text is what is
	 * sent - so the name the workspace receives is exactly the one the preview showed
	 * (the server's own expansion finds nothing left to expand). `pinned` is how a
	 * Replace re-uses the affixes its confirm was armed with instead of re-resolving
	 * them: the box names a path, and that must be the path that gets overwritten.
	 *
	 * The clock is read FRESH here and the preview is moved onto that same instant -
	 * one read, used twice - so the two cannot disagree even in the window between
	 * ticks right after a date rollover. The direction matters: the preview catches up
	 * to the click, never the reverse, because someone uploading today must get today's
	 * date whatever the panel has been showing.
	 */
	async function uploadToWorkspace(overwrite = false, pinned?: { prefix: string; postfix: string }) {
		if (busy) return;
		let affixes = pinned;
		if (!affixes) {
			const now = new Date();
			uploadNow = now;
			const resolved = resolveUploadName(
				uploadFileName || 'notebook',
				{ prefix: uploadPrefix, postfix: uploadPostfix },
				now
			);
			if (resolved.error) {
				// Refused, not repaired: a silently sanitized affix would upload under a
				// name the preview never showed. Nothing is sent.
				uploadError = { code: 'bad_request', message: resolved.error };
				return;
			}
			affixes = { prefix: resolved.prefix, postfix: resolved.postfix };
		}
		busy = 'upload';
		const seq = ++uploadSeq;
		const target = notebookPath;
		// The previous attempt's outcome is stale the moment a new one starts, but the
		// pending replace confirm deliberately STAYS: it names the path being
		// overwritten, which is exactly what the user must keep seeing while the
		// replace runs. It is torn down below, once this attempt settles.
		uploadError = null;
		uploadDone = null;
		try {
			const res = await fetch('/api/databricks/upload', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ path: target ?? undefined, overwrite, ...affixes })
			});
			const body = await res.json();
			// Superseded - the panel moved to another notebook, or the user cancelled.
			// This reply describes a file the panel no longer names, so NOTHING of it is
			// written: an armed confirm would overwrite on behalf of a different notebook.
			if (seq !== uploadSeq || target !== notebookPath) return;
			uploadFeedbackSeq++;
			if (!res.ok) throw body;
			const out = body as { status?: string; path?: string; url?: string | null; overwritten?: boolean };
			if (out.status === 'exists') {
				uploadExistsPath = out.path ?? '';
				// Pin what produced that path, so Replace overwrites THIS one - not a name
				// a later keystroke (or a date token crossing midnight) would resolve to.
				uploadExistsAffixes = affixes;
				return;
			}
			uploadExistsPath = '';
			uploadExistsAffixes = null;
			uploadDone = {
				headline: out.overwritten
					? 'Replaced in your Databricks workspace:'
					: 'Uploaded to your Databricks workspace:',
				path: out.path ?? '',
				url: out.url ?? ''
			};
		} catch (err) {
			if (seq !== uploadSeq || target !== notebookPath) return;
			uploadFeedbackSeq++;
			// A failed replace must not strand the user inside a confirm box whose
			// Replace button just failed: drop back to the plain button, with the error.
			uploadExistsPath = '';
			uploadExistsAffixes = null;
			uploadError = toDbxError(err);
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
		clearUploadFeedback();
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

	/**
	 * Keyed on the WORKSPACE, never the cluster - which is what the listing actually
	 * depends on: `connectionParams()` sends `profile`/`host` and no cluster at all,
	 * so two clusters in one workspace have byte-identical trees. With `clusterId` in
	 * the key a cluster SWITCH tore the whole tree down (`nodes`/`openNodes` are
	 * dropped by `loadCatalogs`), flashed "loading catalogs…" and rebuilt the same
	 * list - the second contributor to the switch flicker, and it also silently threw
	 * away every catalog the user had expanded. A real workspace change (picking
	 * another profile, or a host) still changes the key and still reloads.
	 */
	$effect(() => {
		const key = connected ? (connection.profile ?? connection.host ?? '') : null;
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
	//
	// The DBR is dropped while the card wears its connecting face: it is a property of
	// the session, so during a switch it is the OUTGOING cluster's runtime rendered
	// directly under an identity row that already reads "Connecting to <new cluster>…"
	// - the same stale claim the `spark`/`w`-are-ready line was swapped out to avoid.
	// The workspace half (profile · host) is what the connect targets and survives, so
	// the line stays one line and the card keeps its height.
	const connMeta = $derived(
		[
			connection.profile,
			connection.host ? connection.host.replace(/^https?:\/\//, '') : null,
			panel.connecting ? null : connection.sparkVersion
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
		busy: 'Another Databricks operation is still running.',
		workspace_conflict: 'Something that is not a notebook already occupies that path in your workspace. Nothing was uploaded.',
		notebook_too_large: 'This notebook is too large for a Databricks workspace import. Run “Clear all outputs” from the command palette, then upload again - the outputs are what make it this large.'
	};

	/**
	 * The profile a `profile_reauth_required` failure is about - the name the SERVER
	 * resolved for the auth that actually failed, or '' when it did not name one.
	 *
	 * Deliberately NOT falling back to the picker's current selection: that is a
	 * different question ("what is the user looking at"), so it can name the wrong
	 * profile in the reconnect box (the dead session may be on another one) or be
	 * empty while connected, rendering `databricks auth login --profile ` for the
	 * copy button to hand over verbatim. Every server path that raises this code
	 * sets the name, so this fails closed on a shape that should not exist: no
	 * name, no command.
	 */
	function reauthProfile(err: DbxError): string {
		return (err.profile ?? '').trim();
	}

	/**
	 * Is this error the SAME expired-profile fact the card's session box already
	 * spells out in full?
	 *
	 * One expired profile fails every operation that touches it at once - the
	 * session heal, the cluster listing behind the picker, an explicit Reconnect -
	 * so a card would stack two or three identical explanation+command+copy boxes.
	 * The session box (`connection.reauth`) is the one that survives; the rest are
	 * suppressed by `errorBox` itself, so no call site has to remember the rule.
	 *
	 * Matching is strict: same code AND same named profile. A non-reauth failure is
	 * a different fact with a different remedy and always renders, and two DIFFERENT
	 * profiles need two different commands - so anything unproven falls through and
	 * shows, since a hidden real error is far worse than a repeated one.
	 */
	function duplicatesSessionReauth(err: DbxError): boolean {
		const session = connection?.reauth;
		if (!session || session.code !== PROFILE_REAUTH_CODE || err.code !== PROFILE_REAUTH_CODE) return false;
		const name = reauthProfile(err);
		return !!name && name === reauthProfile(session);
	}

	// Copy-the-command affordance shared by the two places Cellar hands the user a
	// terminal command rather than running it (the re-auth box, and the
	// default-profile card) - the same idiom as the sidebar's "Connect an agent"
	// panel. Keyed by the caller's own `key`, NOT its testid: a testid is a
	// SELECTOR, not an identity - `databricks-node-error` is rendered once per
	// catalog-tree node, and one expired profile fails every one of them at once, so
	// keying the tick off it flipped the checkmark in every sibling box. The
	// default-profile card renders one row PER PROFILE for the same reason, so each
	// row likewise passes a key unique to it.
	let copiedCommand = $state('');
	let copyCommandTimer: ReturnType<typeof setTimeout>;
	async function copyCommand(key: string, text: string) {
		try {
			await navigator.clipboard.writeText(text);
			copiedCommand = key;
			clearTimeout(copyCommandTimer);
			copyCommandTimer = setTimeout(() => (copiedCommand = ''), 1400);
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
	<p class="text-[11px] font-medium leading-relaxed text-base-content/80" data-testid="{testid}-explain">
		{reauthExplanation(name || null)}
	</p>
	<!-- No profile name, no command row: a guessed name is a command that
	     re-authenticates the wrong profile (or none at all), and the copy button
	     would hand it over verbatim. -->
	{#if name}
		{@const command = reauthCommand(name)}
		<!-- The command WRAPS rather than truncating: in a ~200px box the tail is the
		     profile name, i.e. the one part of it the user must read. The flag is held
		     in a no-wrap span because a browser breaks after a hyphen, which split
		     `--profile` into `-` / `-profile` - a command a reader could mistype. -->
		<div class="mt-1.5 flex items-start gap-1 rounded-md border border-base-300 bg-base-100 p-1">
			<code class="min-w-0 flex-1 px-1 py-0.5 font-mono text-[11px] leading-snug text-primary [overflow-wrap:break-word]" title={command} data-testid="{testid}-command">{REAUTH_COMMAND_HEAD} <span class="whitespace-nowrap">{REAUTH_PROFILE_FLAG}</span> {name}</code>
			<button
				class="btn btn-ghost btn-xs btn-square shrink-0 text-base-content/50 hover:text-base-content"
				onclick={() => copyCommand(key, command)}
				title="Copy command"
				aria-label="Copy command"
				data-testid="{testid}-copy"
			>
				{#if copiedCommand === key}
					<svg class="h-3.5 w-3.5 text-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
				{:else}
					<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
				{/if}
			</button>
		</div>
	{/if}
{/snippet}

<!--
  `testid` is the SELECTOR (deliberately repeated across the catalog tree's node
  boxes, which tests address as one); `key` is the box's IDENTITY, used only for
  per-box UI state like the copy tick. They coincide everywhere a box is rendered
  once, so `key` defaults to the testid; a box inside an `{#each}` must pass its
  own.
-->
{#snippet errorBox(err: DbxError, testid: string, key: string = testid)}
	{#if !duplicatesSessionReauth(err)}
		{@render errorBody(err, testid, key)}
	{/if}
{/snippet}

<!-- The box itself. Rendered through `errorBox` everywhere except the session
     re-auth box, which is the ONE copy the de-dupe keeps. -->
{#snippet errorBody(err: DbxError, testid: string, key: string)}
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

<!--
  The expired-profile box on the CONNECTION cards. The server attaches `reauth` to
  every not-live shape, because a self-heal that fails drops the panel back to the
  picker - whose "Sign in with Databricks" button is exactly the dead end here - so
  the explanation has to travel with the state, not only with a click on Reconnect.
  Rendered inside one branch at a time, so its testid stays unique in the DOM.

  Goes through `errorBody` directly, NOT `errorBox`: this is the copy the de-dupe
  keeps, so it must not suppress itself.
-->
{#snippet sessionReauthBox()}
	{#if connection?.reauth}
		{@render errorBody(connection.reauth, 'databricks-session-error', 'databricks-session-error')}
	{/if}
{/snippet}

<!--
  Silent inertness, made loud. With the runtime advertised, code that does
  `from databricks.sdk.runtime import dbutils` normally reaches Cellar's shim; when
  it does not, the SDK's own object renders the same controls and throws every
  entered value away on the next re-declaration, so nothing on screen says the
  parameters are dead.

  Rendered on EVERY card state (connected via the Runtime card, and the expired /
  lost / picker Cluster cards) exactly as `agentStatus` folds the same sentence
  into every shape it returns: the shim is installed on every kernel and the
  runtime env is read at kernel start, so a session whose cluster connection has
  expired or was never made still has dead widgets. The human and the agent must
  agree - that parity is why `dbutilsShim.ts` exists. One branch shows at a time,
  so the testid stays unique in the DOM.

  Warning-TINTED with `base-content` copy, never `text-warning` body text (amber on
  amber is ~2:1 on the light card).
-->
{#snippet sdkDbutilsWarning()}
	{#if runtimeSdkForeign}
		<p
			class="mt-1.5 rounded border border-warning/40 bg-warning/10 px-2 py-1.5 text-[11px] leading-relaxed text-base-content/80"
			data-testid="databricks-runtime-sdk-warning"
		>
			{SDK_DBUTILS_FOREIGN_WARNING}
		</p>
	{/if}
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

<!--
  The date-token picker for ONE affix field.

  A dropdown rather than the row of chips this replaced, for two reasons beyond
  looks. It is PER FIELD, so the target is named by the control instead of
  inferred from "the field you were last in" - which guessed wrong for anyone who
  reached for a token before touching a field. And it scales with the vocabulary:
  seven chips already wrapped to three lines in a narrow sidebar, ahead of the
  Upload button they were pushing off screen.

  It is an ACTION, not a value: `commitUploadToken` resets it the instant it
  fires, so the closed control never reads as a setting and the same token can be
  picked twice running. The affix stays free text throughout - a pick INSERTS at
  the caret, so it composes with whatever is typed and never overwrites it.

  A token is inserted only on an EXPLICIT pick, never on the bare `change` a
  closed select fires per arrow key on Windows and Linux - see
  `uploadTokenKeyNav`.

  Driven off `UPLOAD_DATE_TOKENS` with each expansion computed live, so what is
  offered - and what it claims to become - cannot drift from what the expander does.
-->
{#snippet tokenSelect(which: 'prefix' | 'postfix')}
	<!-- `min-w-0` is load-bearing, not tidiness: daisyUI gives `.select` a 10rem
	     min-width, which at the sidebar's narrower widths won the flex row outright and
	     squeezed the affix input beside it to zero. The explicit width is what the
	     placeholder needs and nothing more; the field keeps the rest of the row. -->
	<select
		class="select select-xs select-bordered h-5 w-[4.75rem] min-h-0 min-w-0 shrink-0 py-0 pe-5 ps-1.5 text-[10px] text-base-content/60"
		value=""
		onchange={(e) => onUploadTokenChange(which, e)}
		onkeydown={(e) => onUploadTokenKeydown(which, e)}
		onblur={onUploadTokenBlur}
		disabled={uploadConfirmBusy}
		title={uploadTokenHelp}
		aria-label="Insert a date token into the {which}"
		data-testid="databricks-upload-token-select"
		data-affix={which}
	>
		<option value="">token</option>
		{#each UPLOAD_DATE_TOKENS as token (token)}
			<option value={token} data-testid="databricks-upload-token" data-token={token}>
				{token} → {expandDateTokens(token, uploadNow)}
			</option>
		{/each}
	</select>
{/snippet}

<!--
  Copy the open notebook into the connected user's own workspace folder
  (/Users/<you>/) as a real Databricks notebook.

  Its OWN card, beside the Cluster and Runtime cards rather than tucked under
  Switch/Disconnect: it is a workspace-FILES action - it never starts, stops or
  restarts a cluster - and it carries its own inputs, preview and two-step replace
  confirm, which inside the connection card read as more connection controls.

  Still rendered only while CONNECTED: the upload authenticates as the live
  connection's own identity, so without one there is no user folder to resolve
  and nothing to upload as.

  Overwriting is a second, deliberate click. The first attempt sends no
  overwrite flag; a notebook already at that path comes back untouched as
  `exists`, which arms this confirm.
-->
{#snippet uploadCard()}
	<div class="rounded-lg border border-base-300 bg-base-100 p-2.5" data-testid="databricks-upload-card">
		{@render cardLabel('upload')}
		<!-- Optional affixes around the notebook's own name, with the resolved name shown
		     BEFORE the click: the preview and the upload resolve through the one shared
		     `resolveUploadName`, so what is read here is what lands in the workspace.
		     Both empty is the original behaviour - `/Users/<you>/<notebook>`. -->
		<div class="mt-1.5 space-y-1.5">
			<!-- The dropdown is a SIBLING of the label, not inside it: a label takes its
			     first labelable descendant, so nesting both would leave the select silently
			     unassociated while looking associated. It carries its own `aria-label`. -->
			<div class="flex items-end gap-1">
				<label class="block min-w-0 flex-1">
					<span class="text-[10px] text-base-content/50">Prefix</span>
					<input
						bind:this={uploadPrefixEl}
						use:tokenField
						class="input input-xs input-bordered mt-0.5 h-5 min-h-0 w-full py-0 font-mono text-[10px]"
						value={uploadPrefix}
						oninput={(e) => onUploadAffixInput('prefix', e)}
						disabled={uploadConfirmBusy}
						placeholder="{'{YYYY-MM-DD}'}_"
						title={uploadTokenHelp}
						aria-invalid={!!uploadNameError}
						aria-describedby={uploadNameError ? uploadNameErrorId : undefined}
						data-testid="databricks-upload-prefix"
					/>
				</label>
				{@render tokenSelect('prefix')}
			</div>
			<div class="flex items-end gap-1">
				<label class="block min-w-0 flex-1">
					<span class="text-[10px] text-base-content/50">Postfix</span>
					<input
						bind:this={uploadPostfixEl}
						use:tokenField
						class="input input-xs input-bordered mt-0.5 h-5 min-h-0 w-full py-0 font-mono text-[10px]"
						value={uploadPostfix}
						oninput={(e) => onUploadAffixInput('postfix', e)}
						disabled={uploadConfirmBusy}
						placeholder="_{'{YYYYMMDD}'}"
						title={uploadTokenHelp}
						aria-invalid={!!uploadNameError}
						aria-describedby={uploadNameError ? uploadNameErrorId : undefined}
						data-testid="databricks-upload-postfix"
					/>
				</label>
				{@render tokenSelect('postfix')}
			</div>
		</div>
		{#if uploadNameError}
			<!-- Linked to BOTH fields, not merely rendered beside them: the refusal disables
			     the button, so a reader tabbing off the field lands on a control that says
			     nothing, and this sentence is the whole reason the upload did not happen. -->
			<p
				id={uploadNameErrorId}
				class="mt-1 text-[11px] leading-relaxed text-error"
				data-testid="databricks-upload-name-error"
			>
				{uploadNameError}
			</p>
		{:else if uploadPreview}
			<p class="mt-1 text-[10px] leading-snug text-base-content/50">
				Uploads as
				<span class="font-mono text-base-content/70 [overflow-wrap:anywhere]" data-testid="databricks-upload-preview"
					>{uploadPreview}</span
				>
			</p>
		{/if}
		{#if uploadTokenWarning}
			<!-- Says what the preview alone could not: this brace is never going to become a
			     date. It sits directly under the preview that shows it landing literally, and
			     names the dropdowns beside the fields as the remedy - and it stays a WARNING,
			     because the name is legal and `{FOO}` may be exactly what someone means. -->
			<p
				class="mt-1 text-[10px] leading-snug text-warning"
				role="status"
				data-testid="databricks-upload-token-warning"
			>
				{uploadTokenWarning}
			</p>
		{/if}
		<!-- That the tokens EXIST, and that the braces are part of them, stays VISIBLE rather
		     than living only inside the dropdown or a `title`: the reported failure was
		     someone who had seen a token work reasonably guessing a spelling that does not
		     exist, and neither a tooltip nor a closed select is something anyone finds
		     before typing. The vocabulary itself is one click away in the dropdown beside
		     each field (which is also where each token's live expansion is spelled out), and
		     both fields remain free text - the dropdown adds a token, it never owns the
		     value. The preview above is the live worked example, which is why there is no
		     second one spelled out down here.

		     It YIELDS to the token warning, exactly as that warning yields to
		     `uploadNameError`: the warning names the same dropdown as the remedy, so both
		     at once is one sentence of standing advice restating the specific one directly
		     above it - and it is the specific one the user needs to read. -->
		{#if !uploadTokenWarning}
			<p class="mt-1 text-[10px] leading-snug text-base-content/50" data-testid="databricks-upload-token-hint">
				Type any name. Date tokens (braces needed) are in the dropdown beside each field.
			</p>
		{/if}
		<div class="mt-1.5">
			{#if uploadExistsPath}
				<div class="rounded border border-warning/40 bg-warning/10 px-2 py-1.5" data-testid="databricks-upload-confirm-box">
					<p class="text-[11px] leading-relaxed text-base-content/80">A notebook already exists in your workspace at</p>
					<p class="font-mono text-[10px] leading-snug text-base-content/70 [overflow-wrap:anywhere]">{uploadExistsPath}</p>
					<p class="mt-1 text-[11px] leading-relaxed text-base-content/80">
						Replacing it overwrites that notebook in Databricks - its cells and outputs are lost.
					</p>
					<div class="mt-1.5 flex justify-end gap-1">
						<button
							class="btn btn-ghost btn-xs h-5 min-h-0 px-1.5 text-[11px] font-normal text-base-content/60"
							onclick={clearUploadFeedback}
							disabled={uploadConfirmBusy}
							data-testid="databricks-upload-cancel"
						>
							Cancel
						</button>
						<button
							class="btn btn-warning btn-xs h-5 min-h-0 px-1.5 text-[11px]"
							onclick={() => uploadToWorkspace(true, uploadExistsAffixes ?? undefined)}
							disabled={uploadConfirmBusy}
							data-testid="databricks-upload-replace"
						>
							{#if busy === 'upload'}<span class="loading loading-spinner loading-xs"></span>Replacing…{:else}Replace{/if}
						</button>
					</div>
				</div>
			{:else}
				<button
					class="btn btn-outline btn-xs w-full"
					onclick={() => uploadToWorkspace(false)}
					disabled={!connected || uploadConfirmBusy || !!uploadNameError}
					title="Copy this notebook into /Users/<you>/ in the connected Databricks workspace"
					data-testid="databricks-upload"
				>
					{#if busy === 'upload'}<span class="loading loading-spinner loading-xs"></span>Uploading…{:else}Upload notebook to workspace{/if}
				</button>
			{/if}
		</div>
		{#if uploadDone}
			<div class="mt-1.5 text-[11px] leading-relaxed text-base-content/70" data-testid="databricks-upload-note">
				<p>{uploadDone.headline}</p>
				<!-- Its own line, in mono: the path is the answer to "where did it go", and in
				     this width it cannot share a line with prose without breaking mid-segment. -->
				<p class="font-mono text-[10px] text-base-content/60 [overflow-wrap:anywhere]">{uploadDone.path}</p>
				{#if uploadDone.url}
					<a class="link link-primary" href={uploadDone.url} target="_blank" rel="noreferrer noopener" data-testid="databricks-upload-link">Open in Databricks</a>
				{/if}
			</div>
		{/if}
		{#if uploadError}{@render errorBox(uploadError, 'databricks-upload-error')}{/if}
	</div>
{/snippet}

{#snippet cardLabel(text: string)}
	<span class="text-[10px] font-semibold uppercase tracking-wide text-base-content/40">{text}</span>
{/snippet}

<!--
  A heads-up, not an error: this machine's `~/.databrickscfg` marks no profile as
  the default, so anything in the kernel that resolves Databricks credentials for
  ITSELF finds none. Cellar's own connection passes its profile explicitly and is
  unaffected - which is exactly why this is worth saying out loud, since `spark`
  working while the user's own `import` dies reads as a Cellar bug and is not one.

  Toned as information, deliberately: `border-base-300 bg-base-100` like every
  other card here, with the only colour on the small info glyph. The error/warning
  tints in this panel mean "something you were doing failed"; nothing failed here.

  It is gated on the server's `needsDefault`, which is already false when there is
  no profile to offer, AND on this kernel having really run CONNECT_CODE - connected
  or expired - which is where its DATABRICKS_* env has provably been scrubbed and the
  config file is therefore the whole answer. So it can never nag a machine it has no
  advice for, nor one whose credentials resolve from the environment (see
  `needsDefaultProfile`). Every candidate gets its OWN command row rather than a
  picker with a pre-selected
  value: which profile becomes the machine-wide default is the user's call, so
  nothing here is preferred for them, and the list IS the choice (which is also why
  it is not truncated - hiding a candidate could hide the only one they wanted).

  Cellar shows the command and does not run it. See `$lib/databricksDefaultProfile`
  for that decision; the short version is that Cellar never shells out to the
  `databricks` CLI and never writes the user's credential config.
-->
{#snippet defaultProfileCard(v: DefaultProfileVerdict)}
	<div class="rounded-lg border border-base-300 bg-base-100 p-2.5" data-testid="databricks-default-profile">
		<div class="flex items-center gap-1.5">
			<svg class="h-3 w-3 shrink-0 text-info" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></svg>
			{@render cardLabel('default profile')}
		</div>
		<p class="mt-1.5 text-[11px] font-medium leading-relaxed text-base-content/80" data-testid="databricks-default-profile-problem">
			{defaultProfileProblem(v)}
		</p>
		<p class="mt-1 text-[11px] leading-relaxed text-base-content/55" data-testid="databricks-default-profile-consequence">
			{DEFAULT_PROFILE_CONSEQUENCE}
		</p>
		<p class="mt-2 text-[11px] leading-relaxed text-base-content/70">{DEFAULT_PROFILE_REMEDY}</p>
		<div class="mt-1 space-y-1">
			{#each v.candidates as name (name)}
				{@const command = switchDefaultProfileCommand(name)}
				<!-- Wraps rather than truncates: the tail is the profile name, i.e. the one
				     part the user must read. The flag sits in a no-wrap span because a
				     browser breaks after a hyphen, splitting `--profile` into `-` /
				     `-profile` - a command a reader could mistype. -->
				<div class="flex items-start gap-1 rounded-md border border-base-300 bg-base-200/40 p-1">
					<code class="min-w-0 flex-1 px-1 py-0.5 font-mono text-[11px] leading-snug text-primary [overflow-wrap:break-word]" title={command} data-testid="databricks-default-profile-command">{SWITCH_COMMAND_HEAD} <span class="whitespace-nowrap">{SWITCH_PROFILE_FLAG}</span> {name}</code>
					<button
						class="btn btn-ghost btn-xs btn-square shrink-0 text-base-content/50 hover:text-base-content"
						onclick={() => copyCommand(`default-profile:${name}`, command)}
						title="Copy command"
						aria-label="Copy command for profile {name}"
						data-testid="databricks-default-profile-copy"
					>
						{#if copiedCommand === `default-profile:${name}`}
							<svg class="h-3.5 w-3.5 text-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
						{:else}
							<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
						{/if}
					</button>
				</div>
			{/each}
		</div>
	</div>
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
			<!-- Behavior consequence, stated because the OLD behavior restarted the kernel
			     here: connecting binds spark/w in the running kernel and does not enable
			     the Databricks runtime. The variables-kept claim is QUALIFIED, not
			     absolute: `ensurePinnedConnect` still restarts the kernel when
			     databricks-connect has to be re-pinned to the cluster's runtime (the
			     common shape being a switch to an older-DBR cluster), which is the same
			     side effect the agent tool reports as `namespace_cleared`. -->
			<p class="mt-1.5 flex items-start gap-1 text-[11px] leading-relaxed text-base-content/40" data-testid="databricks-connect-note">
				<svg class="mt-px h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" /></svg>
				<span>Connecting binds <code class="font-mono text-[10px]">spark</code> and <code class="font-mono text-[10px]">w</code> in the running kernel - your variables are kept, unless the client has to be re-pinned to the cluster's runtime (that restarts the kernel).</span>
			</p>
		{:else if clusters}
			<p class="px-2 py-2 text-xs text-base-content/40">no clusters in this workspace</p>
		{/if}
	{/if}

	{#if connectError}{@render errorBox(connectError, 'databricks-connect-error')}{/if}
{/snippet}

<!-- The Runtime card: advertise DATABRICKS_RUNTIME_VERSION so this notebook's
     runtime-gated code takes its dbutils.widgets path. A separate card from the
     connection, default OFF and applied LIVE - toggling (or a version edit) restarts
     the kernel to take effect immediately, and is the ONLY thing that does (a
     connect no longer restarts). Green (toggle-success) is a deliberate Databricks
     cue, unlike Files' primary toggle.

     The TOGGLE shows the stored preference (that is what the user sets); the state
     pill and the hint show what the LIVE kernel session actually carries. They can
     honestly differ - the env is read at import time - and that difference IS the
     "restart to apply" signal, so it is named rather than papered over. -->
{#snippet runtimeCard()}
	<div class="rounded-lg border border-base-300 bg-base-100 p-2.5" data-testid="databricks-runtime-card">
		<div class="flex items-center justify-between gap-2">
			{@render cardLabel('runtime')}
			{#if runtimeApplying}
				<span class="flex items-center gap-1 text-[10px] text-base-content/40" data-testid="databricks-runtime-applying">
					<span class="loading loading-spinner loading-xs"></span>restarting…
				</span>
			{:else if runtimeActive}
				<span class="flex items-center gap-1 text-[10px] uppercase tracking-wide text-success" data-testid="databricks-runtime-active">
					<span class="inline-block h-1.5 w-1.5 rounded-full bg-success"></span>active
				</span>
			{:else if runtimePending}
				<!-- The preference is on but this kernel session was started without the
				     env (import-time gate), so the pill must NOT say active. -->
				<span
					class="flex items-center gap-1 text-[10px] uppercase tracking-wide text-warning"
					data-testid="databricks-runtime-pending"
					title={!runtimeKernelStarted
						? 'No kernel is running yet; it will start with the Databricks runtime.'
						: runtimeEnvControlled
							? 'The environment advertises the Databricks runtime; this kernel started before that took effect.'
							: 'The running kernel was started without the Databricks runtime. Restart it to apply.'}
				>
					<span class="inline-block h-1.5 w-1.5 rounded-full bg-warning"></span>pending
				</span>
			{:else}
				<span class="text-[10px] uppercase tracking-wide text-base-content/30" data-testid="databricks-runtime-inactive">off</span>
			{/if}
		</div>
		<!-- The toggle shows what is IN FORCE (the override when there is one), and is
		     disabled wherever flipping it cannot do its work: under an env override (which
		     no toggle or restart can change) and with no notebook to restart (where the
		     restart is silently skipped). A switch that quietly changes nothing is worse
		     than one that says who is holding it. -->
		<label
			class="mt-1.5 flex items-center gap-2 text-[11px] text-base-content/70"
			class:cursor-pointer={!runtimeEnvControlled && runtimeRestartable}
			title={runtimeEnvControlled
				? 'Set by the CELLAR_DATABRICKS_RUNTIME environment variable, which overrides this setting.'
				: !runtimeRestartable
					? 'Open a notebook to restart its kernel and apply this setting.'
					: 'Makes this kernel look like a Databricks cluster, so notebook code that checks whether it is running on Databricks takes its dbutils.widgets path. Affects all libraries (e.g. mlflow) and restarts the kernel to apply. It does not connect a cluster - use Databricks Connect for spark/Unity Catalog.'}
		>
			<input
				type="checkbox"
				class="toggle toggle-xs toggle-success"
				checked={runtimeEffectiveOn}
				onchange={toggleRuntime}
				disabled={runtimeApplying || !!busy || runtimeEnvControlled || !runtimeRestartable}
				data-testid="databricks-runtime-toggle"
			/>
			<span>Databricks runtime (<code class="font-mono text-[10px]">dbutils.widgets</code>)</span>
		</label>
		{#if runtimeEffectiveOn}
			<!-- Under CELLAR_DATABRICKS_RUNTIME_VERSION the field shows the version really in
			     force and takes no edits: committing one would restart the kernel - clearing
			     the namespace - to advertise a value the override discards. Same for a missing
			     notebook, where the apply-restart is skipped outright. -->
			<label class="mt-1.5 flex items-center gap-2 text-[11px] text-base-content/50">
				<span class="shrink-0">version</span>
				<input
					type="text"
					class="input input-xs input-bordered h-5 min-h-0 w-20 py-0 font-mono text-[10px]"
					value={runtimeVersionEnvControlled ? runtimeEffectiveVersion : runtimeVersion}
					oninput={onVersionInput}
					onchange={commitVersion}
					onkeydown={(e) => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur(); }}
					placeholder={DBX_RUNTIME_VERSION_DEFAULT}
					disabled={runtimeApplying || runtimeVersionEnvControlled || !runtimeRestartable}
					title={runtimeVersionEnvControlled
						? 'Set by the CELLAR_DATABRICKS_RUNTIME_VERSION environment variable, which overrides this setting.'
						: !runtimeRestartable
							? 'Open a notebook to restart its kernel and apply a version change.'
							: undefined}
					data-testid="databricks-runtime-version"
				/>
			</label>
		{/if}
		<!-- Says what the RUNNING kernel does, not what the preference asks for: the
		     env is read at import time, so a preference the current session predates
		     is pending, not active. An env-forced decision is stated as such: a restart
		     cannot change it, so the copy must not send the user after one. The same rule
		     covers a missing notebook - the restart is skipped there, so the copy may not
		     claim variables were cleared by one. The version override is named separately,
		     since it can be in force on its own. -->
		<p class="mt-1.5 text-[11px] leading-relaxed text-base-content/40">
			{#if runtimeEnvControlled}
				{#if runtimeActive}
					Notebook code that checks for Databricks takes its Databricks path.
				{:else if runtimePending}
					Applies when this notebook's kernel starts; until then notebook code takes its non-Databricks path.
				{:else}
					Notebook code runs its non-Databricks path.
				{/if}
				Controlled by the <code class="font-mono text-[10px]">CELLAR_DATABRICKS_RUNTIME</code> environment variable, not by this
				toggle - change it where Cellar is launched.
			{:else if runtimeActive}
				Notebook code that checks for Databricks takes its Databricks path.
				{#if runtimeRestartable}
					Toggling restarts the kernel - variables are cleared.
				{:else}
					Open a notebook to change it - that restarts its kernel and clears variables.
				{/if}
			{:else if runtimePending && runtimeKernelStarted}
				The running kernel was started without it, so notebook code still takes its non-Databricks path.
				{#if runtimeRestartable}
					Restart the kernel to apply - variables are cleared.
				{:else}
					Open a notebook to restart its kernel and apply it - variables are cleared.
				{/if}
			{:else if runtimePending}
				Applies when this notebook's kernel starts; until then notebook code takes its non-Databricks path.
			{:else}
				Notebook code runs its non-Databricks path.
				{#if runtimeRestartable}
					Turning it on restarts the kernel - variables are cleared.
				{:else}
					Open a notebook to turn it on - that restarts its kernel and clears variables.
				{/if}
			{/if}
			{#if runtimeEffectiveOn && runtimeVersionEnvControlled}
				The version (<code class="font-mono text-[10px]">{runtimeEffectiveVersion}</code>) is set by the
				<code class="font-mono text-[10px]">CELLAR_DATABRICKS_RUNTIME_VERSION</code> environment variable, not here.
			{/if}
		</p>
		{@render sdkDbutilsWarning()}
		<!-- The one state with something to apply: the runtime is on and the running
		     kernel does not carry it. Rendered ONLY here - anywhere else this would be a
		     restart (and a namespace wipe) nobody asked for. It reuses `applyRuntime`, so
		     it behaves exactly like the toggle's restart, minus the preference change.
		     An env-forced decision is excluded outright (no restart can change it, so the
		     button would loop forever wiping the namespace); a missing notebook path only
		     DISABLES it, because there the remedy is simply to open a notebook. -->
		{#if runtimePending && runtimeKernelStarted && !runtimeEnvControlled && !runtimeApplying}
			<button
				class="btn btn-outline btn-xs mt-1.5 w-full"
				onclick={applyPendingRuntime}
				disabled={!!busy || !runtimeApplicable}
				title={runtimeApplicable
					? "Restart this notebook's kernel so it starts with the Databricks runtime. Variables are cleared."
					: 'Open a notebook to restart its kernel.'}
				data-testid="databricks-runtime-apply"
			>
				{runtimeApplicable ? 'Apply now (restarts kernel)' : 'Apply now - open a notebook first'}
			</button>
		{/if}
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

		<!-- 3. Ready: the connection (Cluster card) + a separate Upload card + a separate
		     Runtime card + the subordinate Unity Catalog browser. Three clearly separated
		     cards, one concern each: what we are connected to, what we send to the
		     workspace, and what the kernel advertises. -->
	{:else}
		<div class="space-y-2">
			<!-- Above the Cluster card: it is a precondition of everything below it. It
			     sits outside the connection branches so ONE copy serves the connected
			     and expired cards alike, but which branches it appears over is decided
			     by `needsDefaultProfile` (connected, or expired - never lost/restarting,
			     which may be a fresh kernel whose DATABRICKS_* env was never scrubbed). -->
			{#if needsDefaultProfile && defaultProfile}
				{@render defaultProfileCard(defaultProfile)}
			{/if}
			{#if panel.view === 'connecting'}
				<!-- Connecting, with NO connected view underneath: a FIRST connect from the
				     picker, or an expected restart whose session is already gone. There is
				     nothing to hold, so the standalone card IS the progression (picker →
				     connecting → connected) rather than a collapse. Shown for a connect
				     (`busy === 'connect'`) AND for any expected kernel restart still in
				     flight (this panel's own `restarting`, or the server's grace window
				     around a restart triggered elsewhere), EXCEPT a runtime toggle:
				     that keeps the connected card with its "restarting" pill. Because
				     the transition covers the whole window, the lost/expired branches
				     below are unreachable during it: an expected restart can never be
				     mistaken for an unexpected loss. A transition latched for ANOTHER
				     notebook speaks for none of this - see `panelOwnsTransition`. -->
				<div class="rounded-lg border border-base-300 bg-base-100 p-2.5" data-testid="databricks-connecting">
					{@render cardLabel('cluster')}
					<div class="mt-1.5 flex items-center gap-2">
						<span class="loading loading-spinner loading-xs shrink-0 text-primary"></span>
						<span class="min-w-0 flex-1 truncate text-sm font-medium" title={connectingName}>
							{connectingName ? `Connecting to ${connectingName}…` : 'Reconnecting…'}
						</span>
					</div>
					{@render hint('Starting the Databricks session. A terminated cluster can take a few minutes.')}
					{#if connectError}{@render errorBox(connectError, 'databricks-connect-error')}{/if}
				</div>
			{:else if panel.view === 'connected'}
				<!-- Cluster card. Kept mounted through a runtime-toggle restart
				     (runtimeApplying) AND through a cluster SWITCH (`connectOverLive`), so
				     the panel never unmounts its cards and springs them back. The
				     transition is shown IN this card - the badge and the identity row -
				     while Upload, Runtime and the data browser stay exactly where they
				     were. -->
				<div class="rounded-lg border border-base-300 bg-base-100 p-2.5" data-testid="databricks-connected">
					<div class="flex items-center justify-between gap-2">
						{@render cardLabel('cluster')}
						{#if panel.restarting}
							<span class="flex items-center gap-1 text-[10px] uppercase tracking-wide text-base-content/40">
								<span class="loading loading-spinner loading-xs"></span>restarting
							</span>
						{:else if panel.connecting}
							<!-- The transition takes the badge's own slot, so the header does not
							     change size. Never `connected`: the new session is not up yet. -->
							<span class="flex items-center gap-1 text-[10px] uppercase tracking-wide text-base-content/40" data-testid="databricks-connecting-badge">
								<span class="loading loading-spinner loading-xs"></span>connecting
							</span>
						{:else}
							<span class="badge badge-success badge-xs shrink-0 gap-1" data-testid="databricks-connection-status">
								<span class="inline-block h-1.5 w-1.5 rounded-full bg-current"></span>connected
							</span>
						{/if}
					</div>
					<!-- Identity row. During a switch it names the cluster being connected TO -
					     that is the informative part of a wait that can run to minutes - in the
					     same one-line slot, so the row's height never changes. -->
					<div class="mt-1.5 flex items-center gap-2">
						{#if panel.connecting}
							<span class="relative flex h-2 w-2 shrink-0"><span class="inline-flex h-2 w-2 rounded-full bg-warning"></span></span>
							<span class="min-w-0 flex-1 truncate text-sm font-medium" title={connectingName} data-testid="databricks-connecting-name">
								{connectingName ? `Connecting to ${connectingName}…` : 'Reconnecting…'}
							</span>
						{:else}
							<span class="relative flex h-2 w-2 shrink-0" title="connected"><span class="inline-flex h-2 w-2 rounded-full bg-success"></span></span>
							<span class="min-w-0 flex-1 truncate text-sm font-medium" title={connection.clusterName ?? connection.lost?.clusterName ?? ''}>{connection.clusterName ?? connection.lost?.clusterName ?? ''}</span>
						{/if}
					</div>
					{#if connMeta}
						<p class="mt-1 truncate font-mono text-[11px] text-base-content/50" title={connMeta}>{connMeta}</p>
					{/if}
					<!-- One paragraph slot, two readings. `spark`/`w` are NOT ready mid-connect,
					     so claiming it would be exactly the assert-more-than-was-verified defect;
					     the wait's own sentence takes the slot instead. Kept to ONE LINE at the
					     default sidebar width, like the line it replaces, so the card does not
					     resize under a wait that can run to minutes - which is why it says only
					     how long and leaves WHAT to the identity row right above it ("Connecting
					     to <cluster>…"). The standalone first-connect card has no such
					     constraint and keeps the fuller sentence. -->
					{#if panel.connecting}
						<p class="mt-1.5 text-[11px] leading-relaxed text-base-content/50" data-testid="databricks-connecting-hint">
							A cold cluster can take a few minutes.
						</p>
					{:else}
						<p class="mt-1.5 text-[11px] leading-relaxed text-base-content/50">
							<code class="font-mono text-[10px] text-primary">spark</code> and
							<code class="font-mono text-[10px] text-primary">w</code> are ready in the kernel.
						</p>
					{/if}
					<!-- No `connectError` here: a failed switch clears the transition and
					     leaves `switching` set, so the picker below owns the one error box. -->
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

				<!-- Upload card: its own card, not a row inside the connection - it acts on
				     workspace FILES, and it carries enough of its own controls (two fields,
				     their token dropdowns, a preview and a two-step replace confirm) that
				     nested under Switch/Disconnect they read as more connection controls. -->
				{@render uploadCard()}

				<!-- Runtime card: a SEPARATE card from the connection (requirement #1). -->
				{@render runtimeCard()}

				<!-- Data browser: subordinate to the two cards above. -->
				{@render dataBrowser()}
			{:else if panel.view === 'expired'}
				<div class="rounded-lg border border-warning/30 bg-warning/10 p-2.5" data-testid="databricks-expired">
					<div class="flex items-center justify-between gap-2">
						{@render cardLabel('cluster')}
						<span class="flex items-center gap-1 text-[10px] uppercase tracking-wide text-warning">
							<span class="inline-block h-1.5 w-1.5 rounded-full bg-warning"></span>expired
						</span>
					</div>
					<!-- Never promise a background recovery Cellar cannot deliver: with an
					     expired profile sign-in every retry fails the same way, so the card
					     names the real cause (and the exact command) instead. Reconnect
					     stays - it is what the user clicks once they have re-authenticated. -->
					<p class="mt-1.5 text-[11px] leading-relaxed text-base-content/70">
						{#if connection.reauth}
							The Spark Connect session on <span class="font-mono">{connection.lost?.clusterName}</span> expired, and Cellar cannot restore it on its own.
						{:else}
							The Spark Connect session on <span class="font-mono">{connection.lost?.clusterName}</span> expired (idle timeout or a closed client). Cellar is reconnecting automatically; if it doesn't recover, use Reconnect.
						{/if}
					</p>
					{@render sessionReauthBox()}
					{@render sdkDbutilsWarning()}
					{@render reconnectButton()}
					<div class="mt-2 border-t border-warning/20 pt-2">
						{@render picker()}
						{@render logoutRow(false)}
					</div>
				</div>
			{:else if panel.view === 'lost'}
				<div class="rounded-lg border border-warning/30 bg-warning/10 p-2.5" data-testid="databricks-lost">
					<div class="flex items-center justify-between gap-2">
						{@render cardLabel('cluster')}
						<span class="flex items-center gap-1 text-[10px] uppercase tracking-wide text-warning">
							<span class="inline-block h-1.5 w-1.5 rounded-full bg-warning"></span>lost
						</span>
					</div>
					<p class="mt-1.5 text-[11px] leading-relaxed text-base-content/70">
						The session on <span class="font-mono">{connection.lost?.clusterName}</span> ended when the kernel restarted. Reconnect to restore <code class="font-mono text-[10px]">spark</code> and <code class="font-mono text-[10px]">w</code>.
					</p>
					{@render sessionReauthBox()}
					{@render sdkDbutilsWarning()}
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
					<!-- Above the picker on purpose: this is the card that offers "Sign in
					     with Databricks", and for an expired CLI-managed profile that button
					     cannot help. Say why before the user reaches for it. -->
					{@render sessionReauthBox()}
					{@render sdkDbutilsWarning()}
					<div class="mt-1.5">
						{@render picker()}
						{@render logoutRow(false)}
					</div>
				</div>
			{/if}
		</div>
	{/if}
</div>
